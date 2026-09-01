import {
  candidateProviderKey,
  capabilityId,
  capabilityLabel,
  inferRisk,
  normalizeDescriptor,
  providerDisplayName,
  schemaHash,
} from '../shared/capability';
import type {
  Capability,
  KnownSite,
  LiveSite,
  PageContext,
  ToolDescriptor,
} from '../shared/types';
import { globalCapabilities } from './global-tools';
import {
  deleteKnownSite,
  getKnownSites,
  getSettings,
  getProviderKeys,
  putKnownSite,
  readSession,
  setProviderKey,
  writeSession,
} from './storage';

const LIVE_SESSION_KEY = 'liveSites';

/**
 * The unified capability registry.
 *
 * Live page tools, remembered site tools and extension tools are all projected
 * into a single `Capability[]`, each with a namespaced id and a status. Everything
 * downstream (resolver, engine, UI, and the tools the site exposes) sees only that projection.
 */

const live = new Map<number, LiveSite>();
const changeListeners = new Set<() => void>();

type Waiter = {
  origin: string;
  toolName?: string;
  resolve: (site: LiveSite) => void;
  timer: ReturnType<typeof setTimeout>;
};
const waiters = new Set<Waiter>();

let hydrated: Promise<void> | undefined;

export function onRegistryChange(listener: () => void): void {
  changeListeners.add(listener);
}

function emitChange(): void {
  for (const listener of changeListeners) listener();
}

/** Service workers get evicted often, so the live snapshot lives in session storage. */
export async function hydrate(): Promise<void> {
  if (!hydrated) {
    hydrated = (async () => {
      const stored = await readSession<Record<string, LiveSite>>(LIVE_SESSION_KEY, {});
      for (const site of Object.values(stored)) {
        if (typeof site?.tabId === 'number') live.set(site.tabId, site);
      }
    })();
  }
  return hydrated;
}

async function persistLive(): Promise<void> {
  const snapshot: Record<string, LiveSite> = {};
  for (const [tabId, site] of live) snapshot[String(tabId)] = site;
  await writeSession(LIVE_SESSION_KEY, snapshot);
}

async function ensureProviderKey(origin: string, providerName: string): Promise<string> {
  const keys = await getProviderKeys();
  const existing = keys[origin];
  const hasName = !!providerName.trim();
  // Keep the assigned namespace stable unless we can upgrade a hostname-derived
  // key to the provider's real declared name.
  if (existing && (existing.from === 'name' || !hasName)) return existing.key;

  const taken = new Set(
    Object.entries(keys)
      .filter(([key]) => key !== origin)
      .map(([, record]) => record.key),
  );
  const base = candidateProviderKey(origin, hasName ? providerName : undefined);
  let key = base;
  let suffix = 2;
  while (taken.has(key)) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  await setProviderKey(origin, { key, from: hasName ? 'name' : 'host' });
  return key;
}

export async function getProviderKey(origin: string): Promise<string | undefined> {
  const keys = await getProviderKeys();
  return keys[origin]?.key;
}

export interface Announcement {
  origin: string;
  url: string;
  title: string;
  provider: string;
  tools: unknown[];
}

/** Handles a `TOOLS_UPDATED` announcement from a tab's content bridge. */
export async function recordAnnouncement(tabId: number, announcement: Announcement): Promise<void> {
  await hydrate();
  const tools = announcement.tools
    .map(normalizeDescriptor)
    .filter((tool): tool is ToolDescriptor => tool !== null);

  const knownSites = await getKnownSites();
  const isKnown = Boolean(knownSites[announcement.origin]);

  // Ignore ordinary websites entirely: only pages that expose WebMCP tools (or a
  // remembered provider that has temporarily stopped exposing them) are tracked.
  if (tools.length === 0 && !isKnown) {
    if (live.delete(tabId)) {
      await persistLive();
      emitChange();
    }
    return;
  }

  const providerKey = await ensureProviderKey(announcement.origin, announcement.provider);
  const provider = providerDisplayName(announcement.origin, announcement.provider);
  const site: LiveSite = {
    tabId,
    origin: announcement.origin,
    url: announcement.url,
    title: announcement.title,
    providerName: provider,
    tools,
    updatedAt: Date.now(),
  };
  live.set(tabId, site);
  await persistLive();

  if (tools.length > 0) {
    const previous = (await getKnownSites())[announcement.origin];
    const toolUrls = mergeToolUrls(previous?.toolUrls, tools, announcement.url);

    const remembered: KnownSite = {
      origin: announcement.origin,
      provider,
      providerKey,
      title: announcement.title,
      url: announcement.url,
      tools,
      lastSeenAt: Date.now(),
      toolUrls,
    };
    await putKnownSite(remembered);
  }

  for (const waiter of [...waiters]) {
    if (waiter.origin !== announcement.origin) continue;
    if (waiter.toolName && !tools.some((tool) => tool.name === waiter.toolName)) continue;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(site);
  }

  emitChange();
}

