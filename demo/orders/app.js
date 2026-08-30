/* Northwind Orders — a demo web app whose only agent surface is WebMCP. */

/** WebMCP moved to document.modelContext; navigator.modelContext is the legacy alias. */
const modelContext = document.modelContext ?? navigator.modelContext;

const CUSTOMERS = [
  { id: 'C-101', name: 'Acme Industrial', email: 'ops@acme.example', tier: 'enterprise', manager: 'R. Okafor' },
  { id: 'C-102', name: 'Bluewave Foods', email: 'supply@bluewave.example', tier: 'growth', manager: 'S. Haddad' },
  { id: 'C-103', name: 'Cobalt Robotics', email: 'orders@cobalt.example', tier: 'enterprise', manager: 'R. Okafor' },
  { id: 'C-104', name: 'Dunder Supply', email: 'ap@dunder.example', tier: 'smb', manager: 'M. Lindqvist' },
  { id: 'C-105', name: 'Everline Retail', email: 'buying@everline.example', tier: 'growth', manager: 'S. Haddad' },
  { id: 'C-106', name: 'Fjord Logistics', email: 'hello@fjord.example', tier: 'enterprise', manager: 'M. Lindqvist' },
];

const RAW_ORDERS = [
  ['SO-4801', 'C-101', 'delayed', 18400, '2026-07-02', '2026-08-04', 22, 'Bearing assembly ×120'],
  ['SO-4802', 'C-104', 'delayed', 940, '2026-07-03', '2026-08-06', 20, 'Copier toner ×40'],
  ['SO-4803', 'C-103', 'shipped', 7350, '2026-07-05', '2026-08-01', 0, 'Servo drives ×15'],
  ['SO-4804', 'C-102', 'delayed', 12250, '2026-07-06', '2026-08-08', 18, 'Cold-chain pallets ×8'],
  ['SO-4805', 'C-105', 'delivered', 3200, '2026-07-08', '2026-07-28', 0, 'Shelving units ×60'],
  ['SO-4806', 'C-101', 'delayed', 5400, '2026-07-09', '2026-08-11', 15, 'Hydraulic seals ×300'],
  ['SO-4807', 'C-106', 'delayed', 26800, '2026-07-11', '2026-08-02', 24, 'Reefer containers ×2'],
  ['SO-4808', 'C-104', 'open', 1650, '2026-07-12', '2026-08-20', 0, 'Packaging film ×90'],
  ['SO-4809', 'C-102', 'delayed', 4980, '2026-07-14', '2026-08-09', 17, 'Freezer racks ×12'],
  ['SO-4810', 'C-103', 'delayed', 31200, '2026-07-15', '2026-08-05', 21, 'Robot arms ×4'],
  ['SO-4811', 'C-105', 'shipped', 8800, '2026-07-16', '2026-08-12', 0, 'POS terminals ×35'],
  ['SO-4812', 'C-106', 'delayed', 9100, '2026-07-18', '2026-08-14', 12, 'Pallet jacks ×10'],
  ['SO-4813', 'C-101', 'cancelled', 2400, '2026-07-19', '2026-08-16', 0, 'Gasket kits ×150'],
  ['SO-4814', 'C-102', 'delivered', 15600, '2026-07-20', '2026-08-03', 0, 'Blast chillers ×3'],
  ['SO-4815', 'C-104', 'delayed', 5050, '2026-07-22', '2026-08-18', 8, 'Office chairs ×45'],
  ['SO-4816', 'C-103', 'open', 44100, '2026-07-23', '2026-09-01', 0, 'Vision systems ×6'],
  ['SO-4817', 'C-106', 'delayed', 7600, '2026-07-25', '2026-08-19', 7, 'Container seals ×500'],
  ['SO-4818', 'C-105', 'delayed', 2100, '2026-07-26', '2026-08-21', 5, 'Signage kits ×20'],
  ['SO-4819', 'C-101', 'shipped', 19700, '2026-07-28', '2026-08-22', 0, 'Conveyor belts ×5'],
  ['SO-4820', 'C-102', 'delayed', 6350, '2026-07-29', '2026-08-24', 3, 'Insulated totes ×140'],
];

const ORDERS = RAW_ORDERS.map(([id, customerId, status, amount, placedAt, promisedAt, daysLate, items]) => ({
  id,
  customerId,
  customer: CUSTOMERS.find((entry) => entry.id === customerId).name,
  status,
  amount,
  currency: 'USD',
  placedAt,
  promisedAt,
  daysLate,
  items,
}));

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

function renderOrders() {
  document.getElementById('ordersBody').innerHTML = ORDERS.map(
    (order) => `
      <tr>
        <td>${order.id}</td>
        <td>${order.customer}</td>
        <td><span class="pill ${order.status}">${order.status}</span></td>
        <td>$${order.amount.toLocaleString()}</td>
        <td>${order.placedAt}</td>
        <td>${order.promisedAt}</td>
        <td>${order.daysLate || '—'}</td>
      </tr>`,
  ).join('');
}

// --- WebMCP tool definitions -------------------------------------------------

