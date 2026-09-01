import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runResult, startRun, unresolvedTemplates } from '../src/background/engine';
import {
  buildCsv,
  buildIcs,
  eventWindow,
  globalCapabilities,
  testWebhook,
  whatsappNumber,
} from '../src/background/global-tools';
import { isTrustedPageOrigin } from '../src/shared/protocol';
import { applyTransform, evaluateCondition } from '../src/background/transform';
import { candidateProviderKey, inferRisk, schemaHash } from '../src/shared/capability';
import { tabMatchesOrigin } from '../src/background/resolver';
import { ReasonDeclined } from '../src/background/summary';
import { ensureProviderKey, mergeToolUrls } from '../src/background/registry';
import { planSchema, type Condition, type TransformStep, type WorkflowPlan } from '../src/shared/schema';
import type { Settings } from '../src/shared/types';
import {
  describeShape,
  getPath,
  normalizeHttpUrl,
  preview,
  resolveTemplates,
  toArray,
  variableName,
} from '../src/shared/util';

const ORDERS = [
  { id: 'SO-1', customer: 'Acme', status: 'delayed', amount: 18400, daysLate: 22 },
  { id: 'SO-2', customer: 'Dunder', status: 'delayed', amount: 940, daysLate: 20 },
  { id: 'SO-3', customer: 'Cobalt', status: 'shipped', amount: 7350, daysLate: 0 },
  { id: 'SO-4', customer: 'Bluewave', status: 'delayed', amount: 12250, daysLate: 18 },
];

const transform = (step: Partial<TransformStep> & Pick<TransformStep, 'operation' | 'input' | 'output'>): TransformStep =>
  ({ id: 't', type: 'transform', ...step }) as TransformStep;

const NO_WEBHOOK: Settings = {
  autoOpenSites: true,
  slackWebhookUrl: '',
  emailClient: 'gmail',
  calendarClient: 'google',
};

// --- engine harness ----------------------------------------------------------

/**
 * Minimal `chrome.*` stub so the engine can be exercised outside a browser: one
 * remembered site, live in tab 1, exposing search_orders.
 */
const LIVE_TOOL = {
  name: 'search_orders',
  description: 'Search orders. Returns { orders: [...], count }.',
  inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
  annotations: { title: 'Search orders', readOnlyHint: true },
};

let toolResponder: () => unknown = () => ({});

{
  const site = {
    origin: 'http://localhost:4321',
    provider: 'Orders',
    providerKey: 'orders',
    title: 'Orders',
    url: 'http://localhost:4321/',
    tools: [LIVE_TOOL],
    lastSeenAt: 1,
  };
  const local: Record<string, unknown> = {
    knownSites: { 'http://localhost:4321': site },
    providerKeys: { 'http://localhost:4321': { key: 'orders', from: 'name' } },
  };
  const session: Record<string, unknown> = {
    liveSites: { '1': { ...site, tabId: 1, providerName: 'Orders', updatedAt: 1 } },
  };
  const area = (store: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: store[key] }),
    set: async (patch: Record<string, unknown>) => {
      Object.assign(store, patch);
    },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area(local), session: area(session) },
    tabs: {
      query: async () => [{ id: 1, url: 'http://localhost:4321/' }],
      sendMessage: async () => ({ ok: true, value: toolResponder() }),
    },
  };
}

async function runPlanWithStubs(
  plan: WorkflowPlan,
  stubs: { tool: () => unknown; reason?: () => { keep?: number[]; value?: unknown; why?: string } },
) {
  toolResponder = stubs.tool;
  const snapshot = await startRun(
    { plan, prompt: 'test' },
    {
      approved: true,
      autoOpenSites: false,
      runPanelTask: async () => ({}),
      reason: async () => (stubs.reason?.() ?? { keep: [], why: '' }) as never,
      onUpdate: () => {},
    },
  );
  return { snapshot, final: runResult(snapshot.id)?.final };
}

// --- references and data plumbing -------------------------------------------

test('templates resolve whole values and inline strings', () => {
  const scope = { orders: ORDERS, item: ORDERS[0] };
  assert.deepEqual(resolveTemplates('{{orders}}', scope), ORDERS);
  assert.equal(resolveTemplates('Delayed order {{item.id}}', scope), 'Delayed order SO-1');
  assert.equal(resolveTemplates('{{orders.length}}', scope), 4);
  assert.deepEqual(resolveTemplates({ data: '{{orders}}', name: 'x-{{item.customer}}' }, scope), {
    data: ORDERS,
    name: 'x-Acme',
  });
  assert.equal(resolveTemplates('{{nope}}', scope), null);
});

