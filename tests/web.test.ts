import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The site must work with nothing installed, so these tests run it against a
 * minimal DOM/localStorage stub rather than a browser.
 */
const store = new Map<string, string>();
const registered: Array<Record<string, unknown>> = [];

(globalThis as unknown as Record<string, unknown>).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
};
(globalThis as unknown as Record<string, unknown>).document = {
  modelContext: {
    registerTool: (tool: Record<string, unknown>) => {
      registered.push(tool);
      return { unregister: () => {} };
    },
  },
  createElement: () => ({ href: '', download: '', click: () => {} }),
};
(globalThis as unknown as Record<string, unknown>).URL = Object.assign(URL, {
  createObjectURL: () => 'blob:stub',
  revokeObjectURL: () => {},
});
(globalThis as unknown as Record<string, unknown>).Blob = class {
  constructor(public parts: unknown[]) {}
};

/**
 * A stand-in for the Magpie extension, speaking the real page protocol.
 *
 * The site's whole cross-site story runs over `window.postMessage`, so stubbing
 * at that seam exercises the actual client — the request envelopes, the reply
 * matching, the failure path — rather than a mocked-out module.
 */
const { EXTENSION_TO_PAGE, PAGE_TO_EXTENSION } = await import('../src/shared/protocol');

const REACHABLE = [
  {
    id: 'orders.search_orders',
    label: 'Search orders',
    provider: 'Orders',
    origin: 'https://orders.example',
    status: 'AVAILABLE',
    risk: 'read',
    description: 'Find orders by status.',
  },
  {
    id: 'orders.refund_order',
    label: 'Refund order',
    provider: 'Orders',
    origin: 'https://orders.example',
    status: 'AVAILABLE',
    risk: 'write',
    description: 'Refund one order.',
  },
];

const messageListeners: Array<(event: { data: unknown; source: unknown }) => void> = [];
/** Test knobs: whether the extension answers, and what the user says to a write. */
const extension = { online: false, allowWrites: true, prompts: [] as string[], ran: [] as unknown[] };

const windowStub = {
  addEventListener(type: string, handler: (event: { data: unknown; source: unknown }) => void) {
    if (type === 'message') messageListeners.push(handler);
  },
  setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
  clearTimeout: (id: number) => clearTimeout(id),
  location: { origin: 'http://localhost:4173' },
  confirm(text: string) {
    extension.prompts.push(text);
    return extension.allowWrites;
  },
  postMessage(message: Record<string, unknown>) {
    if (message[PAGE_TO_EXTENSION] !== true) return;
    const request = message.request as { kind: string; plan?: { steps?: Array<{ id: string }> } };
    const reply = (payload: Record<string, unknown>) => {
      const data = { [EXTENSION_TO_PAGE]: true, requestId: message.requestId, ...payload };
      for (const handler of messageListeners) handler({ data, source: windowStub });
    };

    // Absence must be quick and explicit, never a hang the caller has to time out.
    if (!extension.online) {
      reply({ ok: false, error: 'The Magpie extension is not installed.' });
      return;
    }

    if (request.kind === 'CAPABILITIES') reply({ ok: true, data: { capabilities: REACHABLE } });
    else if (request.kind === 'PING') reply({ ok: true, data: { ready: true } });
    else if (request.kind === 'RUN') {
      extension.ran.push(request.plan);
      reply({
        ok: true,
        data: {
          run: {
            id: 'run_ext_1',
            status: 'completed',
            steps: (request.plan?.steps ?? []).map((step) => ({
              id: step.id,
              label: step.id,
              status: 'ok',
              preview: 'done',
            })),
          },
          answer: 'The extension ran it.',
        },
      });
    } else reply({ ok: false, error: `unsupported: ${request.kind}` });
  },
};
(globalThis as unknown as Record<string, unknown>).window = windowStub;

const { TOOLS, forgetReachable, registerTools } = await import('../web/app/tools');
const { SEED } = await import('../web/app/seed');
const { getRuns, getSnapshot, getWorkflows, seedIfEmpty } = await import('../web/app/store');

seedIfEmpty(SEED);

