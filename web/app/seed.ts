import type { StoredRun, StoredWorkflow } from './store';

/**
 * What a first-time visitor sees.
 *
 * These operate on Magpie's own library, because that is the only data the site
 * has — it holds no business data of its own. They run for real with nothing
 * installed, and they double as worked examples of the step format an agent
 * should produce when calling create_workflow.
 */

const WORKFLOWS: StoredWorkflow[] = [
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