test('variable references accept both {{name}} and name', () => {
  assert.equal(variableName('{{highValueOrders}}'), 'highValueOrders');
  assert.equal(variableName('highValueOrders'), 'highValueOrders');
  assert.equal(getPath({ a: { b: [1, 2] } }, 'a.b.1'), 2);
});

test('tool results shaped as { orders: [...] } are treated as arrays', () => {
  assert.equal(toArray({ orders: ORDERS, count: 4 }).length, 4);
  assert.equal(toArray({ items: [1, 2, 3] }).length, 3);
  assert.equal(toArray(ORDERS[0]).length, 1);
  assert.equal(toArray(null).length, 0);
});

test('step previews summarise results instead of dumping raw JSON', () => {
  // What search_orders actually returns: an object wrapping the collection.
  assert.equal(
    preview({ orders: ORDERS, count: 4 }),
    '4 results: SO-1, SO-2, SO-3, SO-4',
  );
  assert.equal(preview(ORDERS.slice(0, 1)), '1 result: SO-1');
  assert.equal(preview({ orders: [], count: 0 }), 'no results');
  assert.equal(preview(null), 'no value');
  // Scalar summaries (from a summarize step) stay readable.
  assert.equal(preview({ count: 9, total: 122150 }), 'count: 9, total: 122150');
  // Long collections are capped.
  const many = Array.from({ length: 20 }, (_, index) => ({ id: `SO-${index}` }));
  assert.match(preview(many), /^20 results: SO-0, .*, \+14 more$/);

  // A status object that happens to contain an array is described by its fields,
  // not by unwrapping the array — export_csv returns {filename, rowCount, columns}.
  assert.equal(
    preview({ filename: 'orders.csv', rowCount: 9, columns: ['id', 'amount'] }),
    'filename: orders.csv, rowCount: 9',
  );
});

// --- local transforms --------------------------------------------------------

test('filter keeps only matching rows, including currency-formatted numbers', () => {
  const step = transform({
    operation: 'filter',
    input: 'orders',
    output: 'high',
    condition: { field: 'amount', operator: '>', value: 5000 },
  });
  const result = applyTransform(step, { orders: ORDERS, count: 4 }, {}) as typeof ORDERS;
  assert.deepEqual(result.map((order) => order.id), ['SO-1', 'SO-3', 'SO-4']);

  assert.ok(evaluateCondition({ amount: '$5,400.00' }, { field: 'amount', operator: '>', value: 5000 }));
  assert.ok(!evaluateCondition({ amount: '$400' }, { field: 'amount', operator: '>', value: 5000 }));
});

test('nested conditions combine with all/any/not', () => {
  const step = transform({
    operation: 'filter',
    input: 'orders',
    output: 'out',
    condition: {
      all: [
        { field: 'status', operator: '==', value: 'delayed' },
        { field: 'amount', operator: '>=', value: 5000 },
      ],
    },
  });
  const result = applyTransform(step, ORDERS, {}) as typeof ORDERS;
  assert.deepEqual(result.map((order) => order.id), ['SO-1', 'SO-4']);
});

test('sort, limit, unique, pick and map behave', () => {
  const sorted = applyTransform(
    transform({ operation: 'sort', input: 'o', output: 'o2', field: 'amount', direction: 'desc' }),
    ORDERS,
    {},
  ) as typeof ORDERS;
  assert.deepEqual(sorted.map((order) => order.id), ['SO-1', 'SO-4', 'SO-3', 'SO-2']);

  const limited = applyTransform(transform({ operation: 'limit', input: 'o', output: 'o2', count: 2 }), ORDERS, {});
  assert.equal((limited as unknown[]).length, 2);

  const unique = applyTransform(
    transform({ operation: 'unique', input: 'o', output: 'o2', field: 'status' }),
    ORDERS,
    {},
  ) as typeof ORDERS;
  assert.deepEqual(unique.map((order) => order.status), ['delayed', 'shipped']);

  const picked = applyTransform(
    transform({ operation: 'pick', input: 'o', output: 'o2', fields: ['id', 'amount'] }),
    ORDERS,
    {},
  );
  assert.deepEqual((picked as Array<Record<string, unknown>>)[0], { id: 'SO-1', amount: 18400 });

  const mapped = applyTransform(
    transform({
      operation: 'map',
      input: 'o',
      output: 'o2',
      mapping: { order: '{{item.id}}', who: '{{item.customer}}' },
    }),
    ORDERS,
    {},
  );
  assert.deepEqual((mapped as Array<Record<string, unknown>>)[1], { order: 'SO-2', who: 'Dunder' });
});