/** Tool results are MCP-shaped; unwrap for assertions. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await TOOLS[name].execute(args as never);
  return result as Record<string, unknown>;
}

test('the site registers a real WebMCP tool surface', () => {
  const descriptors = registerTools();
  assert.equal(registered.length, descriptors.length);
  assert.ok(descriptors.length >= 8, 'a non-trivial surface');

  for (const descriptor of descriptors) {
    assert.ok(descriptor.description.length > 30, `${descriptor.name} needs a usable description`);
    assert.equal(descriptor.inputSchema.type, 'object');
  }

  // Every registration carries an executable handler, not just metadata.
  assert.ok(registered.every((tool) => typeof tool.execute === 'function'));

  const names = descriptors.map((descriptor) => descriptor.name);
  for (const required of ['list_workflows', 'run_workflow', 'get_run', 'create_workflow', 'export_csv']) {
    assert.ok(names.includes(required), `missing ${required}`);
  }

  // The site manages workflows; business data belongs to the sites that expose it.
  assert.ok(!names.includes('search_orders'), 'the site must hold no business data of its own');
  assert.ok(!names.includes('get_customer'));
});

test('the store snapshot is referentially stable until data changes', async () => {
  // useSyncExternalStore re-renders forever if getSnapshot returns a fresh object
  // each call, and that failure only shows up in a browser — so pin it here.
  const before = getSnapshot();
  assert.equal(getSnapshot(), before, 'repeated reads must return the same reference');
  assert.equal(getSnapshot().runs, before.runs);

  await call('create_workflow', {
    name: 'Snapshot check',
    steps: [{ id: 's1', type: 'tool', tool: 'list_workflows', arguments: {}, output: 'out' }],
  });
  assert.notEqual(getSnapshot(), before, 'a write must produce a new reference');
});

test('a fresh visitor finds a populated library, not an empty shell', () => {
  assert.ok(getWorkflows().length >= 2);
  assert.ok(getRuns().length >= 1);
});

test('run_workflow really executes against the library itself', async () => {
  const run = (await call('run_workflow', { workflowId: 'wf_export_library' })) as {
    status: string;
    steps: Array<{ label: string; status: string; preview?: string }>;
    finalPreview?: string;
  };

  assert.equal(run.status, 'completed');
  assert.deepEqual(run.steps.map((step) => step.status), ['ok', 'ok', 'ok']);
  // list → pick → export. Earlier tests add workflows, so compare against the
  // library as it stands rather than a fixed number.
  assert.match(run.steps[2].preview ?? '', new RegExp(`rowCount: ${getWorkflows().length}`));
  assert.match(run.finalPreview ?? '', /Export the workflow library/);
});

test('grouped summaries compute real numbers', async () => {
  const run = (await call('run_workflow', { workflowId: 'wf_run_health' })) as {
    status: string;
    steps: Array<{ status: string }>;
  };
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.steps.map((step) => step.status), ['ok', 'ok']);
});

test('an agent can create a workflow, and invalid steps are refused', async () => {
  const created = (await call('create_workflow', {
    name: 'Count the library',
    summary: 'How many workflows are saved.',
    steps: [{ id: 's1', type: 'tool', tool: 'list_workflows', arguments: {}, output: 'out' }],
    finalOutput: 'out',
  })) as { id: string; requires: string[]; source: string };

  assert.equal(created.source, 'agent');
  assert.deepEqual(created.requires, ['list_workflows']);

  const run = (await call('run_workflow', { workflowId: created.id })) as { status: string };
  assert.equal(run.status, 'completed');

  await assert.rejects(
    () => call('create_workflow', { name: 'Bad', steps: [{ id: 's1', type: 'javascript', code: 'fetch()' }] }),
    /not a valid workflow/,
  );
});

test('a capability this site lacks is reported, never faked', async () => {
  const created = (await call('create_workflow', {
    name: 'Needs the extension',
    steps: [
      { id: 's1', type: 'tool', tool: 'list_workflows', arguments: {}, output: 'library' },
      { id: 's2', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'orders' },
    ],
  })) as { id: string };

  const run = (await call('run_workflow', { workflowId: created.id })) as {
    status: string;
    steps: Array<{ status: string; error?: string }>;
  };
  assert.equal(run.status, 'partial');
  assert.equal(run.steps[1].status, 'skipped');
  assert.match(run.steps[1].error ?? '', /not available on this site.*extension/);
});

test('a gate decides whether the rest of a workflow runs here too', async () => {
  // The same step type the extension uses, executed by the site's own engine —
  // conditions are deterministic local code, so no model is involved.
  const steps = (condition: unknown) => [
    { id: 's1', type: 'tool', tool: 'list_workflows', arguments: {}, output: 'library' },
    { id: 's2', type: 'gate', condition },
    { id: 's3', type: 'tool', tool: 'export_csv', arguments: { data: '{{library.workflows}}' }, output: 'file' },
  ];

  const stops = (await call('create_workflow', {
    name: 'Export only a huge library',
    steps: steps({ field: 'library.count', operator: '>', value: 9999 }),
  })) as { id: string; requires: string[] };
  // A gate calls nothing, so it adds no requirement.
  assert.deepEqual(stops.requires, ['list_workflows', 'export_csv']);

  const stopped = (await call('run_workflow', { workflowId: stops.id })) as {
    status: string;
    steps: Array<{ status: string; preview?: string }>;
  };
  assert.equal(stopped.status, 'partial');
  assert.deepEqual(stopped.steps.map((step) => step.status), ['ok', 'skipped']);
  assert.match(stopped.steps[1].preview ?? '', /Stopped — library\.count = \d+ > 9999 ✗/);

  const proceeds = (await call('create_workflow', {
    name: 'Export a non-empty library',
    steps: steps({ field: 'library.count', operator: '>=', value: 1 }),
  })) as { id: string };
  const ran = (await call('run_workflow', { workflowId: proceeds.id })) as {
    status: string;
    steps: Array<{ status: string }>;
  };
  assert.equal(ran.status, 'completed');
  assert.deepEqual(ran.steps.map((step) => step.status), ['ok', 'ok', 'ok']);
});

/* ---------------------------------------------------------------------------
 * Driving the site from an agent we do not control.
 *
 * Everything below reaches the site only through its WebMCP tool surface — no
 * component, no chat, no planner. That is the contract an outside agent gets.
 * ------------------------------------------------------------------------- */

