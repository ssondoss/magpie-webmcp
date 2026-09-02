import {
  EXTENSION_TO_PAGE,
  PAGE_API_TIMEOUT_MS,
  PAGE_TO_EXTENSION,
  STALE_CONNECTION,
  type PageApiReply,
  type PageApiRequest,
} from '../../src/shared/protocol';
import type { WorkflowPlan, WorkflowStep } from '../../src/shared/schema';
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
    durationMs?: number;
    /**
     * `type` and `tool` are set on every snapshot before execution begins, so a
     * run can be recorded from this payload alone — the original plan is not
     * needed, which is what lets a run nobody here initiated still be stored.
     */
    steps: Array<{
      id: string;
      label: string;
      type?: WorkflowStep['type'];
      tool?: string;
      status: string;
      preview?: string;
      error?: string;
    }>;
    /** Field names and sample rows, carried into the next turn's context. */
    resultShape?: ResultShape;
  };
  answer: string;
}

const pending = new Map<string, (reply: PageApiReply) => void>();
let counter = 0;
let listening = false;

/** Prompts of RUN frames seen on the bridge, keyed by request id. */
const bridgeRuns = new Map<string, string>();

type BridgeRunObserver = (run: ExtensionRun, prompt: string) => void;
let observeBridgeRun: BridgeRunObserver | null = null;

/**
 * Registers a handler for a plan that ran on the bridge without going through
 * this module — an agent posting to the page API itself rather than calling
 * `run_steps`.
 *
 * The extension executes such a plan and returns a run id, but nothing writes it
 * to the library, so real work disappears from the history. Recording it here
 * makes persistence a property of the bridge rather than of how an agent happened
 * to be asked, which matters because we do not control the prompt.
 */
export function onUnrecordedRun(callback: BridgeRunObserver): void {
  observeBridgeRun = callback;
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as (PageApiReply & Record<string, unknown>) | null;
    if (!data) return;

    // `postMessage` dispatches to listeners on the same window, so outgoing frames
    // arrive here too — including ones this module did not send. That is what makes
    // a reply attributable later, whoever asked for it.
    if (data[PAGE_TO_EXTENSION] === true) {
      const request = (data as { request?: PageApiRequest }).request;
      if (request?.kind === 'RUN') {
        // Bounded, so a page posting in a loop cannot grow this without limit.
        if (bridgeRuns.size > 50) bridgeRuns.clear();
        bridgeRuns.set(String(data.requestId), String(request.prompt ?? ''));
      }
      return;
    }

    if (data[EXTENSION_TO_PAGE] !== true) return;

    const requestId = String(data.requestId);
    const prompt = bridgeRuns.get(requestId);
    bridgeRuns.delete(requestId);

    const resolve = pending.get(requestId);
    if (resolve) {
      pending.delete(requestId);
      resolve(data);
      return;
    }

    // Unclaimed: `executeSteps` is not going to record this one, so we do.
    if (prompt !== undefined && data.ok && observeBridgeRun) {
      observeBridgeRun(data.data as ExtensionRun, prompt);
    }
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
