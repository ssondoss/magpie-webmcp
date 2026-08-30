import type { WorkflowStep } from '../../src/shared/schema';
import type { JsonObject, JsonValue, ToolDescriptor } from '../../src/shared/types';
import { getPath, newId, preview, resolveTemplates, toArray, toJson, variableName } from '../../src/shared/util';
import {
  applyTransform,
  conditionFields,
  describeGate,
  describeTransformResult,
  evaluateCondition,
  explainCondition,
} from '../../src/background/transform';
import type { StoredRun, StoredRunStep, StoredWorkflow } from './store';

/**
 * The site's own workflow engine.
 *
 * It shares `applyTransform` and the template resolver with the extension — those
 * modules touch no browser-extension API — so a workflow behaves identically
 * whether it runs here or in the panel. Only the set of callable tools differs.
 */

export interface WebTool {
  descriptor: ToolDescriptor;
  execute(args: JsonObject): Promise<JsonValue> | JsonValue;
}

function stepLabel(step: WorkflowStep, tools: Map<string, WebTool>): string {
  if (step.label) return step.label;
  if (step.type === 'tool') {
    const title = tools.get(step.tool)?.descriptor.annotations?.title;
    return `${title ?? step.tool}${step.forEach ? ' (each item)' : ''}`;
  }
  if (step.type === 'transform') return `${step.operation} ${step.input}`;
  if (step.type === 'reason') return step.instruction;
  if (step.type === 'gate') return describeGate(step);
  return `Missing: ${step.capability}`;
}

export async function runWorkflow(
  workflow: StoredWorkflow,
  tools: Map<string, WebTool>,
): Promise<StoredRun> {
  const startedAt = Date.now();
  const context: Record<string, unknown> = {};
  const steps: StoredRunStep[] = [];
  let lastOutput: string | undefined;
  let failed = false;
  let skipped = false;
  let stopped = false;

  for (const step of workflow.steps) {
    const record: StoredRunStep = {
      id: step.id,
      label: stepLabel(step, tools),
      type: step.type,
      status: 'ok',
    };

    try {
      if (step.type === 'missing') {
        record.status = 'skipped';
        record.error = step.reason || `No available capability can ${step.capability}`;
        skipped = true;
      } else if (step.type === 'reason') {
        // Judgement needs a model, and Magpie deliberately has none — the agent
        // driving this page does. Saying so is better than guessing.
        record.status = 'skipped';
        record.error =
          'This step needs a judgement Magpie cannot make on its own. Read the previous step’s data and decide it yourself, then continue.';
        skipped = true;
      } else if (step.type === 'gate') {
        // Conditions are deterministic local code, so a gate works here exactly as
        // it does in the extension — no model needed. Missing data stops the run
        // rather than being compared against nothing.
        const missingVars = conditionFields(step.condition).filter((name) => context[name] === undefined);
        const explanation =
          missingVars.length > 0
            ? `nothing produced ${missingVars.join(', ')}, so the check could not be made`
            : explainCondition(context, step.condition);
        if (missingVars.length === 0 && evaluateCondition(context, step.condition)) {
          record.preview = explanation;
        } else {
          record.status = 'skipped';
          record.preview = `Stopped — ${explanation}`;
          stopped = true;
          steps.push(record);
          break;
        }
      } else if (step.type === 'transform') {
        const input = getPath(context, variableName(step.input));
        if (input === undefined) {
          // An earlier step already reported why it could not run; repeating that
          // as a fresh failure here makes one problem look like two, and turns a
          // partial run into a failed one.
          if (skipped) {
            record.status = 'skipped';
            record.error = `Skipped — ${variableName(step.input)} comes from a step that did not run.`;
            steps.push(record);
            continue;
          }
          throw new Error(`"${variableName(step.input)}" was never produced by an earlier step`);
        }
        const value = applyTransform(step, input, context);
        context[step.output] = value;
        lastOutput = step.output;
        record.preview = describeTransformResult(input, value);
      } else {
        const tool = tools.get(step.tool);
        if (!tool) {
          record.status = 'skipped';
          record.error = `${step.tool} is not available on this site. The Magpie extension provides capabilities from other sites.`;
          skipped = true;
          steps.push(record);
          continue;
        }

        const call = async (scope: Record<string, unknown>): Promise<JsonValue> =>
          toJson(await tool.execute(resolveTemplates(step.arguments ?? {}, scope) as JsonObject));

        if (step.forEach) {
          const items = toArray(getPath(context, variableName(step.forEach)));
          const results: JsonValue[] = [];
          for (const [index, item] of items.entries()) {
            results.push(await call({ ...context, item, index }));
          }
          if (step.output) context[step.output] = results;
          record.preview = `${items.length} call${items.length === 1 ? '' : 's'} — ${preview(results)}`;
        } else {
          const value = await call(context);
          if (step.output) context[step.output] = value;
          record.preview = preview(value);
        }
        if (step.output) lastOutput = step.output;
      }
    } catch (error) {
      record.status = 'error';
      record.error = error instanceof Error ? error.message : String(error);
      failed = true;
      steps.push(record);
      break;
    }

    steps.push(record);
  }

  const finalValue = workflow.finalOutput
    ? getPath(context, variableName(workflow.finalOutput))
    : lastOutput
      ? context[lastOutput]
      : undefined;

  return {
    id: newId('run'),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: failed ? 'failed' : stopped || skipped ? 'partial' : 'completed',
    steps,
    finalPreview: finalValue === undefined ? undefined : preview(finalValue),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
}