test('with no extension, the site says so rather than reporting an empty world', async () => {
  extension.online = false;
  forgetReachable();
  const listed = (await call('list_reachable_capabilities')) as {
    connected: boolean;
    count: number;
    note?: string;
  };
  assert.equal(listed.connected, false, 'absence must be distinguishable from "nothing is reachable"');
  assert.equal(listed.count, 0);
  assert.match(listed.note ?? '', /not installed|did not answer/);
});

test('the reachable registry is what an agent composes against', async () => {
  extension.online = true;
  forgetReachable();
  const listed = (await call('list_reachable_capabilities')) as {
    connected: boolean;
    capabilities: Array<{ id: string; provider: string; readOnly: boolean }>;
  };
  assert.equal(listed.connected, true);
  assert.deepEqual(
    listed.capabilities.map((capability) => capability.id),
    ['orders.search_orders', 'orders.refund_order'],
  );
  // Risk has to survive the projection, or the approval gate has nothing to read.
  assert.equal(listed.capabilities[0].readOnly, true);
  assert.equal(listed.capabilities[1].readOnly, false);
});

test('an invented capability is refused, with the real ones named', async () => {
  extension.online = true;
  forgetReachable();
  await assert.rejects(
    () =>
      call('run_steps', {
        goal: 'Email me the orders',
        steps: [{ id: 's1', type: 'tool', tool: 'orders.send_email', arguments: {}, output: 'sent' }],
      }),
    (error: Error) => {
      assert.match(error.message, /No such capability: orders\.send_email/);
      assert.match(error.message, /orders\.search_orders/, 'must say what does exist');
      return true;
    },
  );
});

test('a step on another site is delegated to the extension, and the run is recorded', async () => {
  extension.online = true;
  forgetReachable();
  extension.ran = [];
  const before = getRuns().length;

  const run = (await call('run_steps', {
    goal: 'Show me open orders',
    steps: [{ id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'orders' }],
    finalOutput: 'orders',
  })) as { status: string; workflowName: string; steps: Array<{ status: string }> };

  assert.equal(extension.ran.length, 1, 'the whole plan crosses in one call');
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.steps.map((step) => step.status), ['ok']);
  assert.equal(run.workflowName, 'Show me open orders');

  // History is the point: an ad-hoc request still leaves a trail the user can read.
  assert.equal(getRuns().length, before + 1);
  assert.equal(getRuns()[0].workflowName, 'Show me open orders');
});

test('a run needing only this site never involves the extension', async () => {
  extension.online = true;
  forgetReachable();
  extension.ran = [];

  const run = (await call('run_steps', {
    goal: 'Count the library',
    steps: [{ id: 's1', type: 'tool', tool: 'list_workflows', arguments: {}, output: 'library' }],
    finalOutput: 'library',
  })) as { status: string };

  assert.equal(run.status, 'completed');
  assert.deepEqual(extension.ran, [], 'local work stays local');
});

