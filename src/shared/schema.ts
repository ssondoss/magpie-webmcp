import { z } from 'zod';
import type { JsonValue } from './types';

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]),
);

export const jsonValueSchema = jsonValue;

export const comparisonOperators = [
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'in',
  'exists',
  'empty',
] as const;

export type Condition =
  | { field: string; operator: (typeof comparisonOperators)[number]; value?: JsonValue }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({
      field: z.string(),
      operator: z.enum(comparisonOperators),
      value: jsonValue.optional(),
    }),
    z.object({ all: z.array(conditionSchema) }),
    z.object({ any: z.array(conditionSchema) }),
    z.object({ not: conditionSchema }),
  ]),
);

/** Calls a real capability from the registry. */
export const toolStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal('tool'),
  label: z.string().optional(),
  tool: z.string().min(1),
  arguments: z.record(jsonValue).default({}),
  /** Variable (or `{{variable}}`) holding an array; the tool runs once per item as `{{item}}`. */
  forEach: z.string().optional(),
  output: z.string().optional(),
  continueOnError: z.boolean().optional(),
});

export const transformOperations = [
  'filter',
  'sort',
  'map',
  'group',
  'summarize',
  'limit',
  'unique',
  'flatten',
  'pick',
  'concat',
  'count',
] as const;

/** Local reasoning the agent does itself — never a fabricated tool. */
export const transformStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal('transform'),
  label: z.string().optional(),
  operation: z.enum(transformOperations),
  input: z.string().min(1),
  output: z.string().min(1),
  condition: conditionSchema.optional(),
  field: z.string().optional(),
  fields: z.array(z.string()).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  count: z.number().optional(),
  metrics: z
    .array(
      z.object({
        op: z.enum(['count', 'sum', 'avg', 'min', 'max']),
        field: z.string().optional(),
        as: z.string().min(1),
      }),
    )
    .optional(),
  groupBy: z.string().optional(),
  mapping: z.record(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
});

/**
 * Judgement the transform DSL cannot express — classification, extraction,
 * "looks like a supplier problem". The model shapes *data*; it can never call a
 * capability, so a reason step cannot cause an action the user did not approve.
 *
 * In `select` mode the model returns indices only and the engine maps them back
 * to the original rows, so it cannot fabricate or edit the data it filters.
 */
export const reasonStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal('reason'),
  label: z.string().optional(),
  input: z.string().min(1),
  instruction: z.string().min(1),
  output: z.string().min(1),
  mode: z.enum(['select', 'derive']).default('select'),
});

/**
 * Continue only if a condition holds; otherwise stop the run.
 *
 * `filter` narrows a list. A gate decides whether the *rest of the workflow*
 * happens at all — "only buy if gold is above 3,500 and I have the cash". Its
 * condition is evaluated against the run's variables rather than against one
 * row, so `field` is a path like "spot.quotes.0.price".
 *
 * A gate that stops is not a failure: "the condition was not met, so I did
 * nothing" is the correct outcome, and the run ends as CONDITIONS_NOT_MET.
 */
export const gateStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal('gate'),
  label: z.string().optional(),
  condition: conditionSchema,
});

/** A step the user asked for that no available capability can perform. */
export const missingStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal('missing'),
  label: z.string().optional(),
  capability: z.string().min(1),
  description: z.string().default(''),
  reason: z.string().default(''),
});

export const stepSchema = z.discriminatedUnion('type', [
  toolStepSchema,
  transformStepSchema,
  reasonStepSchema,
  gateStepSchema,
  missingStepSchema,
]);

/** Reply shapes for a reason step. `select` cannot introduce data, only choose it. */
export const reasonSelectSchema = z.object({
  keep: z.array(z.number().int()),
  why: z.string().default(''),
});

export const reasonDeriveSchema = z.object({
  value: jsonValue,
  why: z.string().default(''),
});

export const planSchema = z.object({
  name: z.string().min(1),
  summary: z.string().default(''),
  /**
   * ANSWER: the message needed no workflow — `reply` holds the response.
   * NEEDS_INPUT: a workflow is wanted but a required argument is unknown, so
   * `reply` asks for it. Nothing is built until the user answers.
   */
  status: z.enum(['SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'ANSWER', 'NEEDS_INPUT']),
  reply: z.string().optional(),
  steps: z.array(stepSchema),
  missingCapabilities: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().default(''),
        reason: z.string().default(''),
      }),
    )
    .default([]),
  finalOutput: z.string().optional(),
  clarification: z.string().optional(),
});

export type ToolStep = z.infer<typeof toolStepSchema>;
export type TransformStep = z.infer<typeof transformStepSchema>;
export type ReasonStep = z.infer<typeof reasonStepSchema>;
export type GateStep = z.infer<typeof gateStepSchema>;
export type MissingStep = z.infer<typeof missingStepSchema>;
export type WorkflowStep = z.infer<typeof stepSchema>;
export type WorkflowPlan = z.infer<typeof planSchema>;
export type PlanStatus = WorkflowPlan['status'];
export type MissingCapability = WorkflowPlan['missingCapabilities'][number];

export const replacementSchema = z.object({
  replacement: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
  rationale: z.string().default(''),
});

export type ReplacementSuggestion = z.infer<typeof replacementSchema>;

/** Flattens Zod issues into feedback an agent can act on when it retries. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}
