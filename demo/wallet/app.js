/* Kestrel Wallet — holds balances and buys crypto. The write is real money, so it is staged. */

/** WebMCP moved to document.modelContext; navigator.modelContext is the legacy alias. */
const modelContext = document.modelContext ?? navigator.modelContext;

const STORAGE_KEY = 'wallet-demo';

/** Free USD sits above $1,000 so the balance leg of the demo condition passes. */
const SEED_BALANCES = { USD: 1240.0, BTC: 0.0132, ETH: 0.41 };

const RATES = { BTC: 64180.0, ETH: 2410.0, USD: 1 };
const FEE_RATE = 0.0035;
const QUOTE_TTL_SECONDS = 90;

/**
 * The wallet's own ceiling on agent-driven purchases, enforced here rather than
 * asked of the model. Whatever a plan says, this is the number that decides —
 * which is why $1,000 goes through and $2,000 does not.
 */
const MAX_TRADE_USD = 1500;

const state = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    return {
      balances: raw.balances && typeof raw.balances === 'object' ? raw.balances : { ...SEED_BALANCES },
      trades: Array.isArray(raw.trades) ? raw.trades : [],
      quotes: raw.quotes && typeof raw.quotes === 'object' ? raw.quotes : {},
      /** idempotencyKey → tradeId, so a replayed call cannot buy twice. */
      keys: raw.keys && typeof raw.keys === 'object' ? raw.keys : {},
      // Quotes are deleted once used, so ids come from a counter rather than a
      // count — an executed quoteId must never be handed out a second time.
      quoteSeq: Number(raw.quoteSeq) || 0,
    };
  } catch {
    return { balances: { ...SEED_BALANCES }, trades: [], quotes: {}, keys: {}, quoteSeq: 0 };
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

const logEl = document.getElementById('log');
const calls = [];

function log(name, args, note) {
  calls.unshift(`${new Date().toLocaleTimeString()}  ${name}(${JSON.stringify(args ?? {})})${note ? `  → ${note}` : ''}`);
  logEl.textContent = calls.slice(0, 40).join('\n');
}

function result(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function decimalsFor(asset) {
  return asset === 'USD' ? 2 : 8;
}

function free(asset) {
  return round(state.balances[asset] ?? 0, decimalsFor(asset));
}

function usdValue(asset, amount) {
  return round(amount * (RATES[asset] ?? 0), 2);
}

function nextId(prefix, count) {
  return `${prefix}-${1000 + count + 1}`;
}

// --- WebMCP tool definitions -------------------------------------------------

const getBalancesTool = {
  name: 'get_balances',
  description:
    'Get this wallet\'s balances. Returns { balances: [{ asset, free, locked, valueUsd }], available, quoteCurrency, totalValueUsd }. "available" is a map of asset to free amount, so the free cash is available.USD and the bitcoin held is available.BTC. Assets are USD, BTC and ETH.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { title: 'Get balances', readOnlyHint: true },
  execute() {
    const assets = Object.keys(SEED_BALANCES);
    const balances = assets.map((asset) => ({
      asset,
      free: free(asset),
      locked: 0,
      valueUsd: usdValue(asset, free(asset)),
    }));
    const available = {};
    for (const asset of assets) available[asset] = free(asset);
    const payload = {
      balances,
      available,
      quoteCurrency: 'USD',
      totalValueUsd: round(
        balances.reduce((total, row) => total + row.valueUsd, 0),
        2,
      ),
    };
    log('get_balances', {}, `$${payload.totalValueUsd.toLocaleString()} total, $${available.USD} free`);
    return result(payload);
  },
};

const getQuoteTool = {
  name: 'get_quote',
  description:
    'Price a purchase or sale without making it. Returns { quoteId, fromAsset, toAsset, amount, rate, feeUsd, receives, expiresAt, expiresInSeconds, maxTradeUsd }. Moves no money. One side must be USD. Pass the returned quoteId to execute_quote to actually trade; the quote expires after ' +
    QUOTE_TTL_SECONDS +
    ' seconds, so price it immediately before executing rather than early in a workflow.',
  inputSchema: {
    type: 'object',
    properties: {
      fromAsset: { type: 'string', enum: ['USD', 'BTC', 'ETH'], description: 'Asset being spent' },
      toAsset: { type: 'string', enum: ['USD', 'BTC', 'ETH'], description: 'Asset being bought' },
      amount: { type: 'number', description: 'How much of fromAsset to spend' },
    },
    required: ['fromAsset', 'toAsset', 'amount'],
  },
  annotations: { title: 'Get a quote', readOnlyHint: true },
  execute({ fromAsset, toAsset, amount } = {}) {
    const from = String(fromAsset ?? '').toUpperCase();
    const to = String(toAsset ?? '').toUpperCase();
    const spend = Number(amount);

    if (!(from in RATES) || !(to in RATES)) throw new Error('Assets must be USD, BTC or ETH');
    if (from === to) throw new Error('fromAsset and toAsset must differ');
    if (from !== 'USD' && to !== 'USD') throw new Error('One side of the trade must be USD');
    if (!Number.isFinite(spend) || spend <= 0) throw new Error('amount must be a positive number');

    const notionalUsd = round(spend * RATES[from], 2);
    const feeUsd = round(notionalUsd * FEE_RATE, 2);
    const receives = round((notionalUsd - feeUsd) / RATES[to], decimalsFor(to));
    const now = Date.now();
    state.quoteSeq += 1;
    const quote = {
      quoteId: nextId('Q', state.quoteSeq - 1),
      fromAsset: from,
      toAsset: to,
      amount: round(spend, decimalsFor(from)),
      notionalUsd,
      rate: RATES[to],
      feeUsd,
      receives,
      expiresAt: new Date(now + QUOTE_TTL_SECONDS * 1000).toISOString(),
      expiresInSeconds: QUOTE_TTL_SECONDS,
      maxTradeUsd: MAX_TRADE_USD,
    };

    state.quotes[quote.quoteId] = quote;
    save();
    log('get_quote', { fromAsset: from, toAsset: to, amount: spend }, `${quote.quoteId} → ${receives} ${to}`);
    return result(quote);
  },
};

const executeQuoteTool = {
  name: 'execute_quote',
  description:
    'Execute a quote from get_quote. THIS SPENDS REAL MONEY. Requires the quoteId and an idempotencyKey; calling it again with the same idempotencyKey returns the original trade instead of trading twice. Rejects expired quotes, insufficient balances, and any single trade above this wallet\'s limit of $' +
    MAX_TRADE_USD +
    '. Returns { tradeId, spent, received, fromAsset, toAsset, filledPrice, feeUsd, executedAt, replay, balancesAfter }.',
  inputSchema: {
    type: 'object',
    properties: {
      quoteId: { type: 'string', description: 'quoteId returned by get_quote' },
      idempotencyKey: {
        type: 'string',
        description: 'Caller-chosen key identifying this purchase. Reuse it to make a retry safe.',
      },
    },
    required: ['quoteId', 'idempotencyKey'],
  },
  annotations: { title: 'Buy with a quote', readOnlyHint: false, destructiveHint: true },
  execute({ quoteId, idempotencyKey } = {}) {
    const key = String(idempotencyKey ?? '').trim();
    if (!key) throw new Error('execute_quote requires an idempotencyKey so a retry cannot buy twice');

    // Replay first: a repeated call must be a no-op that reports the original.
    const existingId = state.keys[key];
    if (existingId) {
      const original = state.trades.find((trade) => trade.tradeId === existingId);
      log('execute_quote', { quoteId, idempotencyKey: key }, `replay of ${existingId} — nothing bought`);
      if (!original) throw new Error(`idempotencyKey ${key} was already used by trade ${existingId}`);
      return result({ ...original, replay: true, balancesAfter: { ...state.balances } });
    }

    const quote = state.quotes[String(quoteId)];
    if (!quote) throw new Error(`No quote called ${quoteId}. Call get_quote first.`);
    if (Date.parse(quote.expiresAt) < Date.now()) {
      log('execute_quote', { quoteId }, 'expired');
      throw new Error(
        `Quote ${quote.quoteId} expired at ${quote.expiresAt}. Prices move — call get_quote again and execute that one.`,
      );
    }
    if (quote.notionalUsd > MAX_TRADE_USD) {
      log('execute_quote', { quoteId }, `refused — $${quote.notionalUsd} over the $${MAX_TRADE_USD} limit`);
      throw new Error(
        `This wallet refuses any single trade above $${MAX_TRADE_USD}; that quote is $${quote.notionalUsd}. Quote a smaller amount.`,
      );
    }
    if (free(quote.fromAsset) < quote.amount) {
      throw new Error(
        `Not enough ${quote.fromAsset}: ${free(quote.fromAsset)} free, ${quote.amount} needed.`,
      );
    }

    state.balances[quote.fromAsset] = round(free(quote.fromAsset) - quote.amount, decimalsFor(quote.fromAsset));
    state.balances[quote.toAsset] = round(free(quote.toAsset) + quote.receives, decimalsFor(quote.toAsset));

    const trade = {
      tradeId: nextId('T', state.trades.length),
      quoteId: quote.quoteId,
      fromAsset: quote.fromAsset,
      toAsset: quote.toAsset,
      spent: quote.amount,
      received: quote.receives,
      filledPrice: quote.rate,
      feeUsd: quote.feeUsd,
      notionalUsd: quote.notionalUsd,
      executedAt: new Date().toISOString(),
    };

    state.trades.unshift(trade);
    state.keys[key] = trade.tradeId;
    delete state.quotes[quote.quoteId];
    save();
    render();
    log(
      'execute_quote',
      { quoteId: quote.quoteId, idempotencyKey: key },
      `${trade.tradeId}: ${trade.spent} ${trade.fromAsset} → ${trade.received} ${trade.toAsset}`,
    );
    return result({ ...trade, replay: false, balancesAfter: { ...state.balances } });
  },
};

const listTradesTool = {
  name: 'list_trades',
  description:
    'List trades made in this wallet, newest first. Returns { trades: [{ tradeId, fromAsset, toAsset, spent, received, filledPrice, feeUsd, executedAt }], count }.',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'Maximum number of trades to return' } },
    required: [],
  },
  annotations: { title: 'List trades', readOnlyHint: true },
  execute({ limit } = {}) {
    const trades = limit ? state.trades.slice(0, Number(limit)) : state.trades;
    log('list_trades', { limit }, `${trades.length} trades`);
    return result({ trades, count: trades.length });
  },
};

