/* Bullion Desk — spot prices for metals and currencies. Read-only, no auth. */

/** WebMCP moved to document.modelContext; navigator.modelContext is the legacy alias. */
const modelContext = document.modelContext ?? navigator.modelContext;

const STORAGE_KEY = 'metals-demo';

/**
 * Seed prices sit *below* the thresholds the demo workflow watches for, so the
 * interesting case ("gold above 3,500") is the one you trigger on camera rather
 * than one that is already true when the page loads.
 */
const INSTRUMENTS = [
  { symbol: 'XAU/USD', name: 'Gold', unit: 'troy ounce', seed: 3412.5, decimals: 2, baseChange: 0.4 },
  { symbol: 'XAG/USD', name: 'Silver', unit: 'troy ounce', seed: 41.82, decimals: 2, baseChange: -0.6 },
  { symbol: 'XPT/USD', name: 'Platinum', unit: 'troy ounce', seed: 1074.4, decimals: 2, baseChange: 0.2 },
  { symbol: 'EUR/USD', name: 'Euro', unit: '1 EUR', seed: 1.0842, decimals: 4, baseChange: -0.1 },
  { symbol: 'DXY', name: 'US Dollar Index', unit: 'index', seed: 97.35, decimals: 2, baseChange: 0.3 },
];

/**
 * Price moves are persisted per origin. A scheduled workflow reopens this tab on
 * every tick, so an in-memory spike would vanish before the run could see it.
 */
const state = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    return { shifts: raw.shifts && typeof raw.shifts === 'object' ? raw.shifts : {} };
  } catch {
    return { shifts: {} };
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

/** MCP-shaped result: text content for humans, structuredContent for machines. */
function result(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function instrument(symbol) {
  const needle = String(symbol).trim().toUpperCase();
  return (
    INSTRUMENTS.find((entry) => entry.symbol === needle) ??
    // "gold" and "XAU" are what a person types; both should resolve.
    INSTRUMENTS.find((entry) => entry.name.toUpperCase() === needle) ??
    INSTRUMENTS.find((entry) => entry.symbol.split('/')[0] === needle) ??
    null
  );
}

function quoteOf(entry, asOf) {
  const shift = state.shifts[entry.symbol] ?? 1;
  return {
    symbol: entry.symbol,
    name: entry.name,
    price: round(entry.seed * shift, entry.decimals),
    currency: 'USD',
    unit: entry.unit,
    changePct: round(entry.baseChange + (shift - 1) * 100, 2),
    asOf,
  };
}

/** Deterministic pseudo-random walk, so history does not change between calls. */
function wobble(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value) - 0.5;
}

// --- WebMCP tool definitions -------------------------------------------------

const listInstrumentsTool = {
  name: 'list_instruments',
  description:
    'List the instruments this desk prices. Returns { instruments: [{ symbol, name, unit, currency }], count }. Use the exact "symbol" values with get_spot and get_history.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { title: 'List instruments', readOnlyHint: true },
  execute() {
    const instruments = INSTRUMENTS.map((entry) => ({
      symbol: entry.symbol,
      name: entry.name,
      unit: entry.unit,
      currency: 'USD',
    }));
    log('list_instruments', {}, `${instruments.length} instruments`);
    return result({ instruments, count: instruments.length });
  },
};

const getSpotTool = {
  name: 'get_spot',
  description:
    'Get the current spot price of one or more instruments. Returns { quotes: [{ symbol, name, price, currency, unit, changePct, asOf }], count, asOf }. Quotes come back in the order requested, so the price of a single requested symbol is at quotes.0.price. Omit "symbols" for every instrument. There is no threshold or alert parameter — compare the price yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        items: { type: 'string' },
        description: 'Symbols such as ["XAU/USD"]. Omit for all instruments.',
      },
    },
    required: [],
  },
  annotations: { title: 'Get spot price', readOnlyHint: true },
  execute({ symbols } = {}) {
    const asOf = new Date().toISOString();
    const requested = symbols == null ? [] : Array.isArray(symbols) ? symbols : [symbols];
    const entries = requested.length === 0 ? INSTRUMENTS : requested.map(instrument);

    const unknown = requested.filter((symbol, index) => entries[index] === null).map(String);
    if (unknown.length > 0) {
      log('get_spot', { symbols }, `unknown: ${unknown.join(', ')}`);
      throw new Error(
        `Not priced here: ${unknown.join(', ')}. Call list_instruments for the symbols this desk covers.`,
      );
    }

    const quotes = entries.map((entry) => quoteOf(entry, asOf));
    log('get_spot', { symbols }, quotes.map((quote) => `${quote.symbol} ${quote.price}`).join(', '));
    return result({ quotes, count: quotes.length, asOf });
  },
};

