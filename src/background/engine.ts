import type { PanelTask } from '../shared/messages';
import type { GateStep, WorkflowPlan, WorkflowStep } from '../shared/schema';
import type {
  Capability,
  JsonObject,
  JsonValue,
  RunSnapshot,
  RunStatus,
  RunStepSnapshot,
} from '../shared/types';
import {
  describeShape,
  getPath,
  newId,
  preview,
  resolveTemplates,
  toArray,
  toJson,
  variableName,
} from '../shared/util';
import { getGlobalTool } from './global-tools';
import { buildCapabilities, callPageTool, liveSiteForOrigin } from './registry';
import { ensureCapability } from './resolver';
import { getSettings } from './storage';
import {
  applyTransform,
  conditionFields,
  describeGate,
  describeTransform,
  describeTransformResult,
  evaluateCondition,
  explainCondition,
} from './transform';
import { ReasonDeclined, type ReasonOutcome, type ReasonRequest } from './summary';

/**
 * Executes a validated plan one step at a time.
 *
 * A run can pause: if a step needs a site that is closed (and could not be
 * reopened), the run parks as BLOCKED with its variables intact so the user can
 * resolve the capability and resume instead of starting over.
 */

export interface RunOptions {
  autoOpenSites: boolean;
  /** Explicit user approval, required when the plan writes to a site. */
  approved: boolean;
  runPanelTask(task: PanelTask): Promise<unknown>;
  /** Runs a `reason` step. Injected so the engine stays independent of the model layer. */
  reason(request: ReasonRequest): Promise<ReasonOutcome>;
  onUpdate(run: RunSnapshot): void;
}

interface RunRecord {
  id: string;
  workflowId?: string;
  workflowName: string;
  prompt: string;
  steps: WorkflowStep[];
  finalOutput?: string;
  context: Record<string, unknown>;
  snapshots: RunStepSnapshot[];
  cursor: number;
  status: RunStatus;
  startedAt: number;
  cancelled: boolean;
  error?: string;
  lastOutputVar?: string;
}

const runs = new Map<string, RunRecord>();

/** Capabilities in the plan that change remote state — these gate on approval. */
export function riskyCapabilities(plan: WorkflowPlan, capabilities: Capability[]): Capability[] {
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const risky: Capability[] = [];
  for (const step of plan.steps) {
    if (step.type !== 'tool') continue;
    const capability = byId.get(step.tool);
    if (!capability || capability.local) continue;
    if (capability.risk === 'write' || capability.risk === 'destructive') risky.push(capability);
  }
  return risky;
}

function stepLabel(step: WorkflowStep, capabilities: Map<string, Capability>): string {
  if (step.label) return step.label;
  if (step.type === 'tool') {
    const capability = capabilities.get(step.tool);
    const base = capability?.label ?? step.tool;
    return step.forEach ? `${base} (for each item)` : base;
  }
  if (step.type === 'transform') return describeTransform(step);
  if (step.type === 'reason') return step.instruction;
  if (step.type === 'gate') return describeGate(step);
  return `Missing: ${step.capability}`;
}

function snapshotOf(record: RunRecord): RunSnapshot {
  return {
    id: record.id,
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    status: record.status,
    steps: record.snapshots.map((step) => ({ ...step })),
    startedAt: record.startedAt,
    durationMs: record.status === 'running' ? undefined : Date.now() - record.startedAt,
    finalPreview: record.status === 'completed' ? preview(finalValue(record)) : undefined,
    resultShape: record.status === 'completed' ? describeShape(finalValue(record)) : undefined,
    error: record.error,
  };
}

function finalValue(record: RunRecord): unknown {
  if (record.finalOutput) {
    const resolved = getPath(record.context, variableName(record.finalOutput));
    if (resolved !== undefined) return resolved;
  }
  if (record.lastOutputVar) return record.context[record.lastOutputVar];
  return record.context;
}

export function runResult(runId: string): { context: Record<string, unknown>; final: unknown } | undefined {
  const record = runs.get(runId);
  if (!record) return undefined;
  return { context: record.context, final: finalValue(record) };
}

export function getRun(runId: string): RunSnapshot | undefined {
  const record = runs.get(runId);
  return record ? snapshotOf(record) : undefined;
}

export function cancelRun(runId: string): void {
  const record = runs.get(runId);
  if (record) record.cancelled = true;
}

