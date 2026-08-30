import {
  BRIDGE_TO_MAIN,
  INSTALLED_FLAG,
  MAIN_TO_BRIDGE,
  type BridgeFrame,
  type PageFrame,
} from '../shared/protocol';

/**
 * Runs in the page's MAIN world at document_start.
 *
 * Two jobs:
 *  1. Make `navigator.modelContext` exist (polyfill) so a page can register
 *     WebMCP tools even in a browser without native support.
 *  2. Mirror every registration to the extension, and invoke tool handlers on
 *     request. Handlers stay in the page — we never serialize page code.
 */

type Handler = (args: unknown) => unknown;

interface Entry {
  descriptor: Record<string, unknown>;
  execute: Handler;
  /** Tools published via provideContext() are replaced wholesale on each call. */
  fromContext: boolean;
}

const tools = new Map<string, Entry>();
let publishTimer: number | undefined;

function post(frame: PageFrame): void {
  // Same-window message: only listeners in this window can observe it, and the
  // page is the origin anyway, so '*' avoids failures on opaque origins.
  window.postMessage({ [MAIN_TO_BRIDGE]: true, ...frame }, '*');
}

/** Whichever model-context object this page actually uses, captured once at install. */
let contextHost: Record<string, unknown> | null = null;

function providerHint(): string {
  const meta = document.querySelector('meta[name="webmcp-provider"]');
  const declared = meta?.getAttribute('content')?.trim();
  if (declared) return declared;
  // Read the captured object rather than re-reading the global: on pages that keep
  // navigator.modelContext as a deprecated alias, every access logs a warning.
  const name = contextHost?.providerName;
  return typeof name === 'string' ? name : '';
}

function safeDescriptor(tool: Record<string, unknown>): Record<string, unknown> {
  const { name, description, inputSchema, input_schema: legacySchema, annotations } = tool;
  const descriptor: Record<string, unknown> = {
    name: String(name ?? ''),
    description: typeof description === 'string' ? description : '',
    inputSchema: inputSchema ?? legacySchema ?? { type: 'object', properties: {} },
  };
  if (annotations && typeof annotations === 'object') descriptor.annotations = annotations;
  return clone(descriptor);
}

function clone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function publish(requestId?: string): void {
  post({
    type: 'TOOLS',
    requestId,
    provider: providerHint(),
    title: document.title,
    tools: [...tools.values()].map((entry) => entry.descriptor),
  });
}

function schedulePublish(): void {
  if (publishTimer !== undefined) return;
  publishTimer = window.setTimeout(() => {
    publishTimer = undefined;
    publish();
  }, 30);
}

function resolveHandler(tool: Record<string, unknown>): Handler {
  const candidate =
    tool.execute ?? tool.callback ?? tool.handler ?? (tool as Record<string, unknown>).invoke;
  if (typeof candidate !== 'function') {
    return () => {
      throw new Error(`Tool "${String(tool.name)}" was registered without an execute handler`);
    };
  }
  return (candidate as Handler).bind(tool);
}

function register(tool: unknown, fromContext: boolean): { unregister: () => void } {
  if (!tool || typeof tool !== 'object') return { unregister: () => {} };
  const record = tool as Record<string, unknown>;
  const name = String(record.name ?? '').trim();
  if (!name) return { unregister: () => {} };
  tools.set(name, {
    descriptor: safeDescriptor(record),
    execute: resolveHandler(record),
    fromContext,
  });
  schedulePublish();
  return {
    unregister: () => {
      tools.delete(name);
      schedulePublish();
    },
  };
}

function provideContext(context: unknown): void {
  for (const [name, entry] of [...tools.entries()]) {
    if (entry.fromContext) tools.delete(name);
  }
  const list = (context as { tools?: unknown })?.tools;
  if (Array.isArray(list)) for (const tool of list) register(tool, true);
  schedulePublish();
}

/** Normalizes an MCP `CallToolResult` (or a plain return value) into data + text. */
function normalizeResult(raw: unknown): { value: unknown; text: string; isError: boolean } {
  if (raw == null) return { value: null, text: '', isError: false };
  if (typeof raw === 'object' && Array.isArray((raw as { content?: unknown[] }).content)) {
    const result = raw as { content: unknown[]; structuredContent?: unknown; isError?: boolean };
    const text = result.content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part && typeof part === 'object' && (part as { type?: string }).type === 'text',
      )
      .map((part) => part.text)
      .join('\n');
    let value: unknown = result.structuredContent;
    if (value === undefined) {
      try {
        value = text ? JSON.parse(text) : null;
      } catch {
        value = text;
      }
    }
    return { value: clone(value ?? null), text, isError: !!result.isError };
  }
  return {
    value: clone(raw),
    text: typeof raw === 'string' ? raw : '',
    isError: false,
  };
}