test('a write asks the user, and the agent cannot answer on their behalf', async () => {
  extension.online = true;
  forgetReachable();
  extension.prompts = [];
  extension.allowWrites = false;
  extension.ran = [];

  const refund = [
    { id: 's1', type: 'tool', tool: 'orders.refund_order', arguments: { orderId: 'o1' }, output: 'refunded' },
  ];

  await assert.rejects(
    () => call('run_steps', { goal: 'Refund order o1', steps: refund }),
    /Declined by the user/,
  );
  assert.equal(extension.ran.length, 0, 'a declined write must not reach the extension');
  assert.match(extension.prompts[0] ?? '', /Refund order on Orders/);

  // There is no argument that skips the prompt — approval is not the agent's to give.
  extension.allowWrites = true;
  await call('run_steps', { goal: 'Refund order o1', steps: refund, approved: true });
  assert.equal(extension.prompts.length, 2, 'still asked, despite approved:true');
  assert.equal(extension.ran.length, 1);
});

test('a read-only run is never interrupted by a prompt', async () => {
  extension.online = true;
  forgetReachable();
  extension.prompts = [];

  await call('run_steps', {
    goal: 'Just look',
    steps: [{ id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'orders' }],
  });
  assert.deepEqual(extension.prompts, []);
});

test('a workflow can be renamed, and names stay unique', async () => {
  extension.online = false;
  forgetReachable();

  const created = (await call('create_workflow', {
    name: 'Nightly export',
    steps: [{ id: 's1', type: 'tool', tool: 'list_workflows', arguments: {}, output: 'out' }],
  })) as { id: string; name: string };

  const renamed = (await call('rename_workflow', { workflowId: created.id, name: '  Weekly export  ' })) as {
    id: string;
    name: string;
  };
  assert.equal(renamed.id, created.id, 'renaming must not create a second workflow');
  assert.equal(renamed.name, 'Weekly export', 'surrounding space is not part of a name');

  // The name is a lookup key, so it has to keep working as one.
  const found = (await call('get_workflow', { workflowId: 'Weekly export' })) as { id: string };
  assert.equal(found.id, created.id);

  // Two workflows sharing a name would make that lookup ambiguous.
  await assert.rejects(
    () => call('create_workflow', { name: 'Weekly export', steps: [{ id: 's1', type: 'tool', tool: 'list_workflows' }] }),
    /already called "Weekly export"/,
  );
  await assert.rejects(() => call('rename_workflow', { workflowId: created.id, name: '   ' }), /needs a name/);

  // Renaming a workflow to the name it already has is not a collision.
  const same = (await call('rename_workflow', { workflowId: 'Weekly export', name: 'Weekly export' })) as {
    name: string;
  };
  assert.equal(same.name, 'Weekly export');

  await call('delete_workflow', { workflowId: created.id });
});

test('list_runs honours its documented arguments', async () => {
  const all = (await call('list_runs')) as { count: number };
  assert.ok(all.count >= 1);

  const limited = (await call('list_runs', { limit: 1 })) as { count: number };
  assert.equal(limited.count, 1);
});

test('list_capabilities describes the surface to an agent', async () => {
  const result = (await call('list_capabilities')) as {
    capabilities: Array<{ name: string; readOnly: boolean }>;
  };
  const byName = new Map(result.capabilities.map((item) => [item.name, item]));
  assert.equal(byName.get('list_workflows')?.readOnly, true);
  assert.equal(byName.get('delete_workflow')?.readOnly, false);
});

test('runs can be deleted one at a time, or all at once', async () => {
  extension.online = false;
  forgetReachable();

  // Two runs of something local, so there is history to remove.
  for (const goal of ['First look', 'Second look']) {
    await call('run_steps', {
      goal,
      steps: [{ id: 's1', type: 'tool', tool: 'list_workflows', arguments: {}, output: 'library' }],
    });
  }

  const before = getRuns(50).length;
  assert.ok(before >= 2);
  const target = getRuns(50)[0];

  const one = (await call('delete_run', { runId: target.id })) as { deleted: number };
  assert.equal(one.deleted, 1);
  assert.equal(getRuns(50).length, before - 1);
  assert.ok(!getRuns(50).some((run) => run.id === target.id));

  await assert.rejects(() => call('delete_run', { runId: target.id }), /No run with id/);
  await assert.rejects(() => call('delete_run'), /needs a runId/);

  const all = (await call('delete_run', { all: true })) as { deleted: number; all: boolean };
  assert.equal(all.deleted, before - 1);
  assert.deepEqual(getRuns(50), []);

  // Clearing history must not touch the library.
  assert.ok(getWorkflows().length > 0, 'workflows survive a history wipe');
});
