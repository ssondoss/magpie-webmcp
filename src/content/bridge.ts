import {
  BRIDGE_TO_MAIN,
  EXTENSION_TO_PAGE,
  INSTALLED_FLAG,
  MAIN_TO_BRIDGE,
  PAGE_TO_EXTENSION,
  TOOL_CALL_TIMEOUT_MS,
  TOOL_LIST_TIMEOUT_MS,
  STALE_CONNECTION,
  isTrustedPageOrigin,
  type PageApiFrame,
  type PageApiReply,
  type PageFrame,
} from '../shared/protocol';

/**
 * ISOLATED-world relay. The MAIN-world script owns the page's WebMCP surface;
 * this file is the only thing that can talk to the service worker.
 */

interface PendingCall {
  resolve: (value: { ok: boolean; value?: unknown; text?: string; error?: string }) => void;
  timer: number;
}

interface PendingList {
  resolve: (value: { provider: string; title: string; tools: unknown[] }) => void;
  timer: number;
}

const pendingCalls = new Map<string, PendingCall>();
const pendingLists = new Map<string, PendingList>();
let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

function toMain(frame: Record<string, unknown>): void {
  window.postMessage({ [BRIDGE_TO_MAIN]: true, ...frame }, '*');
}

/**
 * After the extension is reloaded, scripts still running in old pages are
 * orphaned: `chrome.runtime` calls throw "Extension context invalidated"
 * *synchronously*, so a trailing .catch() never sees them.
 */
function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function announce(payload: { provider: string; title: string; tools: unknown[] }): void {
  if (!extensionAlive()) return;
  try {
    const sent = chrome.runtime.sendMessage({
      type: 'TOOLS_UPDATED',
      payload: {
        origin: location.origin,
        url: location.href,
        title: document.title || payload.title,
        provider: payload.provider,
        tools: payload.tools,
      },
    });
    void sent?.catch?.(() => {
      /* service worker asleep or shutting down */
    });
  } catch {
    /* orphaned by an extension reload; a freshly injected bridge takes over */
  }
}

/**
 * Relays a privileged request from the Magpie site to the service worker.
 *
 * The origin is checked here so an untrusted page's messages are dropped without
 * a round trip — but this is only the first gate. The worker re-checks using
 * `sender.origin`, which the browser sets and a page cannot forge.
 */
function onPageApiMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data as (PageApiFrame & Record<string, unknown>) | null;
  if (!data || data[PAGE_TO_EXTENSION] !== true) return;
  if (!isTrustedPageOrigin(location.origin)) return;
  if (!data.requestId || !data.request) return;

  const reply = (payload: Omit<PageApiReply, 'requestId'>): void => {
    window.postMessage({ [EXTENSION_TO_PAGE]: true, requestId: data.requestId, ...payload }, location.origin);
  };

  if (!extensionAlive()) {
    // The extension was reloaded after this page loaded, so this script is
    // orphaned. Only a page refresh gets a live one.
    reply({ ok: false, error: STALE_CONNECTION });
    return;
  }

  try {
    chrome.runtime.sendMessage({ type: 'PAGE_API', request: data.request }, (response: PageApiReply | undefined) => {
      if (chrome.runtime.lastError || !response) {
        reply({ ok: false, error: chrome.runtime.lastError?.message ?? 'No response from Magpie.' });
        return;
      }
      reply({ ok: response.ok, data: response.data, error: response.error });
    });
  } catch {
    reply({ ok: false, error: STALE_CONNECTION });
  }
}

function onPageMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data as (PageFrame & Record<string, unknown>) | null;
  if (!data || data[MAIN_TO_BRIDGE] !== true) return;

  if (data.type === 'TOOLS') {
    const payload = {
      provider: typeof data.provider === 'string' ? data.provider : '',
      title: typeof data.title === 'string' ? data.title : '',
      tools: Array.isArray(data.tools) ? data.tools : [],
    };
    if (data.requestId) {
      const pending = pendingLists.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingLists.delete(data.requestId);
        pending.resolve(payload);
      }
    }
    announce(payload);
    return;
  }

  if (data.type === 'CALL_RESULT') {
    const pending = pendingCalls.get(data.callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCalls.delete(data.callId);
    pending.resolve({ ok: data.ok, value: data.value, text: data.text, error: data.error });
  }
}

function callTool(name: string, args: unknown) {
  return new Promise<{ ok: boolean; value?: unknown; text?: string; error?: string }>((resolve) => {
    const callId = nextId('call');
    const timer = window.setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({ ok: false, error: `Tool "${name}" timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s` });
    }, TOOL_CALL_TIMEOUT_MS);
    pendingCalls.set(callId, { resolve, timer });
    toMain({ type: 'CALL', callId, name, args });
  });
}

function listTools() {
  return new Promise<{ provider: string; title: string; tools: unknown[] }>((resolve) => {
    const requestId = nextId('list');
    const timer = window.setTimeout(() => {
      pendingLists.delete(requestId);
      resolve({ provider: '', title: document.title, tools: [] });
    }, TOOL_LIST_TIMEOUT_MS);
    pendingLists.set(requestId, { resolve, timer });
    toMain({ type: 'REQUEST_TOOLS', requestId });
  });
}

function onWorkerMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean | undefined {
  // A tool call can outlive the extension context that requested it, so replying
  // is best-effort: the worker either restarted or is gone.
  const respond = (value: unknown): void => {
    try {
      sendResponse(value);
    } catch {
      /* the caller went away while the tool was running */
    }
  };

  const request = message as { type?: string; name?: string; args?: unknown };
  if (request?.type === 'CS_CALL_TOOL') {
    void callTool(String(request.name), request.args).then(respond);
    return true;
  }
  if (request?.type === 'CS_GET_TOOLS') {
    void listTools().then((payload) =>
      respond({ ...payload, origin: location.origin, url: location.href, title: document.title }),
    );
    return true;
  }
  return undefined;
}

/**
 * Unlike the MAIN-world script, this one cannot simply skip when a previous copy
 * exists: after an extension reload the old copy is orphaned and can no longer
 * reach the service worker. So the newly injected copy tears the old one down and
 * takes over. `dispose()` touches no `chrome.*` API, so it works even when the old
 * context is already invalid.
 */
interface BridgeRegistration {
  dispose(): void;
}

const globals = window as unknown as Record<string, unknown>;
const previous = globals[INSTALLED_FLAG] as BridgeRegistration | undefined;
if (typeof previous?.dispose === 'function') previous.dispose();

// This script can itself be injected into a page while the extension is being
// reloaded, in which case there is nothing to attach to. The next injection wins.
if (extensionAlive()) {
  try {
    window.addEventListener('message', onPageMessage);
    window.addEventListener('message', onPageApiMessage);
    chrome.runtime.onMessage.addListener(onWorkerMessage);
    globals[INSTALLED_FLAG] = {
      dispose() {
        window.removeEventListener('message', onPageMessage);
        window.removeEventListener('message', onPageApiMessage);
        try {
          chrome.runtime.onMessage.removeListener(onWorkerMessage);
        } catch {
          /* context already invalidated — the listener died with it */
        }
      },
    } satisfies BridgeRegistration;

    // The service worker may have restarted after this page loaded; re-announce.
    void listTools().then(announce);
  } catch {
    window.removeEventListener('message', onPageMessage);
    window.removeEventListener('message', onPageApiMessage);
    delete globals[INSTALLED_FLAG];
  }
}
