import type { StoredRun, StoredWorkflow } from './store';

/**
 * What a first-time visitor sees.
 *
 * The first two operate on Magpie's own library, because that is the only data
 * the site has on its own, and they run for real with nothing installed. The
 * third is the point of the project — three origins in one workflow — and needs
 * the extension, which its summary says plainly so an unrunnable card is
 * self-explaining rather than looking broken.
 *
 * All three double as worked examples of the step format an agent should produce
 * when calling create_workflow.
 */

const WORKFLOWS: StoredWorkflow[] = [
  {
    id: 'wf_delayed_order_tickets',
    name: 'Delayed orders → support tickets',
    summary:
      'Needs the extension, with Northwind Orders and Helpdesk Support open. Finds delayed orders over $5,000, opens a ticket for each, and drafts one summary email.',
    source: 'seeded',
    createdAt: '2026-09-02T10:00:00.000Z',
    requires: [
      'northwind_orders.search_orders',
      'helpdesk_support.create_ticket',
      'global.compose_email',
    ],
    finalOutput: 'tickets',
    steps: [
      {
        id: 's1',
        type: 'tool',
        tool: 'northwind_orders.search_orders',
        label: 'Find delayed orders',
        arguments: { status: 'delayed' },
        output: 'orders',
      },
      {
        // search_orders exposes no amount filter on purpose, so this has to be
        // local work rather than something pushed to the site.
        id: 's2',
        type: 'transform',
        operation: 'filter',
        label: 'Keep the ones over $5,000',
        input: 'orders',
        output: 'high',
        condition: { field: 'amount', operator: '>', value: 5000 },
      },
      {
        id: 's3',
        type: 'tool',
        tool: 'helpdesk_support.create_ticket',
        label: 'Open a ticket for each',
        forEach: '{{high}}',
        arguments: {
          title: 'Delayed order {{item.id}} — {{item.customer}}',
          description:
            'Order {{item.id}} for {{item.customer}} is {{item.daysLate}} days late, value {{item.amount}} {{item.currency}}.',
          priority: 'high',
          relatedOrderId: '{{item.id}}',
        },
        output: 'tickets',
      },
      {
        id: 's4',
        type: 'tool',
        tool: 'global.compose_email',
        label: 'Draft one summary email',
        arguments: {
          to: 'ops@example.com',
          subject: '{{tickets.length}} delayed orders escalated',
          body: 'Opened {{tickets.length}} support tickets for delayed orders over $5,000.',
        },
        output: 'draft',
      },
    ],
  },
  {
    id: 'wf_export_library',
    name: 'Export the workflow library',
    summary: 'Lists every saved workflow and downloads them as a CSV.',
    source: 'seeded',
    createdAt: '2026-08-27T09:12:00.000Z',
    requires: ['list_workflows', 'export_csv'],
    finalOutput: 'rows',
    steps: [
      {
        id: 's1',
        type: 'tool',
        tool: 'list_workflows',
        label: 'List saved workflows',
        arguments: {},
        output: 'library',
      },
      {
        id: 's2',
        type: 'transform',
        operation: 'pick',
        label: 'Keep name, summary and size',
        input: 'library',
        output: 'rows',
        fields: ['name', 'summary', 'stepCount', 'source'],
      },
      {
        id: 's3',
        type: 'tool',
        tool: 'export_csv',
        label: 'Download as CSV',
        arguments: { data: '{{rows}}', filename: 'magpie-workflows.csv' },
        output: 'csvFile',
      },
    ],
  },
  {
    id: 'wf_run_health',
    name: 'How have recent runs gone?',
    summary: 'Groups recent workflow runs by outcome and counts each.',
    source: 'seeded',
    createdAt: '2026-08-27T09:20:00.000Z',
    requires: ['list_runs'],
    finalOutput: 'byStatus',
    steps: [
      { id: 's1', type: 'tool', tool: 'list_runs', label: 'List recent runs', arguments: { limit: 25 }, output: 'runs' },
      {
        id: 's2',
        type: 'transform',
        operation: 'summarize',
        label: 'Count by outcome',
        input: 'runs',
        output: 'byStatus',
        groupBy: 'status',
        metrics: [
          { op: 'count', as: 'runs' },
          { op: 'avg', field: 'durationMs', as: 'averageMs' },
        ],
      },
    ],
  },
];

const RUNS: StoredRun[] = [
  {
    id: 'run_seed_1',
    workflowId: 'wf_export_library',
    workflowName: 'Export the workflow library',
    status: 'completed',
    startedAt: '2026-08-27T09:21:04.000Z',
    durationMs: 38,
    finalPreview: '2 results: Export the workflow library, How have recent runs gone?',
    steps: [
      { id: 's1', label: 'List saved workflows', type: 'tool', status: 'ok', preview: '2 results: Export the workflow library, How have recent runs gone?' },
      { id: 's2', label: 'Keep name, summary and size', type: 'transform', status: 'ok', preview: '2 results: Export the workflow library, How have recent runs gone?' },
      { id: 's3', label: 'Download as CSV', type: 'tool', status: 'ok', preview: 'filename: magpie-workflows.csv, rowCount: 2' },
    ],
  },
];

export const SEED = { workflows: WORKFLOWS, runs: RUNS };
