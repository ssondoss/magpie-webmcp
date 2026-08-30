import { planSchema, type WorkflowPlan, type WorkflowStep } from '../../src/shared/schema';
import type { JsonObject, JsonValue, ToolDescriptor } from '../../src/shared/types';
import { isPlainObject, newId, toArray, toJson } from '../../src/shared/util';
import { buildCsv } from '../../src/background/global-tools';
import { runWorkflow, type WebTool } from './engine';
import { listExtensionCapabilities, runWithExtension, type ExtensionCapability } from './extension';
import {
  assertNameFree,
  clearRuns,
  deleteRun,
  deleteWorkflow,
  getRun,
  getRuns,
  getWorkflow,
  getWorkflows,
  recordRun,
  renameWorkflow,
  saveWorkflow,
  type StoredRun,
  type StoredRunStep,
  type StoredWorkflow,
} from './store';

/**
 * The capabilities this site exposes through WebMCP.
 *
 * Magpie's own job is managing workflows, so these are about workflows — listing,
 * inspecting, creating and running them. It deliberately holds no business data of
 * its own: the data lives on whatever sites expose it, and the extension is what
 * reaches them.
 *
 * Registered with `document.modelContext.registerTool()`, so any agent — ChatGPT's
 * in-app browser, the Magpie extension, anything else — can operate the library
 * without a dedicated UI being built for it.
 */

const object = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  properties,
  required,
});