test('summarize computes metrics and can group', () => {
  const summary = applyTransform(
    transform({
      operation: 'summarize',
      input: 'o',
      output: 'stats',
      metrics: [
        { op: 'count', as: 'orders' },
        { op: 'sum', field: 'amount', as: 'total' },
        { op: 'max', field: 'amount', as: 'largest' },
      ],
    }),
    ORDERS,
    {},
  );
  assert.deepEqual(summary, { orders: 4, total: 38940, largest: 18400 });

  const grouped = applyTransform(
    transform({
      operation: 'summarize',
      input: 'o',
      output: 'stats',
      groupBy: 'status',
      metrics: [{ op: 'count', as: 'n' }],
    }),
    ORDERS,
    {},
  );
  assert.deepEqual(grouped, { delayed: { n: 3 }, shipped: { n: 1 } });
});

test('a transform with a missing condition fails loudly', () => {
  assert.throws(
    () => applyTransform(transform({ operation: 'filter', input: 'o', output: 'x' }), ORDERS, {}),
    /requires a condition/,
  );
});

// --- plan contract -----------------------------------------------------------

test('planSchema validates a well-formed plan and rejects a bad one', () => {
  const plan = {
    name: 'High-value delayed orders',
    status: 'SUPPORTED',
    steps: [
      { id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: { status: 'delayed' }, output: 'orders' },
      {
        id: 's2',
        type: 'transform',
        operation: 'filter',
        input: 'orders',
        output: 'high',
        condition: { field: 'amount', operator: '>', value: 5000 },
      },
    ],
    finalOutput: 'high',
  };
  const parsed = planSchema.safeParse(plan);
  assert.ok(parsed.success);
  assert.equal(parsed.data?.missingCapabilities.length, 0);

  assert.ok(!planSchema.safeParse({ ...plan, steps: [{ id: 'x', type: 'javascript', code: 'fetch()' }] }).success);
  assert.ok(
    !planSchema.safeParse({
      ...plan,
      steps: [{ id: 's1', type: 'transform', operation: 'sideload', input: 'a', output: 'b' }],
    }).success,
  );
});

test('csv export quotes correctly and keeps a stable column order', () => {
  const { csv, columns, rowCount } = buildCsv([
    { id: 'SO-1', note: 'delayed, again', amount: 18400 },
    { id: 'SO-2', note: 'says "urgent"', amount: 940 },
  ]);
  assert.deepEqual(columns, ['id', 'note', 'amount']);
  assert.equal(rowCount, 2);
  assert.deepEqual(csv.split('\r\n'), [
    'id,note,amount',
    'SO-1,"delayed, again",18400',
    'SO-2,"says ""urgent""",940',
  ]);
});

test('global tools are registered as extension capabilities', () => {
  const capabilities = globalCapabilities(NO_WEBHOOK);
  assert.deepEqual(capabilities.map((item) => item.id), [
    'global.export_csv',
    'global.download_file',
    'global.copy_to_clipboard',
    'global.compose_email',
    'global.create_calendar_event',
    'global.send_whatsapp_message',
    'global.send_slack_message',
    'global.notify',
    'global.open_url',
  ]);
  assert.ok(capabilities.every((item) => item.source === 'extension'));

  // Only tools whose side effects stay on this machine skip the approval gate.
  const outward = capabilities.filter((item) => !item.local).map((item) => item.name);
  assert.deepEqual(outward, [
    'compose_email',
    'create_calendar_event',
    'send_whatsapp_message',
    'send_slack_message',
  ]);

  // The two drafting tools need no setup, so they must never park on AUTH_REQUIRED
  // the way send_slack_message does without a webhook.
  const whatsapp = capabilities.find((item) => item.name === 'send_whatsapp_message');
  assert.equal(whatsapp?.status, 'AVAILABLE');
  assert.equal(capabilities.find((item) => item.name === 'send_slack_message')?.status, 'AUTH_REQUIRED');
});

test('a provider namespace never changes once assigned', async () => {
  const origin = 'https://demos.example.test';

  // First seen with no declared provider name, so the key comes from the hostname.
  const first = await ensureProviderKey(origin, '');
  assert.equal(first, 'demos');

  // A page on the same origin later declares a name. Adopting it would produce a
  // tidier namespace and orphan every workflow already referencing `demos.*` —
  // with no way back, since nothing maps a dead key to an origin.
  assert.equal(await ensureProviderKey(origin, 'Example Demos'), first);
  assert.equal(await ensureProviderKey(origin, 'Something Else Entirely'), first);
});

