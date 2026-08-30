import { useState } from 'react';
import type { WorkflowStep } from '../src/shared/schema';
import { conditionText } from '../src/background/transform';

/**
 * A workflow as a node graph.
 *
 * Shape carries the meaning, not colour alone: a node that only reads is a
 * generously rounded tile, a node that changes something on a real site is
 * squarer and warmer, local work is a pill, a condition is a hexagon, and the
 * result is a terminal. You can tell what a workflow will do to the world from
 * its silhouette, before reading a word of it.
 *
 * Detail appears in a panel below rather than a floating popover: this can sit
 * inside a scroll container, which clips absolutely-positioned tooltips, and an
 * inline panel is also the only version that works on touch.
 */

export interface NodeStatus {
  status: 'ok' | 'error' | 'skipped' | 'running';
  preview?: string;
  error?: string;
}

/** What a node does to the world — the thing shape encodes. */
type Role = 'read' | 'write' | 'local' | 'gate' | 'missing';

interface Props {
  steps: WorkflowStep[];
  /** Per-step run state, keyed by step id. Absent before a run. */
  results?: Record<string, NodeStatus>;
  finalOutput?: string;
  /** Tool id → provider display name, so each node says which site it calls. */
  providers?: Record<string, string>;
  /** Tool id → whether calling it changes anything. Drives the node's shape. */
  risks?: Record<string, 'read' | 'write'>;
}

const ROLE_GLYPH: Record<Role | 'result', string> = {
  read: '◎',
  write: '✎',
  local: '⇄',
  gate: '◈',
  missing: '✕',
  result: '▤',
};

const ROLE_NOTE: Record<Role, string> = {
  read: 'reads only — changes nothing',
  write: 'changes something on a real site',
  local: 'local to the agent — no site involved',
  gate: 'a check — nothing after it runs unless it holds',
  missing: 'no available capability can do this',
};

const STATE_GLYPH: Record<string, string> = { ok: '✓', error: '✗', skipped: '–' };

function role(step: WorkflowStep, risks?: Props['risks']): Role {
  switch (step.type) {
    case 'tool':
      return risks?.[step.tool] === 'write' ? 'write' : 'read';
    case 'transform':
    case 'reason':
      return 'local';
    case 'gate':
      return 'gate';
    default:
      return 'missing';
  }
}

function shortLabel(step: WorkflowStep): string {
  if (step.label) return step.label;
  switch (step.type) {
    case 'tool':
      return step.tool.split('.').slice(-1)[0].replace(/_/g, ' ');
    case 'transform':
      return `${step.operation} ${step.input}`;
    case 'reason':
      return step.instruction.length > 40 ? `${step.instruction.slice(0, 38)}…` : step.instruction;
    case 'gate': {
      const text = `only if ${conditionText(step.condition)}`;
      return text.length > 40 ? `${text.slice(0, 38)}…` : text;
    }
    default:
      return step.capability;
  }
}

/**
 * For a tool step the site matters more than the word "tool" — two sites can
 * expose the same capability, and this is what says which one runs.
 */
function nodeKind(step: WorkflowStep, providers?: Record<string, string>): string {
  if (step.type !== 'tool') return step.type;
  const named = providers?.[step.tool];
  if (named) return named;
  const [namespace, rest] = step.tool.split('.');
  return rest ? namespace : 'this site';
}

