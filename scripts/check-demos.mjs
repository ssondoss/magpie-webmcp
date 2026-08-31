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

// --- Metals app --------------------------------------------------------------

{
  const { tools, elements } = await run('demo/metals/app.js');
  assert.deepEqual([...tools.keys()], ['list_instruments', 'get_spot', 'get_history']);
  assertDescriptor(tools.get('list_instruments'), 'list_instruments');
  assertDescriptor(tools.get('get_spot'), 'get_spot');
  assertDescriptor(tools.get('get_history'), 'get_history');

  // No threshold or alert parameter: comparing a price is the agent's job, which
  // is what makes the gate step necessary.
  const spotProps = Object.keys(tools.get('get_spot').inputSchema.properties);
  assert.deepEqual(spotProps, ['symbols']);
  assert.ok(!spotProps.some((key) => /alert|threshold|above|below|watch/i.test(key)));

  const all = structured(tools.get('list_instruments').execute({}));
  assert.ok(all.count >= 4 && all.instruments.every((entry) => entry.symbol && entry.name));

  const gold = structured(tools.get('get_spot').execute({ symbols: ['XAU/USD'] }));
  assert.equal(gold.count, 1);
  assert.equal(gold.quotes[0].symbol, 'XAU/USD');
  assert.equal(typeof gold.quotes[0].price, 'number');
  // The demo condition is "gold above 3,500". It must NOT already hold at seed
  // prices, or the interesting branch can never be shown.
  assert.ok(gold.quotes[0].price < 3500, 'seed gold price must sit below the demo threshold');

  const every = structured(tools.get('get_spot').execute({}));
  assert.equal(every.count, all.count, 'omitting symbols must price every instrument');
  assert.throws(() => tools.get('get_spot').execute({ symbols: ['XCU/USD'] }), /Not priced here/);

  const history = structured(tools.get('get_history').execute({ symbol: 'XAU/USD', days: 14 }));
  assert.equal(history.closes.length, 14);
  assert.ok(history.closes[0].date < history.closes[13].date, 'closes must be oldest first');
  assert.equal(history.closes[13].close, gold.quotes[0].price, 'the newest close is the current spot');
  assert.ok(history.high >= history.average && history.average >= history.low);

  // The control that makes the workflow fire on camera.
  elements.get('spikeBtn').click();
  const spiked = structured(tools.get('get_spot').execute({ symbols: ['XAU/USD'] }));
  assert.ok(spiked.quotes[0].price > 3500, 'a spike must carry gold over the demo threshold');
  assert.ok(spiked.quotes[0].changePct > 0);

  elements.get('resetBtn').click();
  const reset = structured(tools.get('get_spot').execute({ symbols: ['XAU/USD'] }));
  assert.equal(reset.quotes[0].price, gold.quotes[0].price, 'reset must restore the seed price');
  console.log(
    `[metals] gold ${gold.quotes[0].price} → ${spiked.quotes[0].price} after a spike, ${history.closes.length} closes`,
  );
}

// --- Crypto Desk app ---------------------------------------------------------

