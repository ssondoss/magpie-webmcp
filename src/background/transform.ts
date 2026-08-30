import type { Condition, GateStep, TransformStep } from '../shared/schema';
import type { JsonObject, JsonValue } from '../shared/types';
import {
  embeddedArray,
  getPath,
  preview,
  resolveTemplates,
  toArray,
  toJson,
  variableName,
} from '../shared/util';

/**
 * Local reasoning operations.
 *
 * These exist so an agent never has to invent a `filter_orders` tool: filtering,
 * sorting, grouping and summarizing are the agent's own work, done here in
 * deterministic code rather than by generated JavaScript.
 */

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const leftDate = asDate(left);
  const rightDate = asDate(right);
  if (leftDate !== null && rightDate !== null) return leftDate - rightDate;
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  return String(left ?? '').localeCompare(String(right ?? ''));
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    // Tolerate currency-formatted values such as "$5,400.00".
    const cleaned = value.replace(/[$€£,\s]/g, '');
    if (cleaned === '' || Number.isNaN(Number(cleaned))) return null;
    return Number(cleaned);
  }
  return null;
}

function asDate(value: unknown): number | null {
  if (typeof value !== 'string' || !/\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function textOf(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function evaluateCondition(item: unknown, condition: Condition): boolean {
  if ('all' in condition) return condition.all.every((child) => evaluateCondition(item, child));
  if ('any' in condition) return condition.any.some((child) => evaluateCondition(item, child));
  if ('not' in condition) return !evaluateCondition(item, condition.not);

  const actual = condition.field === '' || condition.field === '.' ? item : getPath(item, condition.field);
  const expected = condition.value;

  switch (condition.operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'empty':
      return (
        actual === undefined ||
        actual === null ||
        actual === '' ||
        (Array.isArray(actual) && actual.length === 0)
      );
    case '==':
      return looseEquals(actual, expected);
    case '!=':
      return !looseEquals(actual, expected);
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const delta = compare(actual, expected);
      if (condition.operator === '>') return delta > 0;
      if (condition.operator === '>=') return delta >= 0;
      if (condition.operator === '<') return delta < 0;
      return delta <= 0;
    }
    case 'contains':
      if (Array.isArray(actual)) return actual.some((entry) => looseEquals(entry, expected));
      return textOf(actual).toLowerCase().includes(textOf(expected).toLowerCase());
    case 'notContains':
      if (Array.isArray(actual)) return !actual.some((entry) => looseEquals(entry, expected));
      return !textOf(actual).toLowerCase().includes(textOf(expected).toLowerCase());
    case 'startsWith':
      return textOf(actual).toLowerCase().startsWith(textOf(expected).toLowerCase());
    case 'endsWith':
      return textOf(actual).toLowerCase().endsWith(textOf(expected).toLowerCase());
    case 'in':
      return toArray(expected).some((entry) => looseEquals(actual, entry));
    default:
      return false;
  }
}

/** The operators that take no right-hand value, so labels do not read "x exists undefined". */
const UNARY_OPERATORS = new Set(['exists', 'empty']);

/** `amount > 5000 and status == delayed` — the condition without any data. */
export function conditionText(condition: Condition): string {
  if ('all' in condition) return condition.all.map(conditionText).join(' and ');
  if ('any' in condition) return condition.any.map(conditionText).join(' or ');
  if ('not' in condition) return `not (${conditionText(condition.not)})`;
  const field = condition.field || 'value';
  if (UNARY_OPERATORS.has(condition.operator)) return `${field} ${condition.operator}`;
  return `${field} ${condition.operator} ${textOf(condition.value)}`;
}

/**
 * The same condition with the real values substituted, so a gate that stopped a
 * run says *why* — "spot.quotes.0.price = 3412.5 > 3500 ✗" rather than "false".
 */
export function explainCondition(scope: unknown, condition: Condition): string {
  if ('all' in condition) {
    return condition.all.map((child) => explainCondition(scope, child)).join(' and ');
  }
  if ('any' in condition) {
    return condition.any.map((child) => explainCondition(scope, child)).join(' or ');
  }
  if ('not' in condition) return `not (${explainCondition(scope, condition.not)})`;

  const mark = evaluateCondition(scope, condition) ? '✓' : '✗';
  const field = condition.field || 'value';
  const actual = condition.field ? getPath(scope, condition.field) : scope;
  const shown = actual === undefined ? 'nothing' : textOf(actual);
  if (UNARY_OPERATORS.has(condition.operator)) return `${field} = ${shown} ${condition.operator} ${mark}`;
  return `${field} = ${shown} ${condition.operator} ${textOf(condition.value)} ${mark}`;
}

/**
 * Root variable names a condition reads. Gate conditions are checked against the
 * run's variables, so a step must not reference one before an earlier step makes it.
 */
export function conditionFields(condition: Condition): string[] {
  const found = new Set<string>();
  const walk = (node: Condition): void => {
    if ('all' in node) return node.all.forEach(walk);
    if ('any' in node) return node.any.forEach(walk);
    if ('not' in node) return walk(node.not);
    const root = variableName(node.field).split('.')[0].trim();
    if (root) found.add(root);
  };
  walk(condition);
  return [...found];
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(toJson(left)) === JSON.stringify(toJson(right));
  }
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber === rightNumber;
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function metricValue(
  op: 'count' | 'sum' | 'avg' | 'min' | 'max',
  items: unknown[],
  field: string | undefined,
): JsonValue {
  if (op === 'count') return items.length;
  const numbers = items
    .map((item) => asNumber(field ? getPath(item, field) : item))
    .filter((value): value is number => value !== null);
  if (numbers.length === 0) return op === 'sum' ? 0 : null;
  switch (op) {
    case 'sum':
      return numbers.reduce((total, value) => total + value, 0);
    case 'avg':
      return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    case 'min':
      return Math.min(...numbers);
    default:
      return Math.max(...numbers);
  }
}

function groupItems(items: unknown[], field: string): Record<string, unknown[]> {
  const groups: Record<string, unknown[]> = {};
  for (const item of items) {
    const key = textOf(getPath(item, field)) || 'unknown';
    (groups[key] ??= []).push(item);
  }
  return groups;
}

export function applyTransform(
  step: TransformStep,
  inputValue: unknown,
  scope: Record<string, unknown>,
): JsonValue {
  const items = toArray(inputValue);

  switch (step.operation) {
    case 'filter': {
      if (!step.condition) throw new Error(`Step ${step.id}: filter requires a condition`);
      const condition = step.condition;
      return toJson(items.filter((item) => evaluateCondition(item, condition)));
    }

    case 'sort': {
      const field = step.field;
      const direction = step.direction === 'desc' ? -1 : 1;
      const sorted = [...items].sort(
        (a, b) => direction * compare(field ? getPath(a, field) : a, field ? getPath(b, field) : b),
      );
      return toJson(sorted);
    }

    case 'map': {
      if (step.mapping && Object.keys(step.mapping).length > 0) {
        const mapping = step.mapping;
        return toJson(
          items.map((item, index) => {
            const row: JsonObject = {};
            for (const [key, template] of Object.entries(mapping)) {
              row[key] = resolveTemplates(template, { ...scope, item, index });
            }
            return row;
          }),
        );
      }
      if (step.field) return toJson(items.map((item) => getPath(item, step.field as string)));
      throw new Error(`Step ${step.id}: map requires either "mapping" or "field"`);
    }

    case 'pick': {
      const fields = step.fields ?? (step.field ? [step.field] : []);
      if (fields.length === 0) throw new Error(`Step ${step.id}: pick requires "fields"`);
      return toJson(
        items.map((item) => {
          const row: JsonObject = {};
          for (const field of fields) row[field] = toJson(getPath(item, field));
          return row;
        }),
      );
    }

    case 'group': {
      if (!step.field) throw new Error(`Step ${step.id}: group requires "field"`);
      return toJson(groupItems(items, step.field));
    }

    case 'summarize': {
      const metrics = step.metrics ?? [{ op: 'count' as const, as: 'count' }];
      const summarizeOne = (subset: unknown[]): JsonObject => {
        const row: JsonObject = {};
        for (const metric of metrics) row[metric.as] = metricValue(metric.op, subset, metric.field);
        return row;
      };
      if (step.groupBy) {
        const groups = groupItems(items, step.groupBy);
        const out: JsonObject = {};
        for (const [key, subset] of Object.entries(groups)) out[key] = summarizeOne(subset);
        return out;
      }
      return summarizeOne(items);
    }

    case 'limit': {
      const count = Math.max(0, Math.floor(step.count ?? items.length));
      return toJson(items.slice(0, count));
    }

    case 'unique': {
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const item of items) {
        const key = textOf(step.field ? getPath(item, step.field) : item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return toJson(out);
    }

    case 'flatten':
      return toJson(items.flatMap((item) => (Array.isArray(item) ? item : toArray(item))));

    case 'count':
      return items.length;

    case 'concat': {
      const sources = step.inputs && step.inputs.length > 0 ? step.inputs : [step.input];
      const merged: unknown[] = [];
      for (const source of sources) {
        merged.push(...toArray(getPath(scope, variableName(source))));
      }
      return toJson(merged);
    }

    default:
      throw new Error(`Step ${step.id}: unsupported operation`);
  }
}

/**
 * A transform that silently drops every row is almost always a bad condition, so
 * the before/after counts are shown rather than just the (empty) result.
 */
export function describeTransformResult(input: unknown, output: unknown): string {
  const after = embeddedArray(output);
  if (!after) return preview(output);
  const before = toArray(input).length;
  return before === after.length ? preview(output) : `${before} → ${preview(output)}`;
}

export function describeTransform(step: TransformStep): string {
  if (step.label) return step.label;
  switch (step.operation) {
    case 'filter':
      return `Filter ${step.input}${step.condition ? ` where ${conditionText(step.condition)}` : ''}`;
    case 'sort':
      return `Sort ${step.input} by ${step.field ?? 'value'} ${step.direction ?? 'asc'}`;
    case 'summarize':
      return `Summarize ${step.input}`;
    case 'limit':
      return `Take first ${step.count ?? 'n'} of ${step.input}`;
    default:
      return `${step.operation} ${step.input}`;
  }
}

export function describeGate(step: GateStep): string {
  return step.label ?? `Continue only if ${conditionText(step.condition)}`;
}
