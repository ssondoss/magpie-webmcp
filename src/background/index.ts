import {
  PANEL_PORT,
  type PanelPush,
  type PanelRequest,
  type PanelResponse,
  type PanelTask,
  type TestResult,
} from '../shared/messages';
import { planSchema, type WorkflowPlan } from '../shared/schema';
import { isTrustedPageOrigin, type PageApiRequest } from '../shared/protocol';
import type { PanelState, RunSnapshot } from '../shared/types';
import { newId, normalizeHttpUrl } from '../shared/util';
import {
  activeTabId,
  buildCapabilities,
  currentContext,
  dropTab,
  forgetSite,
  hydrate,
  liveSiteForOrigin,
  onRegistryChange,
  recordAnnouncement,
  refreshLiveTools,
  requestTabTools,
} from './registry';
import { openProvider, requirementsFromPlan } from './resolver';
import { cancelRun, resumeRun, runResult, startRun, type RunOptions } from './engine';
import { declineToReason, summarize } from './summary';
import { testWebhook } from './global-tools';
import { getKnownSites, getSettings, setSettings } from './storage';

/**
 * Service worker: the only place that owns state. The side panel is a thin view
 * that sends requests and receives pushes.
 */

function webhookHost(url: string): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

const ports = new Set<chrome.runtime.Port>();
const panelTasks = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
/** Keeps the plan + prompt for a run so a resumed run can still be summarized. */
const runContexts = new Map<string, { plan: WorkflowPlan; prompt: string }>();

let broadcastTimer: ReturnType<typeof setTimeout> | undefined;

function push(message: PanelPush): void {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
}

async function buildState(): Promise<PanelState> {
  await hydrate();
  const context = await currentContext();
  const [capabilities, settings, knownSites] = await Promise.all([
    buildCapabilities(context.tabId),
    getSettings(),
    getKnownSites(),
  ]);
  return {
    context,
    capabilities,
    knownSites: Object.values(knownSites).map((site) => ({
      origin: site.origin,
      provider: site.provider,
      toolCount: site.tools.length,
      lastSeenAt: site.lastSeenAt,
      open: Boolean(liveSiteForOrigin(site.origin)),
    })),
    settings: {
      autoOpenSites: settings.autoOpenSites,
      hasSlackWebhook: Boolean(settings.slackWebhookUrl),
      slackWebhookHost: webhookHost(settings.slackWebhookUrl),
      emailClient: settings.emailClient,
      calendarClient: settings.calendarClient,
    },
  };
}

function scheduleBroadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    void buildState().then((state) => push({ type: 'STATE', state }));
  }, 150);
}

onRegistryChange(scheduleBroadcast);

/** Runs a task that needs a DOM (Blob URLs, clipboard) inside the side panel. */
function runPanelTask(task: PanelTask): Promise<unknown> {
  if (ports.size === 0) {
    return Promise.reject(new Error('The side panel must be open to complete this step.'));
  }
  const taskId = newId('task');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      panelTasks.delete(taskId);
      reject(new Error('The side panel did not respond in time.'));
    }, 15_000);
    panelTasks.set(taskId, { resolve, reject, timer });
    push({ type: 'PANEL_TASK', taskId, task });
  });
}

function runOptions(approved: boolean, autoOpenSites: boolean): RunOptions {
  return {
    approved,
    autoOpenSites,
    runPanelTask,
    // Judgement is the driving agent's job, so this always declines — loudly,
    // and with an instruction the agent can act on.
    reason: declineToReason,
    onUpdate: (run) => push({ type: 'RUN', run }),
  };
}

async function finishRun(run: RunSnapshot, plan: WorkflowPlan): Promise<RunSnapshot> {
  if (run.status === 'blocked') {
    const blocked = run.steps.find((step) => step.status === 'blocked');
    push({
      type: 'CHAT',
      kind: 'info',
      text: `Paused before "${blocked?.label ?? 'a step'}": ${blocked?.blockedOn?.detail ?? 'a required capability is unavailable.'} Resolve it and resume.`,
    });
    return run;
  }

  const text = summarize(plan, run, runResult(run.id)?.final);
  push({ type: 'CHAT', kind: run.status === 'completed' ? 'result' : 'error', text });
  return run;
}

/**
 * The privileged surface offered to the Magpie site.
 *
 * Deliberately narrow: list capabilities, and run a plan. There is no way to read
 * the Slack webhook or any other setting, and a write still requires the
 * `approved` flag the user ticked. The origin gate lives in the message listener,
 * where `sender.origin` is set by the browser rather than claimed by the page.
 */
async function handlePageRequest(request: PageApiRequest): Promise<unknown> {
  await hydrate();

  switch (request.kind) {
    case 'PING':
      return { ready: true, version: chrome.runtime.getManifest().version };

    case 'CAPABILITIES': {
      const capabilities = await buildCapabilities(await activeTabId());
      return {
        capabilities: capabilities.map((capability) => ({
          id: capability.id,
          label: capability.label,
          provider: capability.provider,
          origin: capability.origin,
          status: capability.status,
          risk: capability.risk,
          description: capability.description,
        })),
      };
    }

    // Opening and forgetting are how the site manages the registry the panel
    // also shows. Neither reads a setting or runs anything.
    case 'OPEN_SITE': {
      await openProvider(String(request.origin));
      return { opened: true };
    }

    case 'FORGET_SITE': {
      await forgetSite(String(request.origin));
      scheduleBroadcast();
      return { forgotten: true };
    }

    case 'RUN': {
      const parsed = planSchema.safeParse(request.plan);
      if (!parsed.success) throw new Error('That is not a valid workflow plan.');
      const settings = await getSettings();
      const run = await startRun(
        { plan: parsed.data, prompt: String(request.prompt) },
        runOptions(request.approved === true, settings.autoOpenSites),
      );
      runContexts.set(run.id, { plan: parsed.data, prompt: String(request.prompt) });
      const final = runResult(run.id)?.final;
      return {
        run,
        answer: summarize(parsed.data, run, final),
      };
    }

    default:
      throw new Error(`Unknown request: ${(request as { kind: string }).kind}`);
  }
}