export async function dropTab(tabId: number): Promise<void> {
  await hydrate();
  if (live.delete(tabId)) {
    await persistLive();
    emitChange();
  }
}

export async function forgetSite(origin: string): Promise<void> {
  await deleteKnownSite(origin);
  for (const [tabId, site] of [...live]) {
    if (site.origin === origin) live.delete(tabId);
  }
  await persistLive();
  emitChange();
}

/** Asks one tab's bridge to re-report its WebMCP tools. */
export async function requestTabTools(tabId: number, fallback?: chrome.tabs.Tab): Promise<void> {
  await hydrate();
  try {
    const response = (await chrome.tabs.sendMessage(tabId, { type: 'CS_GET_TOOLS' })) as
      | (Announcement & { tools: unknown[] })
      | undefined;
    if (!response) return;
    await recordAnnouncement(tabId, {
      origin: response.origin ?? '',
      url: response.url ?? fallback?.url ?? '',
      title: response.title ?? fallback?.title ?? '',
      provider: response.provider ?? '',
      tools: response.tools ?? [],
    });
  } catch {
    /* no content script in this tab (chrome:// page, PDF viewer, …) */
  }
}

/** Re-asks every open tab for its tools; used on service-worker startup. */
export async function refreshLiveTools(): Promise<void> {
  await hydrate();
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const openTabIds = new Set(tabs.map((tab) => tab.id).filter((id): id is number => typeof id === 'number'));
  for (const tabId of [...live.keys()]) {
    if (!openTabIds.has(tabId)) live.delete(tabId);
  }
  await Promise.all(
    tabs.map((tab) => (typeof tab.id === 'number' ? requestTabTools(tab.id, tab) : Promise.resolve())),
  );
  await persistLive();
  emitChange();
}

export function liveSites(): LiveSite[] {
  return [...live.values()];
}

