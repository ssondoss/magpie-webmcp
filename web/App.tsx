import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ToolDescriptor } from '../src/shared/types';
import { runWorkflow } from './app/engine';
import { SEED } from './app/seed';
import {
  clearRuns,
  deleteRun,
  deleteWorkflow,
  getSnapshot,
  recordRun,
  renameWorkflow,
  seedIfEmpty,
  subscribe,
  type StoredRun,
  type StoredWorkflow,
} from './app/store';
import { TOOLS, forgetReachable, registerTools } from './app/tools';
import { WorkflowDiagram } from './WorkflowDiagram';
import { Sites } from './Sites';
import { detectExtension, listExtensionCapabilities, type ExtensionCapability } from './app/extension';

type Tab = 'workflows' | 'runs' | 'sites';

const SOURCE_TILE: Record<StoredWorkflow['source'], { glyph: string; tone: string; label: string }> = {
  seeded: { glyph: '◆', tone: 'self', label: 'built in' },
  agent: { glyph: '✦', tone: '', label: 'created by an agent' },
  extension: { glyph: '⬡', tone: 'ok', label: 'composed in the extension' },
};

/**
 * Which site owns each capability, and whether calling it changes anything.
 *
 * The diagram draws a different shape for a step that writes, so this has to
 * cover both the site's own tools and everything the extension can reach.
 */
interface CapabilityMeta {
  providers: Record<string, string>;
  risks: Record<string, 'read' | 'write'>;
}

function tone(status: StoredRun['status'] | StoredRun['steps'][number]['status']): 'ok' | 'warn' | 'bad' {
  if (status === 'completed' || status === 'ok') return 'ok';
  if (status === 'partial' || status === 'skipped') return 'warn';
  return 'bad';
}

function glyph(value: 'ok' | 'warn' | 'bad'): string {
  return value === 'ok' ? '✓' : value === 'warn' ? '⚠' : '✗';
}

/**
 * The magpie, in the same geometry the extension icons are rasterised from —
 * head, jutting beak, and the long tail the bird is recognised by.
 */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" role="img" aria-label="Magpie">
      <g fill="#fff">
        <path d="M12.8 14.4 L29.8 26.9 L23.4 29.8 Z" />
        <ellipse cx="14.4" cy="17.6" rx="8" ry="5.6" transform="rotate(-31.5 14.4 17.6)" />
        <ellipse cx="10.6" cy="10.2" rx="4.8" ry="4.5" />
        <path d="M7 9.9 L0.6 11.8 L7.4 13.8 Z" />
      </g>
      <circle cx="12.3" cy="8.8" r="1.3" fill="var(--accent)" />
    </svg>
  );
}

/** Removes a card's subject. Deliberately small and hover-revealed. */
function DeleteButton({ label, onDelete }: { label: string; onDelete(): void }) {
  return (
    <button type="button" className="card-delete" title={label} aria-label={label} onClick={onDelete}>
      ✕
    </button>
  );
}

/**
 * The workflow's name, editable in place.
 *
 * The name is not decoration: it is how a workflow is referred to afterwards,
 * both in the UI and by an agent calling `run_workflow`. So renaming is a real
 * action with a real failure — another workflow may already hold that name —
 * and the message says so rather than silently keeping the old one.
 */
