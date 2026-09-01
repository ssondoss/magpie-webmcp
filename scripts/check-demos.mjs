import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

/**
 * Runs each demo app's script against a minimal DOM stub so the WebMCP tools they
 * register — names, schemas and return shapes — are verified without a browser.
 */

function stubElement() {
  const element = {
    innerHTML: '',
    textContent: '',
    hidden: false,
    addEventListener(_event, handler) {
      element.click = handler;
    },
  };
  return element;
}

function makeContext({ localStorage, DateImpl } = {}) {
  const elements = new Map();
  const tools = new Map();
  const modelContext = {
    registerTool(tool) {
      tools.set(tool.name, tool);
      return { unregister: () => tools.delete(tool.name) };
    },
    unregisterTool: (name) => tools.delete(name),
    provideContext(context) {
      tools.clear();
      for (const tool of context?.tools ?? []) tools.set(tool.name, tool);
    },
    listTools: () => [...tools.values()],
  };

  const context = {
    console,
    // Both locations, so the demos' `document.modelContext ?? navigator.modelContext`
    // resolution is exercised the same way it is in a browser.
    navigator: { modelContext },
    location: { origin: 'http://localhost:4321', hash: '' },
    document: {
      modelContext,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, stubElement());
        return elements.get(id);
      },
      querySelector: () => null,
      addEventListener: () => {},
    },
    window: {},
    Object,
    JSON,
    // Overridable so a demo's time-dependent behaviour (a quote expiring) can be
    // tested without waiting for it.
    Date: DateImpl ?? Date,
    Math,
    Array,
    Number,
    String,
    Error,
    localStorage: localStorage ?? {
      store: new Map(),
      getItem(key) {
        return this.store.get(key) ?? null;
      },
      setItem(key, value) {
        this.store.set(key, value);
      },
    },
  };
  context.globalThis = context;
  return { context, tools, elements };
}

async function run(file, options) {
  const source = await readFile(file, 'utf8');
  const { context, tools, elements } = makeContext(options ?? {});
  runInNewContext(source, context, { filename: file });
  return { tools, elements, context };
}

/** Every WebMCP descriptor must carry what the planner needs to use it. */
function assertDescriptor(tool, name) {
  assert.equal(tool.name, name, `${name} descriptor name`);
  assert.ok(tool.description.length > 20, `${name} needs a usable description`);
  assert.equal(tool.inputSchema.type, 'object', `${name} inputSchema must be an object schema`);
  assert.ok(tool.inputSchema.properties, `${name} inputSchema needs properties`);
  assert.equal(typeof tool.execute, 'function', `${name} needs an execute handler`);
}

function structured(result) {
  assert.ok(Array.isArray(result.content), 'result must carry MCP content');
  assert.ok(result.structuredContent, 'result must carry structuredContent');
  return result.structuredContent;
}

// --- Orders app --------------------------------------------------------------

{
  const { tools } = await run('demo/orders/app.js');
  assert.deepEqual([...tools.keys()], ['search_orders', 'get_order', 'get_customer']);
  assertDescriptor(tools.get('search_orders'), 'search_orders');
  assertDescriptor(tools.get('get_order'), 'get_order');
  assertDescriptor(tools.get('get_customer'), 'get_customer');

  // Deliberately no amount/minAmount parameter: value filtering is the agent's job.
  const searchProps = Object.keys(tools.get('search_orders').inputSchema.properties);
  assert.deepEqual(searchProps, ['status', 'customer', 'limit']);
  assert.ok(!searchProps.some((key) => /amount|value|total/i.test(key)));

  const delayed = structured(tools.get('search_orders').execute({ status: 'delayed' }));
  assert.ok(delayed.count > 0 && delayed.orders.length === delayed.count);
  assert.ok(delayed.orders.every((order) => order.status === 'delayed'));
  assert.ok(delayed.orders.every((order) => typeof order.amount === 'number'));

  const highValue = delayed.orders.filter((order) => order.amount > 5000);
  assert.ok(highValue.length >= 5, 'demo data must contain several delayed orders over $5,000');
  console.log(
    `[orders] ${delayed.count} delayed orders, ${highValue.length} over $5,000 ($${highValue
      .reduce((total, order) => total + order.amount, 0)
      .toLocaleString()} combined)`,
  );

  const order = structured(tools.get('get_order').execute({ orderId: delayed.orders[0].id }));
  assert.equal(order.id, delayed.orders[0].id);
  assert.throws(() => tools.get('get_order').execute({ orderId: 'nope' }), /No order with id/);

  const customer = structured(tools.get('get_customer').execute({ customerId: order.customerId }));
  assert.ok(customer.name && customer.orderCount > 0 && customer.totalValue > 0);
}