export async function startRun(
  input: { plan: WorkflowPlan; prompt: string; workflowId?: string },
  options: RunOptions,
): Promise<RunSnapshot> {
  const capabilities = await buildCapabilities();
  const risky = riskyCapabilities(input.plan, capabilities);
  if (risky.length > 0 && !options.approved) {
    throw new Error(
      `This workflow writes to ${[...new Set(risky.map((item) => item.provider))].join(', ')} and needs explicit approval before running.`,
    );
  }

  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const record: RunRecord = {
    id: newId('run'),
    workflowId: input.workflowId,
    workflowName: input.plan.name,
    prompt: input.prompt,
    steps: input.plan.steps,
    finalOutput: input.plan.finalOutput,
    context: {},
    snapshots: input.plan.steps.map((step) => ({
      id: step.id,
      label: stepLabel(step, byId),
      type: step.type,
      tool: step.type === 'tool' ? step.tool : undefined,
      status: 'pending',
    })),
    cursor: 0,
    status: 'running',
    startedAt: Date.now(),
    cancelled: false,
  };
  runs.set(record.id, record);
  return execute(record, options);
}

export async function resumeRun(runId: string, options: RunOptions): Promise<RunSnapshot> {
  const record = runs.get(runId);
  if (!record) throw new Error('That run is no longer available — regenerate or rerun the workflow.');
  if (record.status === 'running') return snapshotOf(record);
  record.status = 'running';
  record.error = undefined;
  record.cancelled = false;
  const blocked = record.snapshots[record.cursor];
  if (blocked) {
    blocked.status = 'pending';
    blocked.blockedOn = undefined;
    blocked.error = undefined;
  }
  return execute(record, options);
}

async function execute(record: RunRecord, options: RunOptions): Promise<RunSnapshot> {
  options.onUpdate(snapshotOf(record));

  while (record.cursor < record.steps.length) {
    if (record.cancelled) {
      record.status = 'cancelled';
      options.onUpdate(snapshotOf(record));
      return snapshotOf(record);
    }

    const step = record.steps[record.cursor];
    const snapshot = record.snapshots[record.cursor];
    const startedAt = Date.now();
    snapshot.status = 'running';
    options.onUpdate(snapshotOf(record));

    try {
      if (step.type === 'missing') {
        snapshot.status = 'skipped';
        snapshot.error = step.reason || `No available capability can ${step.capability}`;
        snapshot.durationMs = 0;
      } else if (step.type === 'transform') {
        const inputValue = getPath(record.context, variableName(step.input));
        if (inputValue === undefined) {
          throw new Error(`"${variableName(step.input)}" was never produced by an earlier step`);
        }
        const value = applyTransform(step, inputValue, record.context);
        record.context[step.output] = value;
        record.lastOutputVar = step.output;
        snapshot.status = 'ok';
        snapshot.preview = describeTransformResult(inputValue, value);
        snapshot.durationMs = Date.now() - startedAt;
      } else if (step.type === 'reason') {
        const outcome = await executeReasonStep(step, record, snapshot, options);
        snapshot.durationMs = Date.now() - startedAt;
        if (outcome === 'needs_judgement') {
          // Same shape as a gate stopping: the steps below did not fail, they were
          // never reached, and the run is a stop rather than a failure.
          for (const later of record.snapshots.slice(record.cursor + 1)) {
            later.status = 'skipped';
            later.error = 'Not reached — the judgement above has to be made first';
          }
          record.status = 'needs_judgement';
          options.onUpdate(snapshotOf(record));
          return snapshotOf(record);
        }
      } else if (step.type === 'gate') {
        // The condition is checked against the run's variables, not one row, so a
        // gate can compare a price to a balance produced by two different sites.
        //
        // A gate fails closed. If the data it checks never arrived, comparing
        // against nothing could pass by accident ("price < 3500" against no
        // price), so an absent variable stops the run outright.
        const missingVars = gateVariables(step.condition, record.context);
        const passed = missingVars.length === 0 && evaluateCondition(record.context, step.condition);
        const explanation =
          missingVars.length > 0
            ? `nothing produced ${missingVars.join(', ')}, so the check could not be made`
            : explainCondition(record.context, step.condition);
        snapshot.status = passed ? 'ok' : 'skipped';
        snapshot.preview = passed ? explanation : `Stopped — ${explanation}`;
        snapshot.durationMs = Date.now() - startedAt;
        if (!passed) {
          for (const later of record.snapshots.slice(record.cursor + 1)) {
            later.status = 'skipped';
            later.error = 'Not reached — the check above stopped the workflow';
          }
          // Not a failure: deciding to do nothing is the point of a gate.
          record.status = 'conditions_not_met';
          options.onUpdate(snapshotOf(record));
          return snapshotOf(record);
        }
      } else {
        const outcome = await executeToolStep(step, record, snapshot, options);
        if (outcome === 'blocked') {
          record.status = 'blocked';
          options.onUpdate(snapshotOf(record));
          return snapshotOf(record);
        }
        snapshot.durationMs = Date.now() - startedAt;
      }
    } catch (error) {
      snapshot.status = 'error';
      snapshot.error = error instanceof Error ? error.message : String(error);
      snapshot.durationMs = Date.now() - startedAt;
      record.status = 'failed';
      record.error = snapshot.error;
      options.onUpdate(snapshotOf(record));
      return snapshotOf(record);
    }

    record.cursor += 1;
    options.onUpdate(snapshotOf(record));
  }

  record.status = 'completed';
  options.onUpdate(snapshotOf(record));
  return snapshotOf(record);
}