{
  // A controllable clock, so quote expiry is tested rather than assumed.
  let clock = Date.parse('2026-08-30T09:00:00.000Z');
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length > 0 ? args : [clock]));
    }
    static now() {
      return clock;
    }
  }

  const { tools, elements } = await run('demo/crypto/app.js', { DateImpl: FixedDate });
  assert.deepEqual([...tools.keys()], ['get_balances', 'get_quote', 'execute_quote', 'list_trades']);
  for (const name of ['get_balances', 'get_quote', 'execute_quote', 'list_trades']) {
    assertDescriptor(tools.get(name), name);
  }

  // The deliberate hole: nothing here can move money off the desk, so asking to
  // withdraw must surface as a missing capability rather than an invented one.
  for (const forbidden of ['withdraw', 'add_withdrawal_address', 'create_api_key', 'transfer']) {
    assert.ok(!tools.has(forbidden), `${forbidden} must not be exposed to agents`);
  }

  assert.equal(tools.get('get_quote').annotations.readOnlyHint, true, 'quoting moves no money');
  assert.equal(tools.get('execute_quote').annotations.readOnlyHint, false);
  assert.equal(tools.get('execute_quote').annotations.destructiveHint, true, 'buying spends real money');
  assert.deepEqual(Object.keys(tools.get('execute_quote').inputSchema.properties), [
    'quoteId',
    'idempotencyKey',
  ]);
  // Spread: arrays built inside the VM realm are not reference-comparable here.
  assert.deepEqual([...tools.get('execute_quote').inputSchema.required], ['quoteId', 'idempotencyKey']);

  const opening = structured(tools.get('get_balances').execute({}));
  assert.ok(opening.available.USD >= 1000, 'seed account must satisfy the demo balance condition');
  assert.equal(opening.quoteCurrency, 'USD');

  const quote = structured(tools.get('get_quote').execute({ fromAsset: 'USD', toAsset: 'BTC', amount: 1000 }));
  assert.match(quote.quoteId, /^Q-\d+$/);
  assert.ok(quote.receives > 0 && quote.feeUsd > 0);
  assert.ok(Date.parse(quote.expiresAt) > clock, 'a quote must expire in the future');
  // Quoting must not have moved anything.
  assert.equal(structured(tools.get('get_balances').execute({})).available.USD, opening.available.USD);

  const trade = structured(
    tools.get('execute_quote').execute({ quoteId: quote.quoteId, idempotencyKey: 'gold-btc-1' }),
  );
  assert.match(trade.tradeId, /^T-\d+$/);
  assert.equal(trade.replay, false);
  assert.equal(trade.spent, 1000);
  assert.equal(trade.received, quote.receives);

  const after = structured(tools.get('get_balances').execute({}));
  assert.equal(after.available.USD, opening.available.USD - 1000);
  assert.ok(after.available.BTC > opening.available.BTC);

  // Idempotency: the same key must report the original trade, not buy again.
  const replay = structured(
    tools.get('execute_quote').execute({ quoteId: quote.quoteId, idempotencyKey: 'gold-btc-1' }),
  );
  assert.equal(replay.replay, true);
  assert.equal(replay.tradeId, trade.tradeId);
  assert.equal(structured(tools.get('list_trades').execute({})).count, 1, 'a replay must not add a trade');
  assert.equal(structured(tools.get('get_balances').execute({})).available.USD, after.available.USD);

  // The desk's own ceiling, enforced here rather than trusted to the planner.
  const tooBig = structured(tools.get('get_quote').execute({ fromAsset: 'USD', toAsset: 'BTC', amount: 2000 }));
  assert.throws(
    () => tools.get('execute_quote').execute({ quoteId: tooBig.quoteId, idempotencyKey: 'over-cap' }),
    /refuses any single trade above \$1500/,
  );

  // An expired quote is refused rather than filled at a price that has moved.
  const stale = structured(tools.get('get_quote').execute({ fromAsset: 'USD', toAsset: 'ETH', amount: 100 }));
  clock += 120_000;
  assert.throws(
    () => tools.get('execute_quote').execute({ quoteId: stale.quoteId, idempotencyKey: 'stale-1' }),
    /expired/,
  );

  assert.throws(
    () => tools.get('execute_quote').execute({ quoteId: 'Q-9999', idempotencyKey: 'nope' }),
    /No quote called/,
  );

  elements.get('resetBtn').click();
  assert.equal(structured(tools.get('list_trades').execute({})).count, 0, 'reset must clear trades');
  console.log(
    `[crypto] bought ${trade.received} BTC for $${trade.spent}; replay, over-cap and expiry all refused`,
  );
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

  for (const app of ['orders', 'support', 'metals', 'crypto']) {
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