async function handleRequest(request: PanelRequest): Promise<unknown> {
  await hydrate();

  switch (request.type) {
    case 'GET_STATE':
      return buildState();

    case 'REFRESH':
      await refreshLiveTools();
      return buildState();

    case 'SET_SETTINGS': {
      await setSettings(request.settings);
      scheduleBroadcast();
      return buildState();
    }

    case 'TEST_WEBHOOK': {
      const candidate = normalizeHttpUrl(request.url ?? '');
      const url = candidate || (await getSettings()).slackWebhookUrl;
      return testWebhook(url) satisfies Promise<TestResult>;
    }

    case 'RUN_PLAN': {
      const settings = await getSettings();
      const run = await startRun(
        { plan: request.plan, prompt: request.prompt },
        runOptions(request.approved === true, settings.autoOpenSites),
      );
      runContexts.set(run.id, { plan: request.plan, prompt: request.prompt });
      return finishRun(run, request.plan);
    }

    case 'RESUME_RUN': {
      const context = runContexts.get(request.runId);
      if (!context) throw new Error('That run expired. Generate or run the workflow again.');
      const settings = await getSettings();
      const run = await resumeRun(request.runId, runOptions(request.approved === true, settings.autoOpenSites));
      return finishRun(run, context.plan);
    }

    case 'CANCEL_RUN':
      cancelRun(request.runId);
      return { cancelled: true };

    case 'RESOLVE_PLAN':
      return requirementsFromPlan(request.plan);

    case 'OPEN_PROVIDER': {
      await openProvider(request.origin, true);
      return { opened: request.origin };
    }

    case 'FORGET_SITE': {
      await forgetSite(request.origin);
      scheduleBroadcast();
      return { forgotten: request.origin };
    }

    case 'PANEL_TASK_RESULT': {
      const pending = panelTasks.get(request.taskId);
      if (pending) {
        clearTimeout(pending.timer);
        panelTasks.delete(request.taskId);
        if (request.ok) pending.resolve(request.value);
        else pending.reject(new Error(request.error ?? 'The side panel task failed.'));
      }
      return { ack: true };
    }

    default:
      throw new Error(`Unknown request: ${(request as { type: string }).type}`);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const envelope = message as { type?: string; payload?: unknown; request?: unknown };

  if (envelope?.type === 'TOOLS_UPDATED') {
    const tabId = sender.tab?.id;
    const payload = envelope.payload as Parameters<typeof recordAnnouncement>[1] | undefined;
    if (typeof tabId !== 'number' || !payload || !Array.isArray(payload.tools)) return undefined;
    void recordAnnouncement(tabId, payload);
    return undefined;
  }

  if (envelope?.type === 'PAGE_API') {
    // Authoritative origin check: sender.origin is set by the browser, so a page
    // cannot claim to be the Magpie site. The content script checks too, but this
    // is the gate that matters.
    if (!isTrustedPageOrigin(sender.origin)) {
      sendResponse({ ok: false, error: 'This origin is not allowed to use Magpie.' });
      return true;
    }
    void handlePageRequest(envelope.request as PageApiRequest)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    return true;
  }

  if (!envelope?.type) return undefined;

  void handleRequest(message as PanelRequest)
    .then((data) => sendResponse({ ok: true, data } satisfies PanelResponse))
    .catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PanelResponse),
    );
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  void buildState().then((state) => port.postMessage({ type: 'STATE', state } satisfies PanelPush));
  void refreshLiveTools();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void dropTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigating tab has no tools until its bridge announces again. Asking again
  // on 'complete' means the registry recovers even if no announcement arrives
  // (same-document navigations, or a bridge that loaded before the worker woke).
  if (changeInfo.status === 'loading') void dropTab(tabId);
  else if (changeInfo.status === 'complete') void requestTabTools(tabId);
});

chrome.tabs.onActivated.addListener(() => scheduleBroadcast());
chrome.windows.onFocusChanged.addListener(() => scheduleBroadcast());

/**
 * Chrome only injects declared content scripts into tabs opened *after* install,
 * so a tab that was already open would silently expose no capabilities until it
 * was reloaded. Inject into those tabs directly instead.
 */
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== 'number') return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-main.js'],
          world: 'MAIN',
          injectImmediately: true,
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-bridge.js'],
          world: 'ISOLATED',
          injectImmediately: true,
        });
      } catch {
        /* restricted page (chrome://, the web store, a PDF viewer) */
      }
    }),
  );
  await refreshLiveTools();
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void injectIntoOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void injectIntoOpenTabs();
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
void hydrate().then(() => refreshLiveTools());