// --- rendering --------------------------------------------------------------

function renderBalances() {
  document.getElementById('balancesBody').innerHTML = Object.keys(SEED_BALANCES)
    .map(
      (asset) => `
      <tr>
        <td>${asset}</td>
        <td>${free(asset)}</td>
        <td class="muted">0</td>
        <td>$${usdValue(asset, free(asset)).toLocaleString()}</td>
      </tr>`,
    )
    .join('');
  document.getElementById('capState').textContent = `This wallet refuses agent trades above $${MAX_TRADE_USD}.`;
}

function renderTrades() {
  document.getElementById('tradesBody').innerHTML =
    state.trades
      .map(
        (trade) => `
      <tr>
        <td>${trade.tradeId}</td>
        <td>${trade.fromAsset}→${trade.toAsset}</td>
        <td>${trade.spent} ${trade.fromAsset}</td>
        <td>${trade.received} ${trade.toAsset}</td>
        <td>$${trade.filledPrice.toLocaleString()}</td>
        <td>${new Date(trade.executedAt).toLocaleString()}</td>
      </tr>`,
      )
      .join('') || '<tr><td colspan="6" class="muted">No trades yet</td></tr>';
}

function render() {
  renderBalances();
  renderTrades();
}

function paintToolList() {
  const names = [
    'get_balances()',
    'get_quote(fromAsset, toAsset, amount)',
    'execute_quote(quoteId, idempotencyKey)',
    'list_trades(limit?)',
  ];
  document.getElementById('toolList').innerHTML = names.map((name) => `<li>${name}</li>`).join('');
  document.getElementById('toolStatus').textContent = `${names.length} WebMCP tools registered`;
}

document.getElementById('resetBtn').addEventListener('click', () => {
  state.balances = { ...SEED_BALANCES };
  state.trades = [];
  state.quotes = {};
  state.keys = {};
  save();
  render();
  log('(page)', {}, 'wallet reset to seed balances');
});

modelContext.registerTool(getBalancesTool);
modelContext.registerTool(getQuoteTool);
modelContext.registerTool(executeQuoteTool);
modelContext.registerTool(listTradesTool);

render();
paintToolList();
