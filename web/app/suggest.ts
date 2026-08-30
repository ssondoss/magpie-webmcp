import type { ToolDescriptor } from '../../src/shared/types';
import type { ExtensionCapability } from './extension';

/**
 * Turning a capability list into things a person can actually ask for.
 *
 * A registry of forty tool names tells a visitor nothing — the value is in the
 * combinations, and those are exactly what is invisible: that orders live on one
 * site and email on another, and an agent can span both. So this pairs something
 * that fetches with something that delivers, and writes the sentence out.
 *
 * Every pairing is built from capabilities that are actually present. Nothing
 * here is aspirational: if a suggestion is on screen, the agent can do it.
 */

export interface Pairing {
  id: string;
  from: { label: string; provider: string };
  to: { label: string; provider: string; writes: boolean };
  /** A sentence the visitor can paste straight into their agent. */
  prompt: string;
}

interface Source {
  id: string;
  label: string;
  provider: string;
  writes: boolean;
}

/** Reads better mid-sentence: "Search orders" → "search orders". */
function lower(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function fromOwn(own: ToolDescriptor[]): Source[] {
  return own.map((descriptor) => ({
    id: descriptor.name,
    label: descriptor.annotations?.title ?? descriptor.name,
    provider: 'this site',
    writes: descriptor.annotations?.readOnlyHint !== true,
  }));
}

function fromExtension(capabilities: ExtensionCapability[]): Source[] {
  return capabilities.map((capability) => ({
    id: capability.id,
    label: capability.label,
    provider: capability.provider,
    writes: capability.risk !== 'read',
  }));
}

/**
 * Fetch-then-deliver pairs, preferring ones that span two different sites —
 * a single-site combination is something the site could have built a button for,
 * so it demonstrates nothing about what Magpie adds.
 */
export function pairings(
  own: ToolDescriptor[],
  extension: ExtensionCapability[] | null,
  limit = 4,
): Pairing[] {
  const all = [...fromExtension(extension ?? []), ...fromOwn(own)];

  // Dedupe by id: with the extension connected this site appears in both lists.
  const seen = new Set<string>();
  const sources = all.filter((source) => {
    const key = `${source.provider}:${source.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const reads = sources.filter((source) => !source.writes);
  const delivers = sources.filter((source) => source.writes);
  if (reads.length === 0 || delivers.length === 0) return [];

  const results: Pairing[] = [];
  const used = new Set<string>();

  for (const crossSiteOnly of [true, false]) {
    for (const read of reads) {
      if (results.length >= limit) break;
      // One suggestion per source, so four rows are four different ideas.
      if (used.has(read.id)) continue;
      const target = delivers.find(
        (deliver) =>
          !used.has(deliver.id) &&
          deliver.id !== read.id &&
          (!crossSiteOnly || deliver.provider !== read.provider),
      );
      if (!target) continue;
      used.add(read.id);
      used.add(target.id);
      results.push({
        id: `${read.id}->${target.id}`,
        from: { label: read.label, provider: read.provider },
        to: { label: target.label, provider: target.provider, writes: target.writes },
        prompt: `Using Magpie, ${lower(read.label)} on ${read.provider}, then ${lower(target.label)}.`,
      });
    }
  }

  return results;
}
