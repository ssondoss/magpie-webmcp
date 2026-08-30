import type { WorkflowStep } from '../../src/shared/schema';
import { newId } from '../../src/shared/util';

/**
 * Everything the site knows, in localStorage. No backend, and no account — a
 * first-time visitor gets the seeded library so the app is never empty.
 */

export interface StoredWorkflow {
  id: string;
  name: string;
  summary: string;
  steps: WorkflowStep[];
  finalOutput?: string;
  /** Capability ids the workflow needs, for the requirements view. */
  requires: string[];
  createdAt: string;
  source: 'seeded' | 'agent' | 'extension';
}

export interface StoredRunStep {
  id: string;
  label: string;
  type: WorkflowStep['type'];
  status: 'ok' | 'error' | 'skipped';
  preview?: string;
  error?: string;
}

export interface StoredRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: 'completed' | 'failed' | 'partial';
  steps: StoredRunStep[];
  finalPreview?: string;
  startedAt: string;
  durationMs: number;
}

const KEY = 'magpie.v1';

interface Snapshot {
  workflows: StoredWorkflow[];
  runs: StoredRun[];
}

const listeners = new Set<() => void>();
let cache: Snapshot | null = null;

function read(): Snapshot {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Snapshot>;
      cache = {
        workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      };
      return cache;
    }
  } catch {
    /* corrupt or unavailable storage — fall through to a fresh library */
  }
  cache = { workflows: [], runs: [] };
  return cache;
}

function write(next: Snapshot): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode or quota — the session still works, it just will not persist */
  }
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The whole store as one object, for `useSyncExternalStore`.
 *
 * The reference must stay identical until something actually changes — a getter
 * that builds a fresh array each call (`.slice()`, `.filter()`) makes React
 * re-render forever. `write()` swaps in a new object, so identity changes exactly
 * when the data does. Derive slices in the component with `useMemo`.
 */
export function getSnapshot(): Snapshot {
  return read();
}

export function getWorkflows(): StoredWorkflow[] {
  return read().workflows;
}

export function getWorkflow(id: string): StoredWorkflow | undefined {
  return read().workflows.find((workflow) => workflow.id === id || workflow.name === id);
}

export function saveWorkflow(input: Omit<StoredWorkflow, 'id' | 'createdAt'> & { id?: string }): StoredWorkflow {
  const snapshot = read();
  const workflow: StoredWorkflow = {
    ...input,
    id: input.id ?? newId('wf'),
    createdAt: new Date().toISOString(),
  };
  const index = snapshot.workflows.findIndex((item) => item.id === workflow.id);
  const workflows = [...snapshot.workflows];
  if (index >= 0) workflows[index] = workflow;
  else workflows.unshift(workflow);
  write({ ...snapshot, workflows });
  return workflow;
}

/**
 * Names are how workflows are referred to.
 *
 * `getWorkflow` matches on id *or* exact name, so two workflows sharing a name
 * would make "run the weekly export" silently pick one of them. Rejecting the
 * collision is the only way that stays predictable.
 */
export function assertNameFree(name: string, exceptId?: string): string {
  const clean = name.trim();
  if (!clean) throw new Error('A workflow needs a name.');
  const clash = read().workflows.find((item) => item.id !== exceptId && item.name === clean);
  if (clash) throw new Error(`Another workflow is already called "${clean}". Names are how workflows are referenced.`);
  return clean;
}

export function renameWorkflow(id: string, name: string): StoredWorkflow {
  const snapshot = read();
  const workflow = snapshot.workflows.find((item) => item.id === id || item.name === id);
  if (!workflow) throw new Error(`No workflow matching "${id}"`);
  const renamed = { ...workflow, name: assertNameFree(name, workflow.id) };
  write({
    ...snapshot,
    workflows: snapshot.workflows.map((item) => (item.id === workflow.id ? renamed : item)),
  });
  return renamed;
}

export function deleteWorkflow(id: string): boolean {
  const snapshot = read();
  const workflows = snapshot.workflows.filter((workflow) => workflow.id !== id);
  if (workflows.length === snapshot.workflows.length) return false;
  write({ ...snapshot, workflows });
  return true;
}

export function getRuns(limit = 20): StoredRun[] {
  return read().runs.slice(0, limit);
}

export function getRun(id: string): StoredRun | undefined {
  return read().runs.find((run) => run.id === id);
}

export function deleteRun(id: string): boolean {
  const snapshot = read();
  const runs = snapshot.runs.filter((run) => run.id !== id);
  if (runs.length === snapshot.runs.length) return false;
  write({ ...snapshot, runs });
  return true;
}

export function clearRuns(): number {
  const snapshot = read();
  const removed = snapshot.runs.length;
  if (removed === 0) return 0;
  write({ ...snapshot, runs: [] });
  return removed;
}

export function recordRun(run: StoredRun): StoredRun {
  const snapshot = read();
  // Keep the history bounded; nobody scrolls past fifty.
  write({ ...snapshot, runs: [run, ...snapshot.runs].slice(0, 50) });
  return run;
}

/** Only ever called when storage is empty, so a returning visitor keeps their own data. */
export function seedIfEmpty(seed: Snapshot): void {
  const snapshot = read();
  if (snapshot.workflows.length > 0 || snapshot.runs.length > 0) return;
  write(seed);
}