test('tool URLs accumulate across the apps an origin serves', () => {
  const tool = (name: string) => ({ name, description: '', inputSchema: {} });
  const demos = 'https://googlechromelabs.github.io/webmcp-tools/demos';

  // One origin, two apps on different paths. Visiting the second must not erase
  // where the first one lives — that is the whole point of remembering.
  const afterOrders = mergeToolUrls(undefined, [tool('get_order_status')], `${demos}/order-tracking/`);
  const afterPizza = mergeToolUrls(afterOrders, [tool('make_pizza')], `${demos}/pizza-maker/`);

  assert.equal(afterPizza.get_order_status, `${demos}/order-tracking/`);
  assert.equal(afterPizza.make_pizza, `${demos}/pizza-maker/`);

  // A tool that moves is re-pointed rather than duplicated.
  const moved = mergeToolUrls(afterPizza, [tool('get_order_status')], `${demos}/orders-v2/`);
  assert.equal(moved.get_order_status, `${demos}/orders-v2/`);
  assert.equal(Object.keys(moved).length, 2);
});

test('a tab mid-redirect still counts as being on the origin', () => {
  const origin = 'https://www.aloyoga.com';

  // The committed case.
  assert.ok(tabMatchesOrigin({ url: 'https://www.aloyoga.com/' }, origin));
  // A locale redirect lands on a different path, same origin.
  assert.ok(tabMatchesOrigin({ url: 'https://www.aloyoga.com/ar-jo/' }, origin));

  // The case that caused duplicate tabs: nothing committed yet, destination known
  // only from pendingUrl.
  assert.ok(tabMatchesOrigin({ url: 'about:blank', pendingUrl: 'https://www.aloyoga.com/ar-jo/' }, origin));
  assert.ok(tabMatchesOrigin({ pendingUrl: 'https://www.aloyoga.com/' }, origin));

  assert.ok(!tabMatchesOrigin({ url: 'https://www.awaytravel.com/' }, origin));
  // A host that merely contains the origin must not match.
  assert.ok(!tabMatchesOrigin({ url: 'https://www.aloyoga.com.evil.test/' }, origin));
  // www is part of the origin, so the bare host is a different site.
  assert.ok(!tabMatchesOrigin({ url: 'https://aloyoga.com/' }, origin));

  // Unparseable or absent URLs are not matches, and must not throw.
  assert.ok(!tabMatchesOrigin({ url: 'about:blank' }, origin));
  assert.ok(!tabMatchesOrigin({ url: 'chrome://newtab/' }, origin));
  assert.ok(!tabMatchesOrigin({}, origin));
});

test('eventWindow resolves a window from an end or a duration', () => {
  const fromDuration = eventWindow({ start: '2026-09-01T09:00:00Z', durationMinutes: 45 });
  assert.equal(fromDuration.start.toISOString(), '2026-09-01T09:00:00.000Z');
  assert.equal(fromDuration.end.toISOString(), '2026-09-01T09:45:00.000Z');

  // No duration given: half an hour is the useful default for a follow-up call.
  assert.equal(
    eventWindow({ start: '2026-09-01T09:00:00Z' }).end.toISOString(),
    '2026-09-01T09:30:00.000Z',
  );

  const explicit = eventWindow({ start: '2026-09-01T09:00:00Z', end: '2026-09-01T10:15:00Z' });
  assert.equal(explicit.end.toISOString(), '2026-09-01T10:15:00.000Z');
});

test('eventWindow refuses a date with no time rather than booking 3 AM', () => {
  // An agent that drops the time would otherwise schedule midnight and look
  // deliberate about it.
  assert.throws(() => eventWindow({ start: '2026-09-01' }), /needs a time of day/);

  assert.throws(() => eventWindow({ start: '' }), /needs a start time/);
  assert.throws(() => eventWindow({ start: 'next tuesday' }), /could not read the start time/);
  assert.throws(
    () => eventWindow({ start: '2026-09-01T09:00:00Z', end: '2026-09-01T08:00:00Z' }),
    /at or before the start/,
  );
  assert.throws(
    () => eventWindow({ start: '2026-09-01T09:00:00Z', durationMinutes: 0 }),
    /positive durationMinutes/,
  );
});