// --- Orders app: tool drift --------------------------------------------------

{
  const { tools, elements } = await run('demo/orders/app.js');
  elements.get('driftBtn').click();
  assert.ok(!tools.has('search_orders'), 'drift must remove search_orders');
  assertDescriptor(tools.get('find_orders'), 'find_orders');
  const found = structured(tools.get('find_orders').execute({ filters: { status: 'delayed' } }));
  assert.ok(found.count > 0);
  console.log('[orders] drift toggle swaps search_orders → find_orders');
}

// --- Support app -------------------------------------------------------------

{
  const store = new Map([['support-demo', JSON.stringify({ signedIn: true, tickets: [] })]]);
  const localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  const { tools, elements } = await run('demo/support/app.js', { localStorage });

  assert.deepEqual([...tools.keys()], ['create_ticket', 'list_tickets']);
  assertDescriptor(tools.get('create_ticket'), 'create_ticket');
  assert.equal(tools.get('create_ticket').annotations.readOnlyHint, false, 'create_ticket must declare a write');

  const ticket = structured(
    tools.get('create_ticket').execute({
      title: 'Delayed order SO-4801',
      description: 'Order SO-4801 for Acme Industrial (18400) is delayed.',
      priority: 'high',
      relatedOrderId: 'SO-4801',
    }),
  );
  assert.match(ticket.id, /^TKT-\d+$/);
  assert.equal(ticket.priority, 'high');
  assert.equal(ticket.relatedOrderId, 'SO-4801');
  assert.throws(() => tools.get('create_ticket').execute({ title: 'x' }), /requires both title and description/);

  const listed = structured(tools.get('list_tickets').execute({}));
  assert.equal(listed.count, 1);
  console.log(`[support] created ${ticket.id} and listed ${listed.count} ticket`);

  // Signing out withdraws every capability — the AUTH_REQUIRED case.
  elements.get('authBtn').click();
  assert.equal(tools.size, 0, 'signing out must withdraw all WebMCP tools');
  elements.get('authBtn').click();
  assert.equal(tools.size, 2, 'signing back in must republish them');
  console.log('[support] sign-out withdraws tools, sign-in republishes them');
}

/**
 * Each demo must announce a distinct provider name.
 *
 * The name is not cosmetic: the extension slugs it into the namespace every tool
 * on that site is addressed by, so two sites sharing a name would collide, and a
 * site whose name changes silently orphans any workflow saved against the old
 * one. It is also what a viewer reads on each node of the diagram, which is how
 * "these are four separate companies" comes across at all.
 */
{
  const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const seen = new Map();

  for (const app of ['orders', 'support']) {
    const html = await readFile(`demo/${app}/index.html`, 'utf8');
    const name = html.match(/<meta name="webmcp-provider" content="([^"]+)"/)?.[1];
    assert.ok(name, `demo/${app} must declare a webmcp-provider meta tag`);

    const key = slug(name);
    assert.ok(key, `demo/${app}'s provider name must survive slugging: "${name}"`);
    const clash = seen.get(key);
    assert.ok(!clash, `demo/${app} and demo/${clash} both slug to "${key}"`);
    seen.set(key, app);

    // The title should agree with the name, or the browser tab and the diagram
    // will disagree about what the site is called.
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    assert.equal(title, name, `demo/${app}: <title> and webmcp-provider must match`);
  }

  console.log(`[names] ${[...seen.keys()].join(', ')}`);
}

console.log('\ndemo apps OK');