export function liveSiteForOrigin(origin: string, preferTabId?: number): LiveSite | undefined {
  const matches = [...live.values()].filter((site) => site.origin === origin);
  if (matches.length === 0) return undefined;
  const preferred = matches.find((site) => site.tabId === preferTabId);
  if (preferred) return preferred;
  const withTools = matches.filter((site) => site.tools.length > 0);
  const pool = withTools.length > 0 ? withTools : matches;
  return pool.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/**
 * Records where each tool was last seen, merging rather than replacing.
 *
 * An origin that serves several apps on different paths announces a different tool
 * set from each one. Replacing would forget where the others live the moment you
 * navigate away, which is precisely when the memory is needed.
 */
export function mergeToolUrls(
  previous: Record<string, string> | undefined,
  tools: ToolDescriptor[],
  url: string,
): Record<string, string> {
  const merged = { ...previous };
  for (const tool of tools) merged[tool.name] = url;
  return merged;
}

function toCapability(
  site: { origin: string; provider: string; providerKey: string; lastSeenAt: number; tabId?: number },
  tool: ToolDescriptor,
  status: Capability['status'],
  statusDetail?: string,
): Capability {
  return {
    id: capabilityId(site.providerKey, tool.name),
    name: tool.name,
    label: capabilityLabel(tool),
    description: tool.description,
    provider: site.provider,
    providerKey: site.providerKey,
    origin: site.origin,
    inputSchema: tool.inputSchema,
    source: 'webmcp',
    status,
    risk: inferRisk(tool),
    tabId: site.tabId,
    lastSeenAt: site.lastSeenAt,
    schemaHash: schemaHash(tool.inputSchema),
    statusDetail,
  };
}

/**
 * Projects remembered sites + live tabs + extension tools into one list.
 * A remembered site that is closed still yields capabilities (SITE_CLOSED) — the
 * agent may compose against them, and the resolver reopens the site before execution.
 */
export async function buildCapabilities(activeTabId?: number): Promise<Capability[]> {
  await hydrate();
  const knownSites = await getKnownSites();
  const capabilities: Capability[] = [];

  for (const known of Object.values(knownSites)) {
    const liveSite = liveSiteForOrigin(known.origin, activeTabId);
    const base = {
      origin: known.origin,
      provider: liveSite?.providerName ?? known.provider,
      providerKey: known.providerKey,
      lastSeenAt: liveSite?.updatedAt ?? known.lastSeenAt,
      tabId: liveSite?.tabId,
    };

    if (!liveSite) {
      for (const tool of known.tools) {
        capabilities.push(toCapability(base, tool, 'SITE_CLOSED', `${known.provider} is not open`));
      }
      continue;
    }

    if (liveSite.tools.length === 0) {
      for (const tool of known.tools) {
        capabilities.push(
          toCapability(
            base,
            tool,
            'AUTH_REQUIRED',
            `${base.provider} is open but exposes no capabilities — you may need to sign in`,
          ),
        );
      }
      continue;
    }

    for (const tool of liveSite.tools) capabilities.push(toCapability(base, tool, 'AVAILABLE'));
  }

  // A tab can expose tools before it is remembered (first announcement in flight).
  for (const site of live.values()) {
    if (knownSites[site.origin]) continue;
    const providerKey = (await getProviderKey(site.origin)) ?? candidateProviderKey(site.origin, site.providerName);
    for (const tool of site.tools) {
      capabilities.push(
        toCapability(
          {
            origin: site.origin,
            provider: site.providerName,
            providerKey,
            lastSeenAt: site.updatedAt,
            tabId: site.tabId,
          },
          tool,
          'AVAILABLE',
        ),
      );
    }
  }

  capabilities.push(...globalCapabilities(await getSettings()));

  const activeOrigin = activeTabId !== undefined ? live.get(activeTabId)?.origin : undefined;
  const rank = (capability: Capability): number => {
    if (capability.source === 'extension') return 3;
    if (activeOrigin && capability.origin === activeOrigin) return 0;
    return capability.status === 'AVAILABLE' ? 1 : 2;
  };
  return capabilities.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export async function findCapability(id: string, activeTabId?: number): Promise<Capability | undefined> {
  const capabilities = await buildCapabilities(activeTabId);
  return capabilities.find((capability) => capability.id === id);
}

export async function currentContext(): Promise<PageContext> {
  await hydrate();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || typeof tab.id !== 'number') return { toolCount: 0, webmcp: false };
  const site = live.get(tab.id);
  let origin = site?.origin;
  if (!origin && tab.url) {
    try {
      origin = new URL(tab.url).origin;
    } catch {
      origin = undefined;
    }
  }
  const providerKey = origin ? await getProviderKey(origin) : undefined;
  return {
    tabId: tab.id,
    url: tab.url,
    origin,
    title: tab.title,
    provider: site?.providerName ?? (origin ? providerDisplayName(origin) : undefined),
    providerKey,
    toolCount: site?.tools.length ?? 0,
    webmcp: (site?.tools.length ?? 0) > 0,
  };
}

export async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return typeof tab?.id === 'number' ? tab.id : undefined;
}

/** Resolves once `origin` exposes `toolName` (or any tool when omitted). */
export function waitForSite(origin: string, toolName: string | undefined, timeoutMs: number): Promise<LiveSite | null> {
  const existing = liveSiteForOrigin(origin);
  if (existing && (!toolName || existing.tools.some((tool) => tool.name === toolName))) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const waiter: Waiter = {
      origin,
      toolName,
      resolve: (site) => resolve(site),
      timer: setTimeout(() => {
        waiters.delete(waiter);
        resolve(null);
      }, timeoutMs),
    };
    waiters.add(waiter);
  });
}

export interface ToolCallOutcome {
  ok: boolean;
  value?: unknown;
  text?: string;
  error?: string;
}

/** Invokes a live WebMCP tool inside its own tab. */
export async function callPageTool(
  tabId: number,
  name: string,
  args: unknown,
): Promise<ToolCallOutcome> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'CS_CALL_TOOL',
      name,
      args,
    })) as ToolCallOutcome | undefined;
    if (!response) return { ok: false, error: 'No response from the page bridge' };
    return response;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not reach the page bridge',
    };
  }
}
