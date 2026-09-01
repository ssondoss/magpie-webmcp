import type { ResultShape } from './util';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** MCP-style tool annotations, as exposed by WebMCP tool registrations. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** The raw shape a page registers through `navigator.modelContext`. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
  annotations?: ToolAnnotations;
}

export type CapabilitySource = 'webmcp' | 'extension';

export type CapabilityStatus =
  | 'AVAILABLE'
  | 'SITE_CLOSED'
  | 'AUTH_REQUIRED'
  | 'TOOL_CHANGED'
  | 'TOOL_MISSING';

export type RiskLevel = 'read' | 'write' | 'destructive';

/**
 * The unified registry entry. Callers only ever see this shape — they never
 * learns whether a capability is a live page tool or an extension built-in.
 */
export interface Capability {
  id: string;
  name: string;
  label: string;
  description: string;
  provider: string;
  providerKey: string;
  origin?: string;
  inputSchema: JsonObject;
  source: CapabilitySource;
  status: CapabilityStatus;
  risk: RiskLevel;
  /** Extension tools whose side effects stay on this machine (files, clipboard). */
  local?: boolean;
  tabId?: number;
  lastSeenAt?: number;
  schemaHash?: string;
  statusDetail?: string;
}

export interface LiveSite {
  tabId: number;
  origin: string;
  url: string;
  title: string;
  providerName: string;
  tools: ToolDescriptor[];
  updatedAt: number;
}

/** What we persist about a site so a saved workflow can find it again later. */
export interface KnownSite {
  origin: string;
  provider: string;
  providerKey: string;
  title: string;
  url: string;
  tools: ToolDescriptor[];
  lastSeenAt: number;
  /**
   * Tool name → the URL last seen exposing it.
   *
   * Identity stays the origin, which is the web's actual trust boundary and the
   * only thing stable enough to resolve a saved workflow months later. This is
   * navigation metadata, not a second identity: some origins host several apps on
   * different paths, so "the site is open" does not guarantee "this tool is here".
   * Without it, such a tool is unrecoverable — the site is not closed, so nothing
   * reopens it, and the run just stops.
   */
  toolUrls?: Record<string, string>;
}

export interface PageContext {
  tabId?: number;
  url?: string;
  origin?: string;
  title?: string;
  provider?: string;
  providerKey?: string;
  toolCount: number;
  webmcp: boolean;
}

export interface RequiredCapability {
  tool: string;
  name: string;
  label: string;
  description: string;
  provider: string;
  origin?: string;
  source: CapabilitySource;
  inputSchema: JsonObject;
  schemaHash: string;
}

export interface SavedWorkflow {
  id: string;
  name: string;
  summary: string;
  prompt: string;
  steps: JsonValue;
  finalOutput?: string;
  requiredCapabilities: RequiredCapability[];
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: RunStatus;
}

export interface ReplacementCandidate {
  id: string;
  label: string;
  description: string;
  provider: string;
}

export interface RequirementStatus {
  tool: string;
  label: string;
  provider: string;
  origin?: string;
  source: CapabilitySource;
  status: CapabilityStatus;
  detail?: string;
  candidates?: ReplacementCandidate[];
}

export type StepStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'blocked';

/**
 * Two of these are stops rather than failures, and both are deliberately not
 * `failed`.
 *
 * `conditions_not_met` — a gate step decided the rest of the workflow should not
 * happen. A watch job that finds nothing to do must not look broken.
 *
 * `needs_judgement` — a `reason` step reached the point where the transform DSL
 * runs out and a model is required. Magpie has none by design and hands the
 * question back with the data attached. That is the designed behaviour, so
 * reporting it as a crash misrepresents the one decision most worth explaining.
 */
export type RunStatus =
  | 'running'
  | 'completed'
  | 'conditions_not_met'
  | 'needs_judgement'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface RunStepSnapshot {
  id: string;
  label: string;
  type: 'tool' | 'transform' | 'reason' | 'gate' | 'missing';
  tool?: string;
  status: StepStatus;
  durationMs?: number;
  preview?: string;
  error?: string;
  blockedOn?: RequirementStatus;
  iterations?: { total: number; done: number; failed: number };
}

export interface RunSnapshot {
  id: string;
  workflowName: string;
  status: RunStatus;
  steps: RunStepSnapshot[];
  startedAt: number;
  durationMs?: number;
  finalPreview?: string;
  /** Fields and a sample of what the run produced, for the next turn's context. */
  resultShape?: ResultShape;
  error?: string;
  workflowId?: string;
}

export interface Settings {
  autoOpenSites: boolean;
  /** Slack incoming-webhook URL; without it send_slack_message cannot run. */
  slackWebhookUrl: string;
  /** Where compose_email opens a draft. */
  emailClient: 'gmail' | 'mailto';
  /** How create_calendar_event hands over the event: a Google form, or an .ics file. */
  calendarClient: 'google' | 'ics';
}

export interface PublicSettings {
  autoOpenSites: boolean;
  hasSlackWebhook: boolean;
  /** Host of the stored webhook, so a mis-pasted URL is visible. */
  slackWebhookHost: string;
  emailClient: 'gmail' | 'mailto';
  calendarClient: 'google' | 'ics';
}

export interface PanelState {
  context: PageContext;
  capabilities: Capability[];
  knownSites: Array<{ origin: string; provider: string; toolCount: number; lastSeenAt: number; open: boolean }>;
  settings: PublicSettings;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  kind?: 'plan' | 'result' | 'error' | 'info';
}
