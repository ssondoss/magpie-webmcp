import {
  EXTENSION_TO_PAGE,
  PAGE_API_TIMEOUT_MS,
  PAGE_TO_EXTENSION,
  STALE_CONNECTION,
  type PageApiReply,
  type PageApiRequest,
} from '../../src/shared/protocol';
import type { WorkflowPlan } from '../../src/shared/schema';
import type { ResultShape } from '../../src/shared/util';

/**
 * Client for the Magpie extension, if it is installed in this browser.
 *
 * The site works fully without it — this only adds what a page cannot do for
 * itself: capabilities from *other* origins, and the ability to call them there.
 * Every call is best-effort and the UI hides these features when there is no
 * answer, so a visitor without the extension never sees a broken control.
 */

export interface ExtensionCapability {
  id: string;
  label: string;
  provider: string;
  origin?: string;
  status: string;
  risk: string;
  description: string;
}

export interface ExtensionRun {
  run: {
    id: string;
    status: string;
    steps: Array<{ id: string; label: string; status: string; preview?: string; error?: string }>;
    /** Field names and sample rows, carried into the next turn's context. */
    resultShape?: ResultShape;
  };
  answer: string;
}

const pending = new Map<string, (reply: PageApiReply) => void>();
let counter = 0;
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as (PageApiReply & Record<string, unknown>) | null;
    if (!data || data[EXTENSION_TO_PAGE] !== true) return;
    const resolve = pending.get(data.requestId);
    if (!resolve) return;
    pending.delete(data.requestId);
    resolve(data);
  });
}

function send<T>(request: PageApiRequest, timeoutMs = PAGE_API_TIMEOUT_MS): Promise<T> {
  listen();
  counter += 1;
  const requestId = `page${counter}_${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('The Magpie extension did not respond.'));
    }, timeoutMs);

    pending.set(requestId, (reply) => {
      window.clearTimeout(timer);
      if (reply.ok) resolve(reply.data as T);
      else reject(new Error(reply.error ?? 'The Magpie extension refused the request.'));
    });

    window.postMessage({ [PAGE_TO_EXTENSION]: true, requestId, request }, window.location.origin);
  });
}

/** True when the failure is a stale content script, which a page refresh fixes. */
export function isStaleConnection(error: unknown): boolean {
  return error instanceof Error && error.message === STALE_CONNECTION;
}

/**
 * Resolves an absent extension rather than throwing — absence is the normal case.
 *
 * Retried once: the service worker may be asleep when the page loads, and waking
 * it can take longer than the first ping allows.
 */
export async function detectExtension(): Promise<boolean> {
  for (const timeout of [1_500, 3_000]) {
    try {
      await send<{ ready: boolean }>({ kind: 'PING' }, timeout);
      return true;
    } catch {
      /* try once more, then give up quietly */
    }
  }
  return false;
}

/**
 * Reading the registry is a local lookup in the service worker, so it gets a
 * short deadline of its own. The default is sized for PLAN and RUN, which wait
 * on a model or on tabs opening — spending that on a lookup means a missing
 * extension costs minutes instead of a moment.
 */
const REGISTRY_TIMEOUT_MS = 5_000;

export function listExtensionCapabilities(): Promise<{ capabilities: ExtensionCapability[] }> {
  return send({ kind: 'CAPABILITIES' }, REGISTRY_TIMEOUT_MS);
}

/** Focuses the site's tab if it is open, and opens it otherwise. */
export function openSite(origin: string): Promise<{ opened: boolean }> {
  return send({ kind: 'OPEN_SITE', origin }, 5_000);
}

/** Drops a remembered site and everything Magpie knew it could do. */
export function forgetSite(origin: string): Promise<{ forgotten: boolean }> {
  return send({ kind: 'FORGET_SITE', origin }, 5_000);
}

export function runWithExtension(plan: WorkflowPlan, prompt: string, approved: boolean): Promise<ExtensionRun> {
  return send({ kind: 'RUN', plan, prompt, approved });
}