const searchOrdersTool = {
  name: 'search_orders',
  description:
    'Search this account\'s orders. Returns { orders: [{ id, customer, customerId, status, amount, currency, placedAt, promisedAt, daysLate, items }], count }. Statuses are open, shipped, delivered, delayed, cancelled. There is no amount filter — filter on amount yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['open', 'shipped', 'delivered', 'delayed', 'cancelled'],
        description: 'Only return orders with this status',
      },
      customer: { type: 'string', description: 'Match part of the customer name' },
      limit: { type: 'number', description: 'Maximum number of orders to return' },
    },
    required: [],
  },
  annotations: { title: 'Search orders', readOnlyHint: true },
  execute({ status, customer, limit } = {}) {
    let orders = ORDERS;
    if (status) orders = orders.filter((order) => order.status === String(status).toLowerCase());
    if (customer) {
      const needle = String(customer).toLowerCase();
      orders = orders.filter((order) => order.customer.toLowerCase().includes(needle));
    }
    if (limit) orders = orders.slice(0, Number(limit));
    log('search_orders', { status, customer, limit }, `${orders.length} orders`);
    return result({ orders, count: orders.length });
  },
};

const findOrdersTool = {
  name: 'find_orders',
  description:
    'Find orders using a free-text query and optional filters. Returns { orders: [...], count }. (This is the renamed replacement for search_orders.)',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text match against customer, id or items' },
      filters: {
        type: 'object',
        description: 'Optional filters',
        properties: { status: { type: 'string' }, limit: { type: 'number' } },
      },
    },
    required: [],
  },
  annotations: { title: 'Find orders', readOnlyHint: true },
  execute({ query, filters } = {}) {
    let orders = ORDERS;
    if (filters?.status) orders = orders.filter((order) => order.status === String(filters.status).toLowerCase());
    if (query) {
      const needle = String(query).toLowerCase();
      orders = orders.filter((order) =>
        `${order.id} ${order.customer} ${order.items}`.toLowerCase().includes(needle),
      );
    }
    if (filters?.limit) orders = orders.slice(0, Number(filters.limit));
    log('find_orders', { query, filters }, `${orders.length} orders`);
    return result({ orders, count: orders.length });
  },
};

const getOrderTool = {
  name: 'get_order',
  description: 'Get one order by its id, including line items and the customer id.',
  inputSchema: {
    type: 'object',
    properties: { orderId: { type: 'string', description: 'Order id such as SO-4801' } },
    required: ['orderId'],
  },
  annotations: { title: 'View order', readOnlyHint: true },
  execute({ orderId } = {}) {
    const order = ORDERS.find((entry) => entry.id === String(orderId));
    log('get_order', { orderId }, order ? 'found' : 'not found');
    if (!order) throw new Error(`No order with id ${orderId}`);
    return result(order);
  },
};

const getCustomerTool = {
  name: 'get_customer',
  description:
    'Get a customer by id. Returns { id, name, email, tier, manager, orderCount, totalValue }.',
  inputSchema: {
    type: 'object',
    properties: { customerId: { type: 'string', description: 'Customer id such as C-101' } },
    required: ['customerId'],
  },
  annotations: { title: 'Get customer', readOnlyHint: true },
  execute({ customerId } = {}) {
    const customer = CUSTOMERS.find((entry) => entry.id === String(customerId));
    log('get_customer', { customerId }, customer ? customer.name : 'not found');
    if (!customer) throw new Error(`No customer with id ${customerId}`);
    const orders = ORDERS.filter((order) => order.customerId === customer.id);
    return result({
      ...customer,
      orderCount: orders.length,
      totalValue: orders.reduce((total, order) => total + order.amount, 0),
    });
  },
};

// --- registration + drift toggle --------------------------------------------

let searchHandle = null;
let drifted = false;

function registerAll() {
  searchHandle = modelContext.registerTool(drifted ? findOrdersTool : searchOrdersTool);
  modelContext.registerTool(getOrderTool);
  modelContext.registerTool(getCustomerTool);
  paintToolList();
}

function paintToolList() {
  const names = [drifted ? 'find_orders(query, filters)' : 'search_orders(status, customer, limit)', 'get_order(orderId)', 'get_customer(customerId)'];
  document.getElementById('toolList').innerHTML = names.map((name) => `<li>${name}</li>`).join('');
  document.getElementById('toolStatus').textContent = `${names.length} WebMCP tools registered`;
  document.getElementById('driftState').textContent = drifted ? 'drifted → find_orders' : 'stable';
}

document.getElementById('driftBtn').addEventListener('click', () => {
  drifted = !drifted;
  searchHandle?.unregister?.();
  if (!searchHandle?.unregister) modelContext.unregisterTool?.(drifted ? 'search_orders' : 'find_orders');
  searchHandle = modelContext.registerTool(drifted ? findOrdersTool : searchOrdersTool);
  paintToolList();
  log('(page)', {}, drifted ? 'search_orders removed, find_orders registered' : 'search_orders restored');
});

renderOrders();
registerAll();
