/* Helpdesk Support — exposes a write capability, behind a normal sign-in gate. */

/** WebMCP moved to document.modelContext; navigator.modelContext is the legacy alias. */
const modelContext = document.modelContext ?? navigator.modelContext;

const STORAGE_KEY = 'support-demo';
const state = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    return { signedIn: Boolean(raw.signedIn), tickets: Array.isArray(raw.tickets) ? raw.tickets : [] };
  } catch {
    return { signedIn: true, tickets: [] };
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

function nextTicketId() {
  return `TKT-${1200 + state.tickets.length + 1}`;
}

const createTicketTool = {
  name: 'create_ticket',
  description:
    'Create a support ticket. Returns { id, title, priority, relatedOrderId, createdAt, url }. Use one call per ticket.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short ticket title' },
      description: { type: 'string', description: 'What happened and what is needed' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Defaults to normal' },
      relatedOrderId: { type: 'string', description: 'Order id this ticket is about, if any' },
    },
    required: ['title', 'description'],
  },
  annotations: { title: 'Create support ticket', readOnlyHint: false, destructiveHint: false },
  execute({ title, description, priority, relatedOrderId } = {}) {
    if (!title || !description) throw new Error('create_ticket requires both title and description');
    const ticket = {
      id: nextTicketId(),
      title: String(title),
      description: String(description),
      priority: ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal',
      relatedOrderId: relatedOrderId ? String(relatedOrderId) : null,
      createdAt: new Date().toISOString(),
      url: `${location.origin}/#${nextTicketId()}`,
    };
    state.tickets.unshift(ticket);
    save();
    renderTickets();
    log('create_ticket', { title, priority: ticket.priority, relatedOrderId }, ticket.id);
    return result(ticket);
  },
};

const listTicketsTool = {
  name: 'list_tickets',
  description: 'List existing support tickets. Returns { tickets: [...], count }.',
  inputSchema: {
    type: 'object',
    properties: { priority: { type: 'string', description: 'Filter by priority' } },
    required: [],
  },
  annotations: { title: 'List tickets', readOnlyHint: true },
  execute({ priority } = {}) {
    const tickets = priority ? state.tickets.filter((ticket) => ticket.priority === priority) : state.tickets;
    log('list_tickets', { priority }, `${tickets.length} tickets`);
    return result({ tickets, count: tickets.length });
  },
};

function renderTickets() {
  document.getElementById('ticketsBody').innerHTML =
    state.tickets
      .map(
        (ticket) => `
      <tr>
        <td>${ticket.id}</td>
        <td>${ticket.title}</td>
        <td><span class="pill ${ticket.priority === 'high' || ticket.priority === 'urgent' ? 'delayed' : 'open'}">${ticket.priority}</span></td>
        <td>${ticket.relatedOrderId ?? '—'}</td>
        <td>${new Date(ticket.createdAt).toLocaleString()}</td>
      </tr>`,
      )
      .join('') || '<tr><td colspan="5" class="muted">No tickets yet</td></tr>';
}

/**
 * Capabilities are published through provideContext(), so signing out removes
 * them wholesale — exactly the situation the extension reports as AUTH_REQUIRED.
 */
function publishTools() {
  modelContext.provideContext({
    tools: state.signedIn ? [createTicketTool, listTicketsTool] : [],
  });
  const names = state.signedIn ? ['create_ticket(title, description, priority?, relatedOrderId?)', 'list_tickets(priority?)'] : [];
  document.getElementById('toolList').innerHTML =
    names.map((name) => `<li>${name}</li>`).join('') || '<li class="muted">none — signed out</li>';
  document.getElementById('toolStatus').textContent = state.signedIn
    ? `${names.length} WebMCP tools registered`
    : 'signed out — no tools exposed';
  document.getElementById('sessionState').textContent = state.signedIn
    ? 'Signed in as agent@helpdesk.example'
    : 'Signed out';
  document.getElementById('authBtn').textContent = state.signedIn ? 'Sign out' : 'Sign in';
  document.getElementById('authBanner').hidden = state.signedIn;
}

document.getElementById('authBtn').addEventListener('click', () => {
  state.signedIn = !state.signedIn;
  save();
  publishTools();
  log('(page)', {}, state.signedIn ? 'signed in — tools published' : 'signed out — tools withdrawn');
});

renderTickets();
publishTools();