/**
 * Judgement the transform DSL cannot express. In `select` mode the model returns
 * indices and the rows are taken from the original data, so it can narrow the set
 * but never fabricate or edit what is in it.
 */
async function executeReasonStep(
  step: Extract<WorkflowStep, { type: 'reason' }>,
  record: RunRecord,
  snapshot: RunStepSnapshot,
  options: RunOptions,
): Promise<'ok' | 'needs_judgement'> {
  const inputValue = getPath(record.context, variableName(step.input));
  if (inputValue === undefined) {
    throw new Error(`"${variableName(step.input)}" was never produced by an earlier step`);
  }
  const items = toArray(inputValue);

  let outcome: ReasonOutcome;
  try {
    outcome = await options.reason({
      instruction: step.instruction,
      items,
      mode: step.mode,
    });
  } catch (error) {
    // Only a declared handoff is treated as a stop. A `reason` implementation that
    // genuinely broke still fails the run, so this cannot swallow a real fault.
    if (!(error instanceof ReasonDeclined)) throw error;
    snapshot.status = 'skipped';
    snapshot.error = error.message;
    snapshot.preview = `Handed back — ${items.length} ${items.length === 1 ? 'row' : 'rows'} ready to judge`;
    return 'needs_judgement';
  }

  if (step.mode === 'select') {
    const indices = new Set((outcome.keep ?? []).filter((index) => Number.isInteger(index)));
    const kept = items.filter((_item, index) => indices.has(index));
    record.context[step.output] = toJson(kept);
    snapshot.preview = `${items.length} → ${preview(kept)}${outcome.why ? ` — ${outcome.why}` : ''}`;
  } else {
    record.context[step.output] = outcome.value ?? null;
    snapshot.preview = `${preview(outcome.value)}${outcome.why ? ` — ${outcome.why}` : ''}`;
  }

  record.lastOutputVar = step.output;
  snapshot.status = 'ok';
  return 'ok';
}

/** Variables a gate's condition reads that no step in this run produced. */
export function gateVariables(condition: GateStep['condition'], scope: Record<string, unknown>): string[] {
  return conditionFields(condition).filter((name) => scope[name] === undefined);
}

const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** `{{a.b.c}}` references in an argument tree that resolve to nothing. */
export function unresolvedTemplates(value: unknown, scope: Record<string, unknown>): string[] {
  const missing: string[] = [];
  const walk = (input: unknown): void => {
    if (typeof input === 'string') {
      for (const match of input.matchAll(TEMPLATE)) {
        const expression = match[1].trim();
        if (getPath(scope, expression) === undefined) missing.push(expression);
      }
      return;
    }
    if (Array.isArray(input)) {
      input.forEach(walk);
      return;
    }
    if (input && typeof input === 'object') Object.values(input).forEach(walk);
  };
  walk(value);
  return [...new Set(missing)];
}

/** Says what the variable actually contains, so the mismatch is obvious. */
function describeReference(reference: string, scope: Record<string, unknown>): string {
  const root = reference.split('.')[0];
  const value = scope[root];
  if (value === undefined) return `"{{${reference}}}" — nothing produced "${root}"`;
  if (Array.isArray(value)) return `"{{${reference}}}" — "${root}" is a list of ${value.length}`;
  if (value && typeof value === 'object') {
    return `"{{${reference}}}" — "${root}" contains: ${Object.keys(value).join(', ')}`;
  }
  return `"{{${reference}}}" — "${root}" is ${typeof value}`;
}