function EditableName({ workflow }: { workflow: StoredWorkflow }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workflow.name);
  const [error, setError] = useState('');

  const open = (): void => {
    setDraft(workflow.name);
    setError('');
    setEditing(true);
  };

  const commit = (): void => {
    if (draft.trim() === workflow.name) return setEditing(false);
    try {
      renameWorkflow(workflow.id, draft);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  if (!editing) {
    return (
      <h3 className="editable">
        {workflow.name}
        <button type="button" className="rename" onClick={open} title="Rename" aria-label={`Rename ${workflow.name}`}>
          ✎
        </button>
      </h3>
    );
  }

  return (
    <div className="rename-field">
      <input
        value={draft}
        autoFocus
        aria-label="Workflow name"
        onChange={(event) => {
          setDraft(event.target.value);
          setError('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setEditing(false);
        }}
        onBlur={commit}
      />
      {error ? <p className="error small">{error}</p> : null}
    </div>
  );
}

function WorkflowCard({
  workflow,
  onRun,
  onDelete,
  running,
  fresh,
  meta,
}: {
  workflow: StoredWorkflow;
  onRun(): void;
  onDelete(): void;
  running: boolean;
  fresh: boolean;
  meta: CapabilityMeta;
}) {
  const [open, setOpen] = useState(false);
  const source = SOURCE_TILE[workflow.source];
  // Which distinct sites the workflow touches — the interesting number for a
  // cross-site tool, and cheaper to read than the full requires list.
  const sites = new Set(workflow.requires.map((tool) => tool.split('.')[0]));

  return (
    <article className={`card lift${fresh ? ' fresh' : ''}`}>
      <header>
        <div className="card-title">
          <span className={`tile ${source.tone}`} aria-hidden="true">
            {source.glyph}
          </span>
          <div>
            <EditableName workflow={workflow} />
            <p className="muted small">{workflow.summary}</p>
          </div>
        </div>
        <div className="card-actions">
          <button type="button" className="primary" onClick={onRun} disabled={running}>
            {running ? 'Running…' : 'Run'}
          </button>
          <DeleteButton label={`Delete "${workflow.name}"`} onDelete={onDelete} />
        </div>
      </header>

      <div className="rail" aria-hidden="true">
        {workflow.steps.map((step) => (
          <i key={step.id} className={step.type} />
        ))}
      </div>

      <div className="meta">
        <span className="chip">
          <b>{workflow.steps.length}</b> steps
        </span>
        <span className="chip">
          <b>{sites.size || 0}</b> {sites.size === 1 ? 'site' : 'sites'}
        </span>
        <span className="tag">{source.label}</span>
      </div>

      <button type="button" className="link disclose" data-open={open} onClick={() => setOpen((value) => !value)}>
        <span className="caret" aria-hidden="true">
          ▸
        </span>
        {open ? 'Hide workflow' : 'Show workflow'}
      </button>

      {open ? (
        <WorkflowDiagram
          steps={workflow.steps}
          finalOutput={workflow.finalOutput}
          providers={meta.providers}
          risks={meta.risks}
        />
      ) : null}
    </article>
  );
}

function RunCard({ run, onDelete, fresh }: { run: StoredRun; onDelete(): void; fresh: boolean }) {
  const value = tone(run.status);
  const ok = run.steps.filter((step) => step.status === 'ok').length;

  return (
    <article className={`card lift${fresh ? ' fresh' : ''}`}>
      <header>
        <div className="card-title">
          <span className={`tile ${value}`} aria-hidden="true">
            {glyph(value)}
          </span>
          <div>
            <h3>{run.workflowName}</h3>
            <div className="status-line">
              <span className={`led ${value}`} aria-hidden="true" />
              <span>
                {ok}/{run.steps.length} steps · {run.durationMs}ms
              </span>
            </div>
          </div>
        </div>
        <div className="card-actions">
          <span className="chip">{new Date(run.startedAt).toLocaleString()}</span>
          <DeleteButton label={`Delete this run of "${run.workflowName}"`} onDelete={onDelete} />
        </div>
      </header>

      <ol className="timeline">
        {run.steps.map((step) => (
          <li key={step.id} className={tone(step.status)}>
            <span>{step.label}</span>
            {step.preview || step.error ? (
              <p className={`small ${step.error ? 'error' : 'muted'}`}>{step.error ?? step.preview}</p>
            ) : null}
          </li>
        ))}
      </ol>

      {run.finalPreview ? <p className="final">{run.finalPreview}</p> : null}
    </article>
  );
}

function Empty({ glyph: mark, children }: { glyph: string; children: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="glyph" aria-hidden="true">
        {mark}
      </span>
      {children}
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>('workflows');
  const [running, setRunning] = useState<string | null>(null);
  const [descriptors, setDescriptors] = useState<ToolDescriptor[]>([]);
  const [extension, setExtension] = useState<ExtensionCapability[] | null>(null);
  const [probing, setProbing] = useState(true);

  // One stable snapshot; slices are derived here rather than in the store, so
  // getSnapshot keeps returning the same reference between changes.
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const workflows = snapshot.workflows;
  const runs = useMemo(() => snapshot.runs.slice(0, 20), [snapshot]);

  /**
   * Re-reads the registry from the extension.
   *
   * Shared, because three things invalidate it: the page loading, the tab
   * regaining focus after something changed in another tab, and the visitor
   * opening or forgetting a site from this page.
   */
  const load = useCallback(async (): Promise<void> => {
    // The tool surface caches the registry to avoid re-paying a timeout on every
    // lookup; any of these moments is one where that cache should stop counting.
    forgetReachable();
    // Absence is the normal case, so this stays quiet and simply leaves the
    // cross-site sections unrendered.
    if (!(await detectExtension())) return;
    try {
      setExtension((await listExtensionCapabilities()).capabilities);
    } catch {
      setExtension(null);
    }
  }, []);

  useEffect(() => {
    seedIfEmpty(SEED);
    setDescriptors(registerTools());
    void load().finally(() => setProbing(false));

    /*
     * The registry changes in other tabs, and this page has no channel to hear
     * about it — the extension answers requests, it does not push. Coming back
     * to this tab is the moment the numbers are being read, so that is when they
     * are worth refreshing. Throttled, because focus fires readily.
     */
    let last = Date.now();
    const refresh = (): void => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 2_000) return;
      last = Date.now();
      void load();
    };

    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  /*
   * Anything that appeared while this tab was open, briefly highlighted.
   *
   * The store already pushes agent-created workflows and runs straight into the
   * UI — this only makes that visible, so a workflow arriving from an agent
   * reads as something that just happened rather than something always there.
   */
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const ids = new Set([...snapshot.workflows.map((item) => item.id), ...snapshot.runs.map((item) => item.id)]);
    const previous = seen.current;
    seen.current = ids;
    // First pass establishes the baseline: an existing library is not "new".
    if (previous === null) return;
    const added = [...ids].filter((id) => !previous.has(id));
    if (added.length === 0) return;
    setFresh(new Set(added));
    const timer = setTimeout(() => setFresh(new Set()), 3_000);
    return () => clearTimeout(timer);
  }, [snapshot]);

  const run = async (workflow: StoredWorkflow): Promise<void> => {
    setRunning(workflow.id);
    try {
      recordRun(await runWorkflow(workflow, new Map(Object.entries(TOOLS))));
      setTab('runs');
    } finally {
      setRunning(null);
    }
  };

  const meta = useMemo<CapabilityMeta>(() => {
    const providers: Record<string, string> = {};
    const risks: Record<string, 'read' | 'write'> = {};
    for (const [name, tool] of Object.entries(TOOLS)) {
      providers[name] = 'this site';
      risks[name] = tool.descriptor.annotations?.readOnlyHint === true ? 'read' : 'write';
    }
    for (const capability of extension ?? []) {
      providers[capability.id] = capability.provider;
      risks[capability.id] = capability.risk === 'read' ? 'read' : 'write';
    }
    return { providers, risks };
  }, [extension]);

  const sites = new Set((extension ?? []).map((item) => item.origin ?? item.provider));
  const counts: Record<Tab, number> = { workflows: workflows.length, runs: runs.length, sites: sites.size || 1 };
  const labels: Record<Tab, string> = { workflows: 'Workflows', runs: 'Runs', sites: 'What you can do' };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Mark />
          <div>
            <h1>Magpie</h1>
            <p className="muted small">Collects what sites can do, and composes it into reusable workflows.</p>
          </div>
        </div>

        <div className="stats">
          <div className="stat">
            <b>{descriptors.length}</b>
            <span>exposed here</span>
          </div>
          {extension ? (
            <>
              <div className="stat live">
                <b>{extension.length}</b>
                <span>reachable</span>
              </div>
              <div className="stat live">
                <b>{sites.size}</b>
                <span>sites</span>
              </div>
            </>
          ) : (
            <div className="stat">
              <b>—</b>
              <span>no extension</span>
            </div>
          )}
        </div>
      </header>

      <p className="lede">
        Your AI agent can only see the page it is on. Magpie remembers what every site you visit can do, so your agent
        can use them together — find something on one site, send it from another — without you switching tabs.
        Workflows and history stay in this browser.
      </p>

      <nav className="tabs">
        {(['workflows', 'runs', 'sites'] as Tab[]).map((name) => (
          <button key={name} type="button" className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
            {labels[name]}
            <span className="count">{counts[name]}</span>
          </button>
        ))}
      </nav>

      <main>
        {tab === 'workflows' && !extension ? (
          <article className="card muted-card">
            <h3>Running standalone</h3>
            {probing ? (
              <p className="muted">Looking for the Magpie extension…</p>
            ) : (
              <p className="muted">
                The Magpie extension is not connected, so only this site's own capabilities are reachable — a page
                cannot call tools on another origin, whatever is driving it. Everything here still works, and your
                agent can still list, compose, run and inspect through <code>document.modelContext</code>. Install the
                extension to add every WebMCP site you have visited.
              </p>
            )}
          </article>
        ) : null}

        {tab === 'workflows' ? (
          workflows.length > 0 ? (
            <div className="stack">
              {workflows.map((workflow) => (
                <WorkflowCard
                  key={workflow.id}
                  workflow={workflow}
                  running={running === workflow.id}
                  fresh={fresh.has(workflow.id)}
                  meta={meta}
                  onRun={() => void run(workflow)}
                  onDelete={() => {
                    // Authored work, so this one asks. A run is only a log line.
                    if (window.confirm(`Delete "${workflow.name}"? Its run history is kept.`)) {
                      deleteWorkflow(workflow.id);
                    }
                  }}
                />
              ))}
            </div>
          ) : (
            <Empty glyph="⬡">Nothing saved yet — ask your agent to compose one.</Empty>
          )
        ) : null}

        {tab === 'runs' ? (
          runs.length > 0 ? (
            <>
              <div className="grid">
                {runs.map((item) => (
                  <RunCard
                    key={item.id}
                    run={item}
                    fresh={fresh.has(item.id)}
                    onDelete={() => deleteRun(item.id)}
                  />
                ))}
              </div>
              <button
                type="button"
                className="link"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  if (window.confirm(`Delete all ${runs.length} runs? Your workflows are kept.`)) clearRuns();
                }}
              >
                Clear run history
              </button>
            </>
          ) : (
            <Empty glyph="◷">No runs yet — run a workflow, or ask your agent to.</Empty>
          )
        ) : null}

        {tab === 'sites' ? <Sites own={descriptors} extension={extension} onChanged={() => void load()} /> : null}
      </main>

      <footer>
        <p className="muted small">
          Workflows and runs are stored in your browser only.{' '}
          {extension
            ? 'The Magpie extension is connected — it only accepts requests from this origin, and still asks before writing anywhere.'
            : 'Install the Magpie extension to compose workflows from capabilities on other sites.'}
        </p>
      </footer>
    </div>
  );
}