/** A labelled row in the detail panel; `key` is absent for free-standing notes. */
interface Detail {
  key?: string;
  value: string;
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Enough to audit the step without reading JSON. */
function details(step: WorkflowStep): Detail[] {
  const rows: Detail[] = [];
  switch (step.type) {
    case 'tool': {
      rows.push({ key: 'calls', value: step.tool });
      if (step.forEach) rows.push({ key: 'repeats', value: `once per item of ${step.forEach}` });
      for (const [key, value] of Object.entries(step.arguments ?? {})) {
        rows.push({ key, value: truncate(typeof value === 'string' ? value : JSON.stringify(value)) });
      }
      if (step.output) rows.push({ key: 'saves as', value: step.output });
      break;
    }
    case 'transform': {
      rows.push({ key: 'data', value: `${step.input} → ${step.output}` });
      if (step.condition) rows.push({ key: 'where', value: conditionText(step.condition) });
      if (step.field) rows.push({ key: 'field', value: `${step.field}${step.direction ? ` (${step.direction})` : ''}` });
      if (step.groupBy) rows.push({ key: 'grouped by', value: step.groupBy });
      if (step.metrics) {
        rows.push({ key: 'metrics', value: step.metrics.map((m) => `${m.op}(${m.field ?? '·'})`).join(', ') });
      }
      if (typeof step.count === 'number') rows.push({ key: 'count', value: String(step.count) });
      break;
    }
    case 'reason': {
      rows.push({ value: step.instruction });
      rows.push({ key: 'data', value: `${step.input} → ${step.output}` });
      break;
    }
    case 'gate': {
      rows.push({ key: 'continue if', value: conditionText(step.condition) });
      rows.push({ value: 'Nothing below this runs unless it holds. Stopping is a normal outcome.' });
      break;
    }
    default:
      rows.push({ value: step.reason || 'No available capability can do this.' });
  }
  return rows;
}

export function WorkflowDiagram({ steps, results, finalOutput, providers, risks }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = steps.find((step) => step.id === activeId);
  const activeResult = activeId ? results?.[activeId] : undefined;
  const activeIndex = steps.findIndex((step) => step.id === activeId);
  const activeRole = active ? role(active, risks) : undefined;

  // Only claim a legend entry for shapes actually on the canvas.
  const present = [...new Set(steps.map((step) => role(step, risks)))];

  return (
    <div className="diagram-wrap">
      <div className="canvas">
        <div className="graph">
          {steps.map((step, index) => {
            const result = results?.[step.id];
            const state = result?.status ?? (step.type === 'missing' ? 'skipped' : 'idle');
            const kind = role(step, risks);
            return (
              <div key={step.id} className="slot">
                {index > 0 ? <span className={`wire${result?.status === 'running' ? ' live' : ''}`} /> : null}
                <div className="gnode-wrap">
                  <button
                    type="button"
                    className={`gnode ${kind} ${state}${activeId === step.id ? ' active' : ''}`}
                    onMouseEnter={() => setActiveId(step.id)}
                    onFocus={() => setActiveId(step.id)}
                    onClick={() => setActiveId(activeId === step.id ? null : step.id)}
                    title={`${shortLabel(step)} — ${ROLE_NOTE[kind]}`}
                  >
                    <span className="gnode-index" aria-hidden="true">
                      {index + 1}
                    </span>
                    {result && result.status !== 'running' ? (
                      <span className={`gnode-state ${result.status}`} aria-hidden="true">
                        {STATE_GLYPH[result.status]}
                      </span>
                    ) : null}
                    <span className="gnode-glyph" aria-hidden="true">
                      {ROLE_GLYPH[kind]}
                    </span>
                    <span className="gnode-name">{shortLabel(step)}</span>
                    <span className="gnode-site">{nodeKind(step, providers)}</span>
                  </button>
                </div>
              </div>
            );
          })}

          {finalOutput ? (
            <div className="slot">
              <span className="wire" />
              <div className="gnode-wrap">
                <div className="gnode result">
                  <span className="gnode-glyph" aria-hidden="true">
                    {ROLE_GLYPH.result}
                  </span>
                  <span className="gnode-name">{finalOutput}</span>
                  <span className="gnode-site">result</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="legend">
        {present.map((kind) => (
          <span key={kind} className={`legend-item ${kind}`}>
            <i className={`swatch ${kind}`} aria-hidden="true" />
            {kind === 'read'
              ? 'reads'
              : kind === 'write'
                ? 'writes'
                : kind === 'local'
                  ? 'local'
                  : kind === 'gate'
                    ? 'check'
                    : 'missing'}
          </span>
        ))}
      </div>

      <div className="diagram-detail" onMouseLeave={() => setActiveId(null)}>
        {active && activeRole ? (
          <>
            <div className="detail-head">
              <span className={`swatch ${activeRole}`} aria-hidden="true" />
              <strong>
                {activeIndex + 1}. {shortLabel(active)}
              </strong>
              <span className={`chip ${activeRole === 'write' ? 'warn' : ''}`}>{ROLE_NOTE[activeRole]}</span>
              {active.type === 'tool' ? <span className="chip">on {nodeKind(active, providers)}</span> : null}
            </div>

            {details(active)
              .filter((row) => !row.key)
              .map((row) => (
                <p key={row.value} className="detail-note">
                  {row.value}
                </p>
              ))}

            <dl className="detail-rows">
              {details(active)
                .filter((row) => row.key)
                .map((row) => (
                  <div key={row.key} style={{ display: 'contents' }}>
                    <dt>{row.key}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
            </dl>

            {activeResult?.preview ? <div className="detail-result ok">{activeResult.preview}</div> : null}
            {activeResult?.error ? <div className="detail-result bad">{activeResult.error}</div> : null}
          </>
        ) : (
          <p className="detail-empty">
            <span aria-hidden="true">◇</span> Hover or tap a node for what it calls, with which arguments.
          </p>
        )}
      </div>
    </div>
  );
}