function download(filename: string, content: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Steps arrive from an agent as loose JSON; validate before storing anything. */
function parseSteps(value: unknown): WorkflowStep[] {
  const parsed = planSchema.safeParse({
    name: 'validation',
    status: 'SUPPORTED',
    steps: Array.isArray(value) ? value : [],
  });
  if (!parsed.success) {
    throw new Error(
      'Those steps are not a valid workflow. Each step must be {type:"tool"|"transform"|"reason"|"missing", …}.',
    );
  }
  return parsed.data.steps;
}

/* ---------------------------------------------------------------------------
 * Reaching other sites.
 *
 * A page can only call the tools registered on itself — `document.modelContext`
 * is per-document, so no amount of cleverness here reaches another origin. The
 * extension is what crosses that boundary, and these helpers project its
 * registry and its engine onto this site's tool surface. When it is absent every
 * one of them degrades to "only this site", never to a wrong answer.
 * ------------------------------------------------------------------------- */

/**
 * Short-lived cache: listing and step validation both want the same registry.
 *
 * A failed lookup is cached too, briefly. One `run_steps` asks three times —
 * validation, the write check, the routing decision — and without this every
 * one of them waits out the timeout again, turning a missing extension into
 * minutes of apparent hanging. The negative window is short so that installing
 * the extension, or waking its worker, is noticed almost immediately.
 */
const REGISTRY_TTL_MS = 10_000;
const REGISTRY_MISS_TTL_MS = 3_000;
let registryCache: { at: number; items: ExtensionCapability[] | null } | null = null;

/**
 * Drops the cached registry, so the next lookup goes to the extension.
 *
 * Called when something happened that plausibly changed it — the tab regaining
 * focus, or the extension being installed while the page was already open —
 * rather than waiting out a TTL that exists only to avoid repeated timeouts.
 */
export function forgetReachable(): void {
  registryCache = null;
}

async function reachable(): Promise<ExtensionCapability[] | null> {
  const ttl = registryCache?.items === null ? REGISTRY_MISS_TTL_MS : REGISTRY_TTL_MS;
  if (registryCache && Date.now() - registryCache.at < ttl) return registryCache.items;
  try {
    const { capabilities } = await listExtensionCapabilities();
    registryCache = { at: Date.now(), items: capabilities };
    return capabilities;
  } catch {
    // Not installed, worker asleep, refusing this origin, or a content script
    // orphaned by an extension reload — indistinguishable from here.
    registryCache = { at: Date.now(), items: null };
    return null;
  }
}

function isLocal(step: WorkflowStep): boolean {
  return step.type !== 'tool' || step.tool in TOOLS;
}

/**
 * Tool names the agent invented or mistyped.
 *
 * This is where a hallucinated capability is caught: the workflow is rejected
 * with the names that do exist, rather than being stored and failing later.
 */
async function unknownTools(steps: WorkflowStep[]): Promise<{ unknown: string[]; known: string[] }> {
  const registry = await reachable();
  const known = [...Object.keys(TOOLS), ...(registry ?? []).map((capability) => capability.id)];
  const lookup = new Set(known);
  const unknown = [
    ...new Set(steps.flatMap((step) => (step.type === 'tool' && !lookup.has(step.tool) ? [step.tool] : []))),
  ];
  return { unknown, known };
}

/**
 * Rejects invented capabilities — but only when the registry could actually be
 * read. With no extension there is no list to check against, and "I cannot see
 * it" is not the same as "it does not exist": the workflow is stored, and the
 * step reports itself as unavailable at run time instead.
 */
async function assertToolsExist(steps: WorkflowStep[]): Promise<void> {
  if ((await reachable()) === null) return;
  const { unknown, known } = await unknownTools(steps);
  if (unknown.length === 0) return;
  throw new Error(
    `No such capability: ${unknown.join(', ')}. Nothing was invented to cover it. Available right now: ${known.join(', ')}. ` +
      'Call list_reachable_capabilities for the full registry with descriptions.',
  );
}

/** Human-readable descriptions of every step that changes something. */
async function writeActions(steps: WorkflowStep[]): Promise<string[]> {
  const registry = await reachable();
  const actions: string[] = [];
  for (const step of steps) {
    if (step.type !== 'tool') continue;
    const local = TOOLS[step.tool];
    if (local) {
      if (local.descriptor.annotations?.readOnlyHint !== true) {
        actions.push(`${local.descriptor.annotations?.title ?? step.tool} (this site)`);
      }
      continue;
    }
    const capability = registry?.find((item) => item.id === step.tool);
    if (capability && capability.risk !== 'read') actions.push(`${capability.label} on ${capability.provider}`);
  }
  return [...new Set(actions)];
}

/**
 * The approval gate, enforced here rather than in the UI.
 *
 * When an outside agent is driving, it is not the one that gets to decide a
 * write is acceptable — so this asks the person at the keyboard directly and
 * takes no `approved` argument that an agent could simply set to true.
 */
async function confirmWrites(steps: WorkflowStep[]): Promise<void> {
  const actions = await writeActions(steps);
  if (actions.length === 0) return;

  const ask = typeof window !== 'undefined' ? window.confirm : undefined;
  // Fail closed. Somewhere with no way to ask is not somewhere to assume yes.
  if (!ask) throw new Error('Cannot ask for confirmation here, so nothing that writes was run.');

  const allowed = ask.call(
    window,
    `Magpie is about to make changes:\n\n${actions.map((action) => `• ${action}`).join('\n')}\n\nRun this?`,
  );
  if (!allowed) throw new Error(`Declined by the user — nothing ran. Would have: ${actions.join(', ')}.`);
}

/** Projects the extension's run snapshot onto the shape this site stores. */
function toStoredRun(
  run: Awaited<ReturnType<typeof runWithExtension>>,
  steps: WorkflowStep[],
  name: string,
  workflowId: string,
  startedAt: number,
): StoredRun {
  const types = new Map(steps.map((step) => [step.id, step.type]));
  const recorded: StoredRunStep[] = run.run.steps.map((step) => ({
    id: step.id,
    label: step.label,
    type: types.get(step.id) ?? 'tool',
    status: step.status === 'ok' ? 'ok' : step.status === 'error' ? 'error' : 'skipped',
    preview: step.preview,
    error: step.error,
  }));
  return {
    id: run.run.id,
    workflowId,
    workflowName: name,
    status: recorded.some((step) => step.status === 'error')
      ? 'failed'
      : recorded.some((step) => step.status === 'skipped')
        ? 'partial'
        : 'completed',
    steps: recorded,
    finalPreview: run.answer,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Runs a step list wherever it can actually run, and records it either way.
 *
 * Steps are not split across engines: if anything needs another origin the whole
 * plan goes to the extension, whose registry is a superset of this site's.
 */
async function execute(
  steps: WorkflowStep[],
  name: string,
  finalOutput: string | undefined,
  workflowId: string,
): Promise<StoredRun> {
  await confirmWrites(steps);

  // Delegate only when there is something to delegate to. Without the extension
  // the local engine still runs every step it can and reports the rest as
  // unavailable, which tells the caller far more than one thrown error does.
  const crossSite = !steps.every(isLocal) && (await reachable()) !== null;

  if (!crossSite) {
    const workflow: StoredWorkflow = {
      id: workflowId,
      name,
      summary: '',
      steps,
      finalOutput,
      requires: [],
      createdAt: new Date().toISOString(),
      source: 'agent',
    };
    return recordRun(await runWorkflow(workflow, new Map(Object.entries(TOOLS))));
  }

  const plan: WorkflowPlan = {
    name,
    summary: '',
    status: 'SUPPORTED',
    steps,
    missingCapabilities: [],
    finalOutput,
  };
  const startedAt = Date.now();
  const run = await runWithExtension(plan, name, true);
  return recordRun(toStoredRun(run, steps, name, workflowId, startedAt));
}

export const TOOLS: Record<string, WebTool> = {
  list_capabilities: {
    descriptor: {
      name: 'list_capabilities',
      description:
        "List the capabilities this site exposes. Magpie manages workflows and holds no business data of its own — the data lives on other websites, so call list_reachable_capabilities as well to see what is reachable there.",
      inputSchema: object({}),
      annotations: { title: 'List capabilities', readOnlyHint: true },
    },
    execute: () => ({
      capabilities: Object.values(TOOLS).map((tool) => ({
        name: tool.descriptor.name,
        title: tool.descriptor.annotations?.title ?? tool.descriptor.name,
        description: tool.descriptor.description,
        readOnly: tool.descriptor.annotations?.readOnlyHint === true,
      })),
    }),
  },

  list_workflows: {
    descriptor: {
      name: 'list_workflows',
      description:
        'List the saved workflows in this library. Returns { workflows: [{ id, name, summary, stepCount, requires }], count }.',
      inputSchema: object({}),
      annotations: { title: 'List workflows', readOnlyHint: true },
    },
    execute: () => {
      const workflows = getWorkflows();
      return toJson({
        workflows: workflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          summary: workflow.summary,
          stepCount: workflow.steps.length,
          requires: workflow.requires,
          source: workflow.source,
        })),
        count: workflows.length,
      });
    },
  },

  get_workflow: {
    descriptor: {
      name: 'get_workflow',
      description: 'Get one workflow in full, including every step. Accepts an id or an exact name.',
      inputSchema: object({ workflowId: { type: 'string', description: 'Workflow id or exact name' } }, [
        'workflowId',
      ]),
      annotations: { title: 'Get workflow', readOnlyHint: true },
    },
    execute: (args) => {
      const workflow = getWorkflow(String(args.workflowId));
      if (!workflow) throw new Error(`No workflow matching "${String(args.workflowId)}"`);
      return toJson(workflow);
    },
  },

  run_workflow: {
    descriptor: {
      name: 'run_workflow',
      description:
        'Run a saved workflow now and return what happened, step by step. Steps that need another website are executed there through the Magpie extension; if it is not installed they are reported as skipped rather than guessed at. Anything that changes data prompts the user for confirmation first.',
      inputSchema: object({ workflowId: { type: 'string', description: 'Workflow id or exact name' } }, [
        'workflowId',
      ]),
      annotations: { title: 'Run workflow', readOnlyHint: false },
    },
    execute: async (args) => {
      const workflow = getWorkflow(String(args.workflowId));
      if (!workflow) throw new Error(`No workflow matching "${String(args.workflowId)}"`);
      return toJson(await execute(workflow.steps, workflow.name, workflow.finalOutput, workflow.id));
    },
  },

  run_steps: {
    descriptor: {
      name: 'run_steps',
      description:
        'Run a list of steps once, without saving a workflow. Use this to carry out a one-off request — it executes across every site Magpie can reach and records the run in this library, so the user can see afterwards what was done. Prefer this over calling capabilities one at a time. Save it with create_workflow only if the user wants it again later.',
      inputSchema: object(
        {
          steps: { type: 'array', description: 'The steps to run, in Magpie step format', items: { type: 'object' } },
          goal: { type: 'string', description: "What the user asked for, in their words. Labels the run." },
          finalOutput: { type: 'string', description: 'Name of the variable holding the answer' },
        },
        ['steps'],
      ),
      annotations: { title: 'Run steps', readOnlyHint: false },
    },
    execute: async (args) => {
      const steps = parseSteps(args.steps);
      if (steps.length === 0) throw new Error('run_steps needs at least one step.');
      await assertToolsExist(steps);
      const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim() : 'Ad-hoc steps';
      const finalOutput = typeof args.finalOutput === 'string' ? args.finalOutput : undefined;
      return toJson(await execute(steps, goal, finalOutput, newId('adhoc')));
    },
  },

  list_reachable_capabilities: {
    descriptor: {
      name: 'list_reachable_capabilities',
      description:
        'List every capability Magpie can reach on OTHER websites — including sites that are not open right now, which are reopened automatically when a workflow needs them. Call this before composing anything: this page holds no business data of its own, so orders, tickets, bookings and the like all live behind these. Returns { connected, capabilities: [{ id, title, description, provider, origin, status, readOnly }] }. Use the exact `id` as the `tool` value in a step.',
      inputSchema: object({}),
      annotations: { title: 'List reachable capabilities', readOnlyHint: true },
    },
    execute: async () => {
      const capabilities = await reachable();
      if (!capabilities) {
        return toJson({
          connected: false,
          count: 0,
          capabilities: [],
          note:
            'The Magpie extension is not installed or did not answer, so no other site is reachable from here. ' +
            "Only this site's own capabilities are available — call list_capabilities for those.",
        });
      }
      return toJson({
        connected: true,
        count: capabilities.length,
        capabilities: capabilities.map((capability) => ({
          id: capability.id,
          title: capability.label,
          description: capability.description,
          provider: capability.provider,
          origin: capability.origin,
          status: capability.status,
          readOnly: capability.risk === 'read',
        })),
      });
    },
  },

  list_runs: {
    descriptor: {
      name: 'list_runs',
      description: 'List recent workflow runs, newest first. Returns { runs: [...], count }.',
      inputSchema: object({ limit: { type: 'number', description: 'How many to return. Defaults to 10.' } }),
      annotations: { title: 'List runs', readOnlyHint: true },
    },
    execute: (args) => {
      const runs = getRuns(typeof args.limit === 'number' ? args.limit : 10);
      return toJson({ runs, count: runs.length });
    },
  },

  get_run: {
    descriptor: {
      name: 'get_run',
      description: 'Get one run in full, including every step result.',
      inputSchema: object({ runId: { type: 'string', description: 'Run id' } }, ['runId']),
      annotations: { title: 'Get run', readOnlyHint: true },
    },
    execute: (args) => {
      const run = getRun(String(args.runId));
      if (!run) throw new Error(`No run with id ${String(args.runId)}`);
      return toJson(run);
    },
  },

  create_workflow: {
    descriptor: {
      name: 'create_workflow',
      description:
        'Save a workflow to the library so it can be run again later. Steps use Magpie\'s format: {"type":"tool","tool":"orders.search_orders","arguments":{...},"output":"orders"} and {"type":"transform","operation":"filter","input":"orders","output":"big","condition":{"field":"amount","operator":">","value":5000}}. A later step reads an earlier one with {{output}}. Every `tool` must be an exact id from list_capabilities or list_reachable_capabilities — unknown names are rejected, never invented. This only saves; call run_workflow to execute.',
      inputSchema: object(
        {
          name: { type: 'string', description: 'Short name for the workflow' },
          summary: { type: 'string', description: 'One sentence describing what it does' },
          steps: { type: 'array', description: 'The workflow steps', items: { type: 'object' } },
          finalOutput: { type: 'string', description: 'Variable holding the answer' },
        },
        ['name', 'steps'],
      ),
      annotations: { title: 'Create workflow', readOnlyHint: false },
    },
    execute: async (args) => {
      const steps = parseSteps(args.steps);
      if (steps.length === 0) throw new Error('A workflow needs at least one step.');
      await assertToolsExist(steps);
      const requires = [...new Set(steps.flatMap((step) => (step.type === 'tool' ? [step.tool] : [])))];
      const name = assertNameFree(String(args.name ?? ''));
      const workflow = saveWorkflow({
        name,
        summary: typeof args.summary === 'string' ? args.summary : '',
        steps,
        finalOutput: typeof args.finalOutput === 'string' ? args.finalOutput : undefined,
        requires,
        source: 'agent',
      });
      return toJson(workflow);
    },
  },

  rename_workflow: {
    descriptor: {
      name: 'rename_workflow',
      description:
        'Rename a saved workflow. The name is how it is referred to afterwards, so pick something the user would say out loud. Names must be unique; renaming onto an existing one is refused.',
      inputSchema: object(
        {
          workflowId: { type: 'string', description: 'Workflow id, or its current exact name' },
          name: { type: 'string', description: 'The new name' },
        },
        ['workflowId', 'name'],
      ),
      annotations: { title: 'Rename workflow', readOnlyHint: false },
    },
    execute: (args) => toJson(renameWorkflow(String(args.workflowId), String(args.name ?? ''))),
  },

  delete_workflow: {
    descriptor: {
      name: 'delete_workflow',
      description: 'Delete a saved workflow from the library.',
      inputSchema: object({ workflowId: { type: 'string', description: 'Workflow id' } }, ['workflowId']),
      annotations: { title: 'Delete workflow', readOnlyHint: false, destructiveHint: true },
    },
    execute: (args) => {
      const id = String(args.workflowId);
      const workflow = getWorkflow(id);
      if (!workflow) throw new Error(`No workflow matching "${id}"`);
      deleteWorkflow(workflow.id);
      return toJson({ deleted: true, id: workflow.id, name: workflow.name });
    },
  },

  delete_run: {
    descriptor: {
      name: 'delete_run',
      description:
        'Remove one run from the history, or every run when `all` is true. History is what the user reviews afterwards, so only clear it when they ask.',
      inputSchema: object({
        runId: { type: 'string', description: 'Run id. Omit when clearing everything.' },
        all: { type: 'boolean', description: 'Delete every run instead of one' },
      }),
      annotations: { title: 'Delete run', readOnlyHint: false, destructiveHint: true },
    },
    execute: (args) => {
      if (args.all === true) return toJson({ deleted: clearRuns(), all: true });
      const id = String(args.runId ?? '');
      if (!id) throw new Error('delete_run needs a runId, or all: true.');
      if (!deleteRun(id)) throw new Error(`No run with id ${id}`);
      return toJson({ deleted: 1, id });
    },
  },

  export_csv: {
    descriptor: {
      name: 'export_csv',
      description:
        'Create and download a CSV file from an array of objects. Use whenever the user asks to export or save results as a spreadsheet.',
      inputSchema: object(
        {
          data: { type: 'array', description: 'Rows to export', items: { type: 'object' } },
          filename: { type: 'string', description: 'File name ending in .csv' },
        },
        ['data'],
      ),
      annotations: { title: 'Export CSV', readOnlyHint: false },
    },
    execute: (args) => {
      const { csv, columns, rowCount } = buildCsv(args.data);
      if (rowCount === 0) throw new Error('export_csv received no rows to export');
      const raw = typeof args.filename === 'string' && args.filename.trim() ? args.filename.trim() : 'export.csv';
      const filename = (raw.toLowerCase().endsWith('.csv') ? raw : `${raw}.csv`).replace(/[\\/:*?"<>|]+/g, '-');
      download(filename, csv, 'text/csv');
      return toJson({ filename, rowCount, columns });
    },
  },
};

/** Result shape agents expect from MCP: text for humans, structuredContent for machines. */
function mcpResult(payload: JsonValue): JsonObject {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: isPlainObject(payload) ? payload : { value: payload },
  } as JsonObject;
}

export function registerTools(): ToolDescriptor[] {
  const context = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  const descriptors = Object.values(TOOLS).map((tool) => tool.descriptor);

  if (!context || typeof context.registerTool !== 'function') return descriptors;

  const register = context.registerTool as (tool: unknown) => unknown;
  for (const tool of Object.values(TOOLS)) {
    register.call(context, {
      ...tool.descriptor,
      execute: async (args: JsonObject) => mcpResult(toJson(await tool.execute(args ?? {}))),
    });
  }
  return descriptors;
}

export { toArray };