async function call(callId: string, name: string, args: unknown): Promise<void> {
  const entry = tools.get(name);
  if (!entry) {
    post({ type: 'CALL_RESULT', callId, ok: false, error: `Tool "${name}" is not registered` });
    return;
  }
  try {
    const raw = await entry.execute(args ?? {});
    const { value, text, isError } = normalizeResult(raw);
    if (isError) {
      post({ type: 'CALL_RESULT', callId, ok: false, error: text || 'Tool reported an error' });
      return;
    }
    post({ type: 'CALL_RESULT', callId, ok: true, value, text });
  } catch (error) {
    post({
      type: 'CALL_RESULT',
      callId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The WebMCP surface moved from `navigator.modelContext` to `document.modelContext`.
 * Some sites keep the old name as a deprecated alias that logs a warning on every
 * access, so `document` is checked first and `in` is used to test for existence
 * without invoking such a getter.
 */
function findExistingContext(): Record<string, unknown> | null {
  const hosts: Array<Record<string, unknown>> = [
    document as unknown as Record<string, unknown>,
    navigator as unknown as Record<string, unknown>,
  ];
  for (const host of hosts) {
    if (!('modelContext' in host)) continue;
    const candidate = host.modelContext as Record<string, unknown> | undefined;
    if (candidate && typeof candidate.registerTool === 'function') return candidate;
  }
  return null;
}

function defineContext(target: object, value: unknown): void {
  try {
    Object.defineProperty(target, 'modelContext', {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  } catch {
    (target as Record<string, unknown>).modelContext = value;
  }
}

function installPolyfill(): void {
  const existing = findExistingContext();

  if (existing && typeof existing.registerTool === 'function') {
    contextHost = existing;
    // A native implementation or another polyfill is already present: observe it
    // in place rather than replacing it, so the page keeps its own semantics.
    const originalRegister = existing.registerTool as (tool: unknown) => unknown;
    existing.registerTool = function patchedRegister(tool: unknown) {
      const handle = originalRegister.call(this, tool);
      register(tool, false);
      return handle;
    };
    if (typeof existing.provideContext === 'function') {
      const originalProvide = existing.provideContext as (context: unknown) => unknown;
      existing.provideContext = function patchedProvide(context: unknown) {
        const result = originalProvide.call(this, context);
        provideContext(context);
        return result;
      };
    }
    if (typeof existing.listTools === 'function') {
      try {
        const list = (existing.listTools as () => unknown)();
        if (Array.isArray(list)) for (const tool of list) register(tool, false);
      } catch {
        /* ignore a hostile or unimplemented listTools */
      }
    }
    return;
  }

  const impl = Object.assign(new EventTarget(), {
    registerTool: (tool: unknown) => register(tool, false),
    unregisterTool: (name: string) => {
      const removed = tools.delete(name);
      schedulePublish();
      return removed;
    },
    provideContext,
    listTools: () => [...tools.values()].map((entry) => clone(entry.descriptor)),
    callTool: async (name: string, args: unknown) => {
      const entry = tools.get(name);
      if (!entry) throw new Error(`Tool "${name}" is not registered`);
      return entry.execute(args ?? {});
    },
  });

  contextHost = impl as unknown as Record<string, unknown>;
  // Current spec location, plus the legacy alias many pages still use.
  defineContext(document, impl);
  if (!('modelContext' in navigator)) defineContext(navigator, impl);
}

function onBridgeMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data as (BridgeFrame & Record<string, unknown>) | null;
  if (!data || data[BRIDGE_TO_MAIN] !== true) return;
  if (data.type === 'REQUEST_TOOLS') publish(data.requestId);
  else if (data.type === 'CALL') void call(data.callId, data.name, data.args);
}

// Skipping when a copy is already installed is deliberate: that copy holds the
// page's real tool handlers, and the MAIN↔bridge protocol is plain window
// messages, so a freshly injected bridge talks to it fine. Replacing it would
// strip the execute functions, since listTools() returns descriptors only.
const globals = window as unknown as Record<string, unknown>;
if (!globals[INSTALLED_FLAG]) {
  globals[INSTALLED_FLAG] = true;
  window.addEventListener('message', onBridgeMessage);
  installPolyfill();
  document.addEventListener('DOMContentLoaded', () => schedulePublish());
  window.addEventListener('load', () => schedulePublish());
}
