import type { JsonObject, JsonValue } from './types';

/** Stable stringify so schema hashes do not change with key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'site'
  );
}

/** `search_orders` → `Search orders`, so the panel can avoid showing raw tool ids. */
export function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** Strips functions / non-clonable values so results survive postMessage + storage. */
export function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
  }
}

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ARRAY_KEYS = ['items', 'results', 'data', 'rows', 'records', 'list', 'values'];

/** The collection inside a result like `{ orders: [...], count: 12 }`, if there is one. */
export function embeddedArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return null;
  for (const key of ARRAY_KEYS) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  const arrays = Object.values(value).filter(Array.isArray) as unknown[][];
  return arrays.length === 1 ? arrays[0] : null;
}

/**
 * Tool results are commonly `{ orders: [...] }` rather than a bare array.
 * Transforms accept either so a workflow does not need an unwrap step.
 */
export function toArray(value: unknown): unknown[] {
  if (value == null) return [];
  return embeddedArray(value) ?? [value];
}

export function getPath(scope: unknown, path: string): unknown {
  if (!path) return scope;
  let current: unknown = scope;
  for (const rawKey of path.split('.')) {
    const key = rawKey.trim();
    if (current == null || key === '') return undefined;
    if (Array.isArray(current)) {
      if (key === 'length') {
        current = current.length;
        continue;
      }
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
      continue;
    }
    if (typeof current === 'string' && key === 'length') {
      current = current.length;
      continue;
    }
    return undefined;
  }
  return current;
}

const FULL_TEMPLATE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
const INLINE_TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Resolves `{{var}}` / `{{var.path}}` references inside arbitrary argument trees. */
export function resolveTemplates(value: unknown, scope: Record<string, unknown>): JsonValue {
  if (typeof value === 'string') {
    const full = value.match(FULL_TEMPLATE);
    if (full) return toJson(getPath(scope, full[1]));
    if (!value.includes('{{')) return value;
    return value.replace(INLINE_TEMPLATE, (_match, expr: string) => {
      const resolved = getPath(scope, expr.trim());
      if (resolved == null) return '';
      return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, scope));
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveTemplates(item, scope);
    return out;
  }
  return toJson(value);
}

/** Accepts `orders` or `{{orders}}` — agents produce both. */
export function variableName(reference: string): string {
  const full = reference.match(FULL_TEMPLATE);
  return (full ? full[1] : reference).trim();
}

const LABEL_KEYS = ['id', 'name', 'title', 'key', 'label', 'email'];

/** A short human handle for a row, so previews read as ids rather than raw JSON. */
function itemLabel(item: unknown): string {
  if (isPlainObject(item)) {
    for (const key of LABEL_KEYS) {
      const candidate = item[key];
      if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate);
    }
  }
  return oneLine(item, 40);
}

/**
 * One line describing a step's result, for the workflow view. Collections are
 * summarised by count and identifier — dumping raw JSON of 20 orders tells the
 * user nothing.
 */
export function preview(value: unknown, maxItems = 6): string {
  if (value == null) return 'no value';

  const scalars = isPlainObject(value)
    ? Object.entries(value).filter(([, item]) => item !== null && typeof item !== 'object')
    : [];

  // An object carrying several scalars is a status ({filename, rowCount, columns}),
  // not a collection — describe it by its fields rather than unwrapping the one
  // array it happens to contain. A result like {orders: [...], count: 9} has a
  // single scalar and the array really is the payload.
  const items = scalars.length >= 2 ? null : embeddedArray(value);

  if (items) {
    if (items.length === 0) return 'no results';
    const head = items.slice(0, maxItems).map(itemLabel);
    const rest = items.length > maxItems ? `, +${items.length - maxItems} more` : '';
    return `${items.length} result${items.length === 1 ? '' : 's'}: ${head.join(', ')}${rest}`;
  }

  if (scalars.length > 0) {
    return scalars
      .slice(0, 4)
      .map(([key, item]) => `${key}: ${String(item)}`)
      .join(', ');
  }

  return oneLine(value, 200);
}

function oneLine(value: unknown, max = 90): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Copying a URL out of a web page often drags the neighbouring button label in
 * with it ("https://… Copy to clipboard"), which then fails confusingly at the
 * far end. Keep only the first whitespace-delimited token, and require http(s).
 * Returns '' when the value cannot be used.
 */
export function normalizeHttpUrl(value: string): string {
  const first = value.trim().split(/\s+/)[0] ?? '';
  if (!first) return '';
  try {
    const url = new URL(first);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export interface ResultShape {
  rows?: number;
  fields?: string[];
  sample?: string[];
}

/**
 * What a workflow produced, compactly enough to put in a prompt.
 *
 * A follow-up like "send those to Slack" is unanswerable from a prose summary
 * alone — an agent needs the real field names to write correct references, and
 * a row or two so it can reason about actual values rather than guessing.
 */
export function describeShape(value: unknown, sampleRows = 2): ResultShape | undefined {
  if (value === undefined || value === null) return undefined;

  const items = embeddedArray(value);
  if (items) {
    if (items.length === 0) return { rows: 0 };
    const first = items.find(isPlainObject);
    return {
      rows: items.length,
      fields: first ? Object.keys(first) : undefined,
      sample: items.slice(0, sampleRows).map(rowSummary),
    };
  }

  if (isPlainObject(value)) {
    return { fields: Object.keys(value), sample: [rowSummary(value)] };
  }
  return { sample: [String(value).slice(0, 120)] };
}

function rowSummary(row: unknown): string {
  if (!isPlainObject(row)) return String(row).slice(0, 80);
  return Object.entries(row)
    .slice(0, 6)
    .map(([key, item]) => {
      const text = item === null || typeof item === 'object' ? JSON.stringify(item) : String(item);
      return `${key}=${text.length > 24 ? `${text.slice(0, 22)}…` : text}`;
    })
    .join(' · ');
}

/** Keeps prompts and run payloads bounded when a tool returns a large result set. */
export function truncateForModel(value: unknown, maxItems = 40): JsonValue {
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxItems).map((item) => toJson(item));
    return value.length > maxItems
      ? ({ truncated: true, totalCount: value.length, shown: kept.length, items: kept } as JsonValue)
      : (kept as JsonValue);
  }
  return toJson(value);
}
