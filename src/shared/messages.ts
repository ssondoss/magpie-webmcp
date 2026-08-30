import type { WorkflowPlan } from './schema';
import type { Capability, PanelState, RunSnapshot, Settings } from './types';

export const PANEL_PORT = 'wwa-panel';

export type PanelRequest =
  | { type: 'GET_STATE' }
  | { type: 'REFRESH' }
  | { type: 'SET_SETTINGS'; settings: Partial<Settings> }
  | { type: 'TEST_WEBHOOK'; url?: string }
  /** `approved` is the user's explicit consent for steps that write to a site. */
  | { type: 'RUN_PLAN'; plan: WorkflowPlan; prompt: string; approved?: boolean }
  | { type: 'RESUME_RUN'; runId: string; approved?: boolean }
  | { type: 'CANCEL_RUN'; runId: string }
  | { type: 'RESOLVE_PLAN'; plan: WorkflowPlan }
  | { type: 'OPEN_PROVIDER'; origin: string }
  | { type: 'FORGET_SITE'; origin: string }
  | { type: 'PANEL_TASK_RESULT'; taskId: string; ok: boolean; value?: unknown; error?: string };

export type PanelResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** Result of a connectivity check, so setup errors surface at setup time. */
export interface TestResult {
  ok: boolean;
  message: string;
}

export type PanelTask =
  | { kind: 'download'; filename: string; content: string; mimeType: string }
  | { kind: 'clipboard'; text: string };

export type PanelPush =
  | { type: 'STATE'; state: PanelState }
  | { type: 'RUN'; run: RunSnapshot }
  | { type: 'CHAT'; text: string; kind?: 'result' | 'error' | 'info' }
  | { type: 'PANEL_TASK'; taskId: string; task: PanelTask };

export interface CapabilityGroups {
  currentSite: Capability[];
  otherSites: Capability[];
  extension: Capability[];
}
