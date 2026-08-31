/**
 * Wire protocol between the MAIN-world WebMCP bridge and the ISOLATED-world
 * content script. Both directions travel over `window.postMessage`, so every
 * frame is tagged and validated before use.
 */
export const MAIN_TO_BRIDGE = '__wwaFromPage';
export const BRIDGE_TO_MAIN = '__wwaToPage';

/** Guards against double-installation when a script is also injected programmatically. */
export const INSTALLED_FLAG = '__wwaInstalled';

/**
 * A second, separate channel: the Magpie site asking the extension to plan and run
 * cross-site workflows on its behalf.
 *
 * This is a privileged capability — it uses the user's API key, their logged-in
 * sessions and their configured webhooks — so it is restricted to origins we
 * control. Exact match only: a prefix test would accept
 * `https://magpie.vercel.app.evil.com`.
 */
export const PAGE_TO_EXTENSION = '__magpieToExtension';
export const EXTENSION_TO_PAGE = '__magpieFromExtension';

export const TRUSTED_PAGE_ORIGINS = [
  'http://localhost:4173',
  'https://magpie-webmcp.vercel.app',
];

export function isTrustedPageOrigin(origin: string | undefined): boolean {
  return typeof origin === 'string' && TRUSTED_PAGE_ORIGINS.includes(origin);
}

export type PageApiRequest =
  | { kind: 'PING' }
  | { kind: 'CAPABILITIES' }
  | { kind: 'RUN'; plan: unknown; prompt: string; approved: boolean }
  | { kind: 'OPEN_SITE'; origin: string }
  | { kind: 'FORGET_SITE'; origin: string };

export interface PageApiFrame {
  requestId: string;
  request: PageApiRequest;
}

export interface PageApiReply {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export const PAGE_API_TIMEOUT_MS = 120_000;

/**
 * Sent when the page's content script has been orphaned by an extension reload.
 * The page checks for this exact text to offer a refresh rather than showing a
 * dead-end error.
 */
export const STALE_CONNECTION = 'Magpie was reloaded. Refresh this page to reconnect.';

export interface PageToolsFrame {
  type: 'TOOLS';
  requestId?: string;
  provider: string;
  title: string;
  tools: unknown[];
}

export interface PageCallResultFrame {
  type: 'CALL_RESULT';
  callId: string;
  ok: boolean;
  value?: unknown;
  text?: string;
  error?: string;
}

export type PageFrame = PageToolsFrame | PageCallResultFrame;

export interface BridgeRequestToolsFrame {
  type: 'REQUEST_TOOLS';
  requestId: string;
}

export interface BridgeCallFrame {
  type: 'CALL';
  callId: string;
  name: string;
  args: unknown;
}

export type BridgeFrame = BridgeRequestToolsFrame | BridgeCallFrame;

export const TOOL_CALL_TIMEOUT_MS = 60_000;
export const TOOL_LIST_TIMEOUT_MS = 2_000;
