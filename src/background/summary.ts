import type { WorkflowPlan } from '../shared/schema';
import type { JsonValue, RunSnapshot } from '../shared/types';
import { preview } from '../shared/util';

/**
 * Describing a run, and declining to guess.
 *
 * Magpie has no model of its own — the agent driving it does. So the summary
 * here is deterministic prose over what actually happened, and a `reason` step
 * is reported back rather than attempted. Both are honest: the caller is an
 * agent perfectly capable of reading the data and judging for itself.
 */

export interface ReasonRequest {
  instruction: string;
  items: unknown[];
  mode: 'select' | 'derive';
}

export interface ReasonOutcome {
  /** Indices of the kept items, in `select` mode. */
  keep?: number[];
  value?: JsonValue;
  why: string;
}

/**
 * A `reason` step needs judgement, which is exactly the thing Magpie does not
 * do. Failing loudly beats inventing an answer, and the message is addressed to
 * whoever is reading it: read the data and decide.
 */
export function declineToReason(request: ReasonRequest): Promise<ReasonOutcome> {
  return Promise.reject(
    new Error(
      `"${request.instruction}" is a judgement Magpie does not make on its own. ` +
        'Read the data from the previous step and decide it yourself, then continue with the remaining steps.',
    ),
  );
}

/** Plain description of a finished run, for the caller to relay or ignore. */
export function summarize(plan: WorkflowPlan, run: RunSnapshot, finalValue: unknown): string {
  const parts: string[] = [];

  // A gate stopped the run. Listing every unreached step as "not done" would read
  // as breakage; what the user needs is the check that did not hold.
  if (run.status === 'conditions_not_met') {
    const gate = run.steps.find((step) => step.type === 'gate' && step.status === 'skipped');
    return `"${plan.name}" checked its condition and did nothing further — ${gate?.preview ?? 'the condition was not met'}.`;
  }

  const ok = run.steps.filter((step) => step.status === 'ok').length;
  parts.push(
    run.status === 'completed'
      ? `Ran "${plan.name}" — ${ok}/${run.steps.length} steps completed.`
      : `"${plan.name}" ${run.status}: ${run.error ?? 'see step details.'}`,
  );
  // The data is right here — a bare count tells the user nothing they can act on.
  const final = preview(finalValue, 8);
  if (final !== 'no value') parts.push(`Result — ${final}`);
  const skipped = run.steps.filter((step) => step.status === 'skipped' || step.status === 'blocked');
  for (const step of skipped) parts.push(`Not done: ${step.label} — ${step.error ?? 'unavailable'}.`);
  return parts.join(' ');
}