test('buildIcs emits an importable VEVENT', () => {
  const ics = buildIcs({
    title: 'Follow-up: order SO-1',
    start: new Date('2026-09-01T09:00:00Z'),
    end: new Date('2026-09-01T09:30:00Z'),
    description: 'Delayed 22 days',
    location: 'https://example.com/call',
    attendees: ['ops@acme.test'],
  });

  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.ok(ics.includes('DTSTART:20260901T090000Z'));
  assert.ok(ics.includes('DTEND:20260901T093000Z'));
  assert.ok(ics.includes('ATTENDEE;RSVP=TRUE:mailto:ops@acme.test'));

  // Commas are iCalendar delimiters, so an unescaped one splits the field and the
  // event imports with a truncated title.
  const comma = buildIcs({
    title: 'Review Q3, then plan Q4',
    start: new Date('2026-09-01T09:00:00Z'),
    end: new Date('2026-09-01T09:30:00Z'),
    attendees: [],
  });
  assert.ok(comma.includes('SUMMARY:Review Q3\\, then plan Q4'));

  // Every line must be CRLF-terminated; a bare LF is rejected by some clients.
  for (const line of ics.split('\r\n').filter(Boolean)) {
    assert.ok(!line.includes('\n'), `line contains a bare LF: ${line}`);
  }
});

test('whatsappNumber accepts human formatting and rejects unreachable numbers', () => {
  // However a number arrives on a page, wa.me needs bare digits.
  assert.equal(whatsappNumber('+971 50 123 4567'), '971501234567');
  assert.equal(whatsappNumber('+1 (415) 555-0132'), '14155550132');
  assert.equal(whatsappNumber('971501234567'), '971501234567');

  // A trunk prefix would silently resolve to the wrong country, so it must throw
  // rather than reach a stranger.
  assert.throws(() => whatsappNumber('050 123 4567'), /country code/);

  assert.throws(() => whatsappNumber('12345'), /8 to 15/);
  assert.throws(() => whatsappNumber('1234567890123456'), /8 to 15/);
  assert.throws(() => whatsappNumber(''), /needs a phone number/);
  assert.throws(() => whatsappNumber('not a number'), /needs a phone number/);
});

test('a webhook URL pasted with the page button label attached is cleaned up', () => {
  // What you get selecting the URL on webhook.site next to its copy button.
  assert.equal(
    normalizeHttpUrl('https://webhook.site/9dd82418-cca0-4535 Copy to clipboard'),
    'https://webhook.site/9dd82418-cca0-4535',
  );
  assert.equal(
    normalizeHttpUrl('  https://hooks.slack.com/services/T/B/x  '),
    'https://hooks.slack.com/services/T/B/x',
  );
  assert.equal(normalizeHttpUrl('not a url'), '');
  assert.equal(normalizeHttpUrl('javascript:alert(1)'), '');
  assert.equal(normalizeHttpUrl(''), '');
});