const getHistoryTool = {
  name: 'get_history',
  description:
    'Get daily closing prices for one instrument. Returns { symbol, days, closes: [{ date, close }], high, low, average }. Closes are oldest first. This desk computes no indicators — derive averages, trends and thresholds yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Instrument symbol such as XAU/USD' },
      days: { type: 'number', description: 'How many days back, 1-90. Defaults to 30.' },
    },
    required: ['symbol'],
  },
  annotations: { title: 'Get price history', readOnlyHint: true },
  execute({ symbol, days } = {}) {
    const entry = instrument(symbol);
    if (!entry) throw new Error(`No instrument called ${symbol}. Call list_instruments first.`);
    const span = Math.min(90, Math.max(1, Math.floor(Number(days) || 30)));
    const today = new Date();
    const current = quoteOf(entry, today.toISOString()).price;

    const closes = [];
    for (let offset = span - 1; offset >= 0; offset -= 1) {
      const date = new Date(today.getTime() - offset * 86400000);
      // Older days drift further from today's price; the newest close is today's.
      const drift = 1 + wobble(entry.seed + offset) * 0.03 * (offset / span);
      closes.push({
        date: date.toISOString().slice(0, 10),
        close: offset === 0 ? current : round(current * drift, entry.decimals),
      });
    }

    const values = closes.map((row) => row.close);
    const payload = {
      symbol: entry.symbol,
      days: span,
      closes,
      count: closes.length,
      high: Math.max(...values),
      low: Math.min(...values),
      average: round(values.reduce((total, value) => total + value, 0) / values.length, entry.decimals),
    };
    log('get_history', { symbol, days: span }, `${closes.length} closes, avg ${payload.average}`);
    return result(payload);
  },
};

// --- rendering + market controls --------------------------------------------

function renderSpot() {
  const asOf = new Date().toISOString();
  document.getElementById('spotBody').innerHTML = INSTRUMENTS.map((entry) => {
    const quote = quoteOf(entry, asOf);
    const direction = quote.changePct >= 0 ? 'up' : 'down';
    return `
      <tr>
        <td>${quote.symbol}</td>
        <td>${quote.name}</td>
        <td>${quote.price.toLocaleString(undefined, { minimumFractionDigits: entry.decimals })}</td>
        <td class="muted">${quote.unit}</td>
        <td><span class="pill ${direction}">${quote.changePct >= 0 ? '+' : ''}${quote.changePct}%</span></td>
      </tr>`;
  }).join('');

  const gold = quoteOf(INSTRUMENTS[0], asOf);
  const shifted = Object.keys(state.shifts).length > 0;
  document.getElementById('marketState').textContent = shifted
    ? `gold moved — now $${gold.price.toLocaleString()}`
    : 'at seed prices';
}

function paintToolList() {
  const names = ['list_instruments()', 'get_spot(symbols?)', 'get_history(symbol, days?)'];
  document.getElementById('toolList').innerHTML = names.map((name) => `<li>${name}</li>`).join('');
  document.getElementById('toolStatus').textContent = `${names.length} WebMCP tools registered`;
}

function adjust(symbol, factor) {
  state.shifts[symbol] = (state.shifts[symbol] ?? 1) * factor;
  save();
  renderSpot();
  const price = quoteOf(instrument(symbol), new Date().toISOString()).price;
  log('(page)', {}, `${symbol} moved to ${price}`);
}

document.getElementById('spikeBtn').addEventListener('click', () => adjust('XAU/USD', 1.08));
document.getElementById('crashBtn').addEventListener('click', () => adjust('XAU/USD', 0.92));
document.getElementById('resetBtn').addEventListener('click', () => {
  state.shifts = {};
  save();
  renderSpot();
  log('(page)', {}, 'prices reset to seed');
});

modelContext.registerTool(listInstrumentsTool);
modelContext.registerTool(getSpotTool);
modelContext.registerTool(getHistoryTool);

renderSpot();
paintToolList();