type ToolOutcome = 'ok' | 'blocked';

async function executeToolStep(
  step: Extract<WorkflowStep, { type: 'tool' }>,
  record: RunRecord,
  snapshot: RunStepSnapshot,
  options: RunOptions,
): Promise<ToolOutcome> {
  const ensured = await ensureCapability(step.tool, { autoOpen: options.autoOpenSites });
  if (!ensured.ok) {
    snapshot.status = 'blocked';
    snapshot.blockedOn = ensured.requirement;
    snapshot.error = ensured.requirement.detail ?? 'Capability unavailable';
    return 'blocked';
  }

  const capability = ensured.capability ?? (await findCapability(step.tool));
  if (!capability) throw new Error(`Capability ${step.tool} disappeared before it could run`);

  const invoke = async (scope: Record<string, unknown>): Promise<JsonValue> => {
    // A `{{path}}` into a shape the caller guessed wrong resolves to null and the
    // tool then fails with something opaque ("No run with id null"). Catch it here
    // and say which reference broke, and what the variable actually holds.
    const unresolved = unresolvedTemplates(step.arguments ?? {}, scope);
    if (unresolved.length > 0) {
      throw new Error(
        `${unresolved.map((reference) => describeReference(reference, scope)).join('; ')}. ` +
          'The workflow expected a different shape from an earlier step.',
      );
    }
    const args = resolveTemplates(step.arguments ?? {}, scope) as JsonObject;
    return callCapability(capability, args, options);
  };

  if (!step.forEach) {
    const value = await invoke(record.context);
    if (step.output) {
      record.context[step.output] = value;
      record.lastOutputVar = step.output;
    }
    snapshot.status = 'ok';
    snapshot.preview = preview(value);
    return 'ok';
  }

  const items = toArray(getPath(record.context, variableName(step.forEach)));
  if (items.length === 0) {
    snapshot.status = 'skipped';
    snapshot.error = `"${variableName(step.forEach)}" was empty, so there was nothing to do`;
    if (step.output) record.context[step.output] = [];
    return 'ok';
  }

  const results: JsonValue[] = [];
  const failures: string[] = [];
  snapshot.iterations = { total: items.length, done: 0, failed: 0 };

  for (const [index, item] of items.entries()) {
    if (record.cancelled) break;
    try {
      results.push(await invoke({ ...record.context, item, index }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      // Default is to keep going so one bad row does not lose the whole batch;
      // `continueOnError: false` opts into fail-fast.
      if (step.continueOnError === false) throw error;
      results.push(toJson({ error: message }));
    }
    snapshot.iterations = { total: items.length, done: index + 1, failed: failures.length };
    options.onUpdate(snapshotOf(record));
  }

  if (step.output) {
    record.context[step.output] = results;
    record.lastOutputVar = step.output;
  }

  if (failures.length === items.length) {
    throw new Error(`All ${items.length} calls to ${capability.label} failed: ${failures[0]}`);
  }
  snapshot.status = 'ok';
  snapshot.preview = `${items.length - failures.length}/${items.length} succeeded — ${preview(results)}`;
  if (failures.length > 0) snapshot.error = `${failures.length} failed: ${failures[0]}`;
  return 'ok';
}

async function findCapability(id: string): Promise<Capability | undefined> {
  const capabilities = await buildCapabilities();
  return capabilities.find((capability) => capability.id === id);
}

async function callCapability(
  capability: Capability,
  args: JsonObject,
  options: RunOptions,
): Promise<JsonValue> {
  if (capability.source === 'extension') {
    const tool = getGlobalTool(capability.id);
    if (!tool) throw new Error(`Extension tool ${capability.id} is not available`);
    return tool.execute(args, { runPanelTask: options.runPanelTask, settings: await getSettings() });
  }

  const site = capability.origin ? liveSiteForOrigin(capability.origin, capability.tabId) : undefined;
  const tabId = site?.tabId ?? capability.tabId;
  if (typeof tabId !== 'number') {
    throw new Error(`${capability.provider} is no longer open, so ${capability.label} cannot run`);
  }
  const outcome = await callPageTool(tabId, capability.name, args);
  if (!outcome.ok) throw new Error(outcome.error ?? `${capability.label} failed`);
  return toJson(outcome.value ?? outcome.text ?? null);
}