test('the webhook test posts a real message and reports what came back', async () => {
  const realFetch = globalThis.fetch;
  let sent: unknown = null;

  try {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const good = await testWebhook('https://hooks.slack.com/services/T/B/x');
    assert.equal(good.ok, true);
    assert.match(good.message, /Delivered to hooks\.slack\.com/);
    assert.match((sent as { text: string }).text, /Magpie/);

    globalThis.fetch = (async () => new Response('no_service', { status: 404 })) as typeof fetch;
    const missing = await testWebhook('https://hooks.slack.com/services/T/B/x');
    assert.equal(missing.ok, false);
    assert.match(missing.message, /rejected it \(404\): no_service/);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal((await testWebhook('')).ok, false);
});

test('concurrent settings writes do not discard each other', async () => {
  const { getSettings, setSettings } = await import('../src/background/storage');

  // Two overlapping read-modify-write cycles: without serialising, the second
  // reads the same "before" as the first and drops its change.
  await Promise.all([
    setSettings({ autoOpenSites: false }),
    setSettings({ slackWebhookUrl: 'https://hooks.slack.com/services/T/B/x' }),
    setSettings({ emailClient: 'mailto' }),
  ]);

  const settings = await getSettings();
  assert.equal(settings.autoOpenSites, false);
  assert.equal(settings.slackWebhookUrl, 'https://hooks.slack.com/services/T/B/x');
  assert.equal(settings.emailClient, 'mailto');
});

test('a tool awaiting setup reports AUTH_REQUIRED rather than failing mid-run', () => {
  const unconfigured = globalCapabilities(NO_WEBHOOK).find((item) => item.name === 'send_slack_message');
  assert.equal(unconfigured?.status, 'AUTH_REQUIRED');
  assert.match(unconfigured?.statusDetail ?? '', /Settings/);

  const configured = globalCapabilities({
    ...NO_WEBHOOK,
    slackWebhookUrl: 'https://hooks.slack.com/services/T/B/x',
  }).find((item) => item.name === 'send_slack_message');
  assert.equal(configured?.status, 'AVAILABLE');

  // Tools with no setup are unaffected either way.
  assert.equal(globalCapabilities().find((item) => item.name === 'export_csv')?.status, 'AVAILABLE');
});

// --- registry metadata -------------------------------------------------------

test('risk is inferred from annotations first, then the tool name', () => {
  assert.equal(inferRisk({ name: 'search_orders', description: '', inputSchema: {} }), 'read');
  assert.equal(inferRisk({ name: 'create_ticket', description: '', inputSchema: {} }), 'write');
  assert.equal(inferRisk({ name: 'refund_order', description: '', inputSchema: {} }), 'destructive');
  assert.equal(
    inferRisk({ name: 'delete_everything', description: '', inputSchema: {}, annotations: { readOnlyHint: true } }),
    'read',
  );
});

test('localhost demo apps on different ports get distinct namespaces', () => {
  assert.equal(candidateProviderKey('http://localhost:4321', 'Orders'), 'orders');
  assert.equal(candidateProviderKey('http://localhost:4322', 'Support'), 'support');
  assert.equal(candidateProviderKey('http://localhost:4321'), 'local_4321');
  assert.equal(candidateProviderKey('http://localhost:4322'), 'local_4322');
  assert.equal(candidateProviderKey('https://orders.example.com'), 'orders');
  // "global" is reserved for extension tools.
  assert.equal(candidateProviderKey('https://x.com', 'global'), 'global_site');
});

test('a reference into the wrong shape fails with what the variable actually holds', async () => {
  const plan = planSchema.parse({
    name: 'Wrong shape',
    status: 'SUPPORTED',
    steps: [
      { id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'result' },
      // search_orders returns { orders: [...], count } — this path does not exist.
      {
        id: 's2',
        type: 'tool',
        tool: 'orders.search_orders',
        arguments: { customer: '{{result.0.customer}}' },
        output: 'detail',
      },
    ],
  }) as WorkflowPlan;

  const run = await runPlanWithStubs(plan, { tool: () => ({ orders: ORDERS, count: ORDERS.length }) });
  assert.equal(run.snapshot.status, 'failed');
  const failed = run.snapshot.steps[1];
  assert.equal(failed.status, 'error');
  // Not "No order with id null" — say which reference broke and what is there.
  assert.match(failed.error ?? '', /\{\{result\.0\.customer\}\}/);
  assert.match(failed.error ?? '', /"result" contains: orders, count/);
});

test('unresolvedTemplates finds only genuinely missing paths', () => {
  const scope = { orders: { orders: ORDERS, count: 4 }, item: ORDERS[0] };
  assert.deepEqual(unresolvedTemplates({ a: '{{orders.count}}' }, scope), []);
  assert.deepEqual(unresolvedTemplates({ a: '{{item.id}}' }, scope), []);
  assert.deepEqual(unresolvedTemplates({ a: 'plain text' }, scope), []);
  assert.deepEqual(unresolvedTemplates({ a: '{{orders.0.id}}' }, scope), ['orders.0.id']);
  assert.deepEqual(unresolvedTemplates({ nested: { deep: ['{{nope}}'] } }, scope), ['nope']);
});

test('only exact trusted origins may drive the extension', () => {
  assert.ok(isTrustedPageOrigin('http://localhost:4173'));
  // www and the apex are different origins, and the host decides which one a
  // visitor lands on. Both are ours, so both are trusted.
  assert.ok(isTrustedPageOrigin('https://magpie.help'));
  assert.ok(isTrustedPageOrigin('https://www.magpie.help'));
  assert.ok(isTrustedPageOrigin('https://magpie-webmcp.vercel.app'));

  // A subdomain we did not list is still a different site.
  assert.ok(!isTrustedPageOrigin('https://orders.magpie.help'));
  assert.ok(!isTrustedPageOrigin('https://magpie.help.evil.test'));

  // A prefix or suffix test would let an attacker register a matching hostname.
  assert.ok(!isTrustedPageOrigin('https://magpie-webmcp.vercel.app.evil.com'));
  assert.ok(!isTrustedPageOrigin('https://evil.com/https://magpie-webmcp.vercel.app'));
  assert.ok(!isTrustedPageOrigin('https://magpie-webmcp.vercel.app:8443'));
  assert.ok(!isTrustedPageOrigin('http://magpie-webmcp.vercel.app'), 'scheme is part of the origin');
  assert.ok(
    !isTrustedPageOrigin('https://magpie-webmcp.vercel.app/'),
    'an origin carries no trailing slash',
  );

  // Vercel gives every deployment its own hostname. Only the production alias is
  // trusted, so a preview build cannot drive the extension.
  assert.ok(!isTrustedPageOrigin('https://magpie-webmcp-git-main.vercel.app'));

  // Anything malformed or absent is untrusted.
  for (const value of ['', 'null', 'undefined', undefined]) {
    assert.ok(!isTrustedPageOrigin(value as string | undefined));
  }
});

test('a select reason step can only narrow the data, never rewrite it', async () => {
  const plan = planSchema.parse({
    name: 'Supplier delays',
    status: 'SUPPORTED',
    steps: [
      { id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'orders' },
      {
        id: 's2',
        type: 'reason',
        input: 'orders',
        instruction: 'Keep the ones that look like supplier problems',
        output: 'supplierDelays',
      },
    ],
    finalOutput: 'supplierDelays',
  }) as WorkflowPlan;

  // The model tries to keep index 1 while also rewriting the row and adding a fake one.
  const run = await runPlanWithStubs(plan, {
    tool: () => ({ orders: ORDERS, count: ORDERS.length }),
    reason: () => ({ keep: [1, 99], value: [{ id: 'FAKE', amount: 999999 }], why: 'supplier delay' }),
  });

  assert.equal(run.snapshot.status, 'completed');
  // Only the real row at index 1 survives; the invented row is discarded and the
  // out-of-range index ignored.
  assert.deepEqual(run.final, [ORDERS[1]]);
  assert.match(run.snapshot.steps[1].preview ?? '', /4 → 1 result: SO-2 — supplier delay/);
});

test('reason steps default to select mode and are tagged as model steps', () => {
  const step = planSchema.parse({
    name: 'x',
    status: 'SUPPORTED',
    steps: [
      { id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'o' },
      { id: 's2', type: 'reason', input: 'o', instruction: 'pick the urgent ones', output: 'u' },
    ],
  }).steps[1];
  assert.equal(step.type === 'reason' && step.mode, 'select');
});

test('a derive reason step stores whatever the model produced', async () => {
  const plan = planSchema.parse({
    name: 'Summarise',
    status: 'SUPPORTED',
    steps: [
      { id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'orders' },
      {
        id: 's2',
        type: 'reason',
        mode: 'derive',
        input: 'orders',
        instruction: 'Summarise the delay pattern',
        output: 'summary',
      },
    ],
    finalOutput: 'summary',
  }) as WorkflowPlan;

  const run = await runPlanWithStubs(plan, {
    tool: () => ({ orders: ORDERS, count: ORDERS.length }),
    reason: () => ({ value: { pattern: 'mostly cold-chain', affected: 3 }, why: 'grouped by items' }),
  });
  assert.deepEqual(run.final, { pattern: 'mostly cold-chain', affected: 3 });
});

// --- gate steps --------------------------------------------------------------

/** Two tool steps standing in for a price feed and an account balance, then a purchase. */
function watchPlan(condition: Condition): WorkflowPlan {
  return planSchema.parse({
    name: 'Buy BTC when gold breaks $3,500',
    status: 'SUPPORTED',
    steps: [
      { id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'spot' },
      { id: 's2', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'balances' },
      { id: 's3', type: 'gate', condition },
      { id: 's4', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'trade' },
    ],
    finalOutput: 'trade',
  }) as WorkflowPlan;
}

const GOLD_AND_CASH: Condition = {
  all: [
    { field: 'spot.quotes.0.price', operator: '>', value: 3500 },
    { field: 'balances.available.USD', operator: '>=', value: 1000 },
  ],
};

/** Feeds each tool step a different result, so a gate can span two "sites". */
function feed(...responses: unknown[]): { calls: () => number; tool: () => unknown } {
  let index = 0;
  return {
    calls: () => index,
    tool: () => responses[index++] ?? {},
  };
}

test('a gate that holds lets the rest of the workflow run', async () => {
  const stub = feed(
    { quotes: [{ symbol: 'XAU/USD', price: 3685.5 }] },
    { available: { USD: 1240 } },
    { tradeId: 'T-1001', received: 0.0155 },
  );
  const run = await runPlanWithStubs(watchPlan(GOLD_AND_CASH), { tool: stub.tool });

  assert.equal(run.snapshot.status, 'completed');
  assert.equal(stub.calls(), 3, 'the purchase runs once the condition holds');
  assert.equal(run.snapshot.steps[2].status, 'ok');
  assert.match(run.snapshot.steps[2].preview ?? '', /3685\.5 > 3500 ✓ and .*1240 >= 1000 ✓/);
  assert.deepEqual(run.final, { tradeId: 'T-1001', received: 0.0155 });
});

test('a gate fails closed when the data it checks never arrived', async () => {
  // "price < 3500" against no price at all must not pass by accident.
  const stub = feed({ quotes: [] }, { available: { USD: 1240 } });
  const plan = planSchema.parse({
    name: 'Buy the dip',
    status: 'SUPPORTED',
    steps: [
      { id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'balances' },
      { id: 's2', type: 'gate', condition: { field: 'spot.quotes.0.price', operator: '<', value: 3500 } },
      { id: 's3', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'trade' },
    ],
  }) as WorkflowPlan;

  const run = await runPlanWithStubs(plan, { tool: stub.tool });
  assert.equal(run.snapshot.status, 'conditions_not_met');
  assert.equal(stub.calls(), 1);
  assert.match(run.snapshot.steps[1].preview ?? '', /nothing produced spot/);
});

test('a declined reason step stops the run without failing it', async () => {
  const plan = planSchema.parse({
    name: 'Email the worst offender',
    status: 'SUPPORTED',
    steps: [
      { id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'rows' },
      { id: 's2', type: 'reason', input: 'rows', mode: 'select', instruction: 'Pick the worst', output: 'worst' },
      { id: 's3', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'sent' },
    ],
  }) as WorkflowPlan;

  const run = await runPlanWithStubs(plan, {
    tool: () => ({ orders: ORDERS, count: 4 }),
    // What production actually injects: no model, so the question goes back.
    reason: () => {
      throw new ReasonDeclined('"Pick the worst" is a judgement Magpie does not make on its own.');
    },
  });

  // A handoff is not a crash. This is the distinction the whole reason-step design
  // rests on, so it is pinned rather than left to the status mapping.
  assert.equal(run.snapshot.status, 'needs_judgement');
  assert.notEqual(run.snapshot.status, 'failed');

  assert.equal(run.snapshot.steps[0].status, 'ok');
  assert.equal(run.snapshot.steps[1].status, 'skipped');
  assert.match(run.snapshot.steps[1].preview ?? '', /4 rows ready to judge/);

  // Steps below were never reached, and must not read as broken.
  assert.equal(run.snapshot.steps[2].status, 'skipped');
  assert.match(run.snapshot.steps[2].error ?? '', /Not reached/);
});

test('a reason implementation that genuinely breaks still fails the run', async () => {
  const plan = planSchema.parse({
    name: 'Email the worst offender',
    status: 'SUPPORTED',
    steps: [
      { id: 's1', type: 'tool', tool: 'orders.search_orders', arguments: {}, output: 'rows' },
      { id: 's2', type: 'reason', input: 'rows', mode: 'select', instruction: 'Pick the worst', output: 'worst' },
    ],
  }) as WorkflowPlan;

  const run = await runPlanWithStubs(plan, {
    tool: () => ({ orders: ORDERS, count: 4 }),
    reason: () => {
      throw new Error('the model backend is down');
    },
  });

  assert.equal(run.snapshot.status, 'failed');
  assert.equal(run.snapshot.steps[1].status, 'error');
  assert.match(run.snapshot.steps[1].error ?? '', /model backend is down/);
});

test('describeShape summarises collections, objects and scalars', () => {
  const rows = describeShape({ orders: ORDERS, count: 4 });
  assert.equal(rows?.rows, 4);
  assert.deepEqual(rows?.fields, ['id', 'customer', 'status', 'amount', 'daysLate']);
  assert.equal(rows?.sample?.length, 2);

  assert.deepEqual(describeShape({ orders: [], count: 0 }), { rows: 0 });
  assert.deepEqual(describeShape({ total: 122150, count: 9 })?.fields, ['total', 'count']);
  assert.equal(describeShape(undefined), undefined);
  assert.equal(describeShape(null), undefined);
});

test('schema hashing ignores key order so drift detection has no false positives', () => {
  const a = schemaHash({ type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } });
  const b = schemaHash({ properties: { a: { type: 'number' }, b: { type: 'string' } }, type: 'object' });
  assert.equal(a, b);
  assert.notEqual(a, schemaHash({ type: 'object', properties: { a: { type: 'string' } } }));
});
