import type { JsonObject, RiskLevel, ToolDescriptor } from './types';
import { hash, humanize, isPlainObject, stableStringify } from './util';

const DESTRUCTIVE = /^(delete|remove|refund|cancel|revoke|drop|purge|destroy|terminate|close|reset)/;
const WRITE = /^(create|add|new|update|edit|set|send|post|submit|assign|patch|put|write|upload|pay|charge|approve|reject|transition|comment|schedule)/;

/** Risk is used for the approval gate, so annotations always win over name heuristics. */
export function inferRisk(tool: ToolDescriptor): RiskLevel {
  if (tool.annotations?.destructiveHint) return 'destructive';
  if (tool.annotations?.readOnlyHint) return 'read';
  const name = tool.name.toLowerCase();
  if (DESTRUCTIVE.test(name)) return 'destructive';
  if (WRITE.test(name)) return 'write';
  return 'read';
}

export function schemaHash(schema: JsonObject | undefined): string {
  return hash(stableStringify(schema ?? {}));
}

export function capabilityId(providerKey: string, toolName: string): string {
  return `${providerKey}.${toolName}`;
}

export function capabilityLabel(tool: ToolDescriptor): string {
  return tool.annotations?.title?.trim() || humanize(tool.name);
}

/** Normalizes whatever a page registered into the descriptor shape we store. */
export function normalizeDescriptor(raw: unknown): ToolDescriptor | null {
  if (!isPlainObject(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  const schemaSource = raw.inputSchema ?? (raw as Record<string, unknown>).input_schema ?? {};
  const inputSchema: JsonObject = isPlainObject(schemaSource)
    ? (schemaSource as JsonObject)
    : { type: 'object', properties: {} };
  const annotations = isPlainObject(raw.annotations) ? raw.annotations : undefined;
  return {
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    inputSchema,
    annotations: annotations as ToolDescriptor['annotations'],
  };
}

const RESERVED_PROVIDER_KEYS = new Set(['global', 'extension', 'agent', 'local']);

/** Derives a stable, collision-free namespace prefix for an origin. */
export function candidateProviderKey(origin: string, providerName?: string): string {
  if (providerName && providerName.trim()) return slugKey(providerName);
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^www\./, '');
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) {
      return slugKey(url.port ? `local_${url.port}` : 'local');
    }
    const labels = host.split('.');
    return slugKey(labels.length > 2 ? labels[0] : labels[0]);
  } catch {
    return slugKey(origin);
  }
}

function slugKey(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = base || 'site';
  return RESERVED_PROVIDER_KEYS.has(key) ? `${key}_site` : key;
}

export function providerDisplayName(origin: string, providerName?: string): string {
  if (providerName && providerName.trim()) return providerName.trim();
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^www\./, '');
    if (/^(localhost|127\.0\.0\.1)$/.test(host)) return `localhost:${url.port || '80'}`;
    return host;
  } catch {
    return origin;
  }
}
