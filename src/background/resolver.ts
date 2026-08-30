import type { WorkflowPlan } from '../shared/schema';
import type {
  Capability,
  ReplacementCandidate,
  RequiredCapability,
  RequirementStatus,
  SavedWorkflow,
} from '../shared/types';
import { capabilityLabel, schemaHash } from '../shared/capability';
import { humanize } from '../shared/util';
import { GLOBAL_PROVIDER_KEY, GLOBAL_TOOLS, isConfigured } from './global-tools';
import { buildCapabilities, liveSiteForOrigin, waitForSite } from './registry';
import { getKnownSites, getSettings } from './storage';

const SITE_READY_TIMEOUT_MS = 25_000;

export function capabilityToRequired(capability: Capability): RequiredCapability {
  return {
    tool: capability.id,
    name: capability.name,
    label: capability.label,
    description: capability.description,
    provider: capability.provider,
    origin: capability.origin,
    source: capability.source,
    inputSchema: capability.inputSchema,
    schemaHash: capability.schemaHash ?? schemaHash(capability.inputSchema),
  };
}

/** Tool ids referenced by a plan, in first-use order. */
export function planToolIds(plan: WorkflowPlan): string[] {
  const ids: string[] = [];
  for (const step of plan.steps) {
    if (step.type === 'tool' && !ids.includes(step.tool)) ids.push(step.tool);
  }
  return ids;
}

export async function requirementsFromPlan(plan: WorkflowPlan): Promise<RequirementStatus[]> {
  const capabilities = await buildCapabilities();
  const requirements = planToolIds(plan).map((id) => {
    const capability = capabilities.find((item) => item.id === id);
    if (capability) return capabilityToRequired(capability);
    return {
      tool: id,
      name: id.split('.').slice(1).join('.') || id,
      label: humanize(id.split('.').slice(1).join('.') || id),
      description: '',
      provider: id.split('.')[0],
      source: 'webmcp' as const,
      inputSchema: {},
      schemaHash: '',
    };
  });
  return Promise.all(requirements.map((requirement) => resolveRequirement(requirement, capabilities)));
}

export async function requirementsFromWorkflow(workflow: SavedWorkflow): Promise<RequirementStatus[]> {
  const capabilities = await buildCapabilities();
  return Promise.all(
    workflow.requiredCapabilities.map((requirement) => resolveRequirement(requirement, capabilities)),
  );
}

async function candidatesForOrigin(origin: string | undefined, exclude: string): Promise<ReplacementCandidate[]> {
  if (!origin) return [];
  const site = liveSiteForOrigin(origin);
  if (!site) return [];
  const capabilities = await buildCapabilities();
  return capabilities
    .filter((item) => item.origin === origin && item.status === 'AVAILABLE' && item.id !== exclude)
    .map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      provider: item.provider,
    }));
}

/**
 * Decides the live state of one required capability.
 *
 * Saved workflows only store tool *references*, never executable code, so this is
 * where a reference is matched back to something that actually exists right now.
 */
export async function resolveRequirement(
  requirement: RequiredCapability,
  capabilities: Capability[],
): Promise<RequirementStatus> {
  const base = {
    tool: requirement.tool,
    label: requirement.label || humanize(requirement.name),
    provider: requirement.provider,
    origin: requirement.origin,
    source: requirement.source,
  };

  if (requirement.source === 'extension') {
    const name = requirement.tool.startsWith(`${GLOBAL_PROVIDER_KEY}.`)
      ? requirement.tool.slice(GLOBAL_PROVIDER_KEY.length + 1)
      : requirement.name;
    const tool = GLOBAL_TOOLS[name];
    if (!tool) {
      return { ...base, status: 'TOOL_MISSING', detail: 'This extension no longer provides that tool.' };
    }
    // A tool awaiting one-time setup behaves like a site awaiting sign-in.
    if (!isConfigured(tool, await getSettings())) {
      return { ...base, status: 'AUTH_REQUIRED', detail: tool.configHint };
    }
    return { ...base, status: 'AVAILABLE' };
  }

  const capability = capabilities.find((item) => item.id === requirement.tool);

  if (capability) {
    if (
      capability.status === 'AVAILABLE' &&
      requirement.schemaHash &&
      capability.schemaHash &&
      capability.schemaHash !== requirement.schemaHash
    ) {
      return {
        ...base,
        status: 'TOOL_CHANGED',
        detail: `${capability.provider} changed the inputs for ${capability.label}. It can still run, but arguments may need review.`,
      };
    }
    return {
      ...base,
      label: capability.label,
      provider: capability.provider,
      origin: capability.origin,
      status: capability.status,
      detail: capability.statusDetail,
      candidates:
        capability.status === 'TOOL_MISSING'
          ? await candidatesForOrigin(capability.origin, requirement.tool)
          : undefined,
    };
  }

  const knownSites = await getKnownSites();
  const known = requirement.origin ? knownSites[requirement.origin] : undefined;

  if (requirement.origin && liveSiteForOrigin(requirement.origin)) {
    return {
      ...base,
      status: 'TOOL_MISSING',
      detail: `${requirement.provider} is open but no longer exposes ${base.label}.`,
      candidates: await candidatesForOrigin(requirement.origin, requirement.tool),
    };
  }

  if (requirement.origin && (known || requirement.origin.startsWith('http'))) {
    return {
      ...base,
      status: 'SITE_CLOSED',
      detail: `${requirement.provider} is not open.`,
    };
  }

  return {
    ...base,
    status: 'TOOL_MISSING',
    detail: 'No known provider exposes this capability.',
  };
}

/** Opens (or focuses) the tab for a provider origin. */
export async function openProvider(origin: string, focus = true): Promise<number | undefined> {
  const knownSites = await getKnownSites();
  const url = knownSites[origin]?.url ?? origin;
  const existing = await chrome.tabs.query({ url: `${origin}/*` });
  if (existing.length > 0 && typeof existing[0].id === 'number') {
    if (focus) {
      await chrome.tabs.update(existing[0].id, { active: true });
      if (typeof existing[0].windowId === 'number') {
        await chrome.windows.update(existing[0].windowId, { focused: true });
      }
    }
    return existing[0].id;
  }
  const tab = await chrome.tabs.create({ url, active: focus });
  return tab.id;
}

export interface EnsureResult {
  ok: boolean;
  capability?: Capability;
  requirement: RequirementStatus;
}

/**
 * Guarantees a capability is executable right now, reopening its site if allowed.
 * Never touches credentials — if the site needs a login the user does it normally.
 */
export async function ensureCapability(
  toolId: string,
  options: { autoOpen: boolean; timeoutMs?: number } = { autoOpen: true },
): Promise<EnsureResult> {
  const capabilities = await buildCapabilities();
  const existing = capabilities.find((item) => item.id === toolId);

  const requirement: RequiredCapability = existing
    ? capabilityToRequired(existing)
    : await inferRequirement(toolId);

  let status = await resolveRequirement(requirement, capabilities);

  if (status.status === 'AVAILABLE' || status.status === 'TOOL_CHANGED') {
    return { ok: true, capability: existing ?? undefined, requirement: status };
  }

  if (status.status === 'SITE_CLOSED' && requirement.origin && options.autoOpen) {
    await openProvider(requirement.origin, true);
    await waitForSite(requirement.origin, requirement.name, options.timeoutMs ?? SITE_READY_TIMEOUT_MS);
    const refreshed = await buildCapabilities();
    const found = refreshed.find((item) => item.id === toolId);
    status = await resolveRequirement(requirement, refreshed);
    if (status.status === 'AVAILABLE' || status.status === 'TOOL_CHANGED') {
      return { ok: true, capability: found, requirement: status };
    }
  }

  return { ok: false, requirement: status };
}

/** Rebuilds a requirement for a tool id we have no live capability for. */
async function inferRequirement(toolId: string): Promise<RequiredCapability> {
  const [providerKey, ...rest] = toolId.split('.');
  const name = rest.join('.') || toolId;
  if (providerKey === GLOBAL_PROVIDER_KEY) {
    const tool = GLOBAL_TOOLS[name];
    return {
      tool: toolId,
      name,
      label: tool ? capabilityLabel(tool.descriptor) : humanize(name),
      description: tool?.descriptor.description ?? '',
      provider: 'Extension',
      source: 'extension',
      inputSchema: tool?.descriptor.inputSchema ?? {},
      schemaHash: '',
    };
  }
  const knownSites = await getKnownSites();
  const known = Object.values(knownSites).find((site) => site.providerKey === providerKey);
  const tool = known?.tools.find((item) => item.name === name);
  return {
    tool: toolId,
    name,
    label: tool ? capabilityLabel(tool) : humanize(name),
    description: tool?.description ?? '',
    provider: known?.provider ?? providerKey,
    origin: known?.origin,
    source: 'webmcp',
    inputSchema: tool?.inputSchema ?? {},
    schemaHash: '',
  };
}

/** Live tools of every remembered site, used when proposing drift replacements. */
export async function replacementCandidates(toolId: string): Promise<ReplacementCandidate[]> {
  const [providerKey] = toolId.split('.');
  const capabilities = await buildCapabilities();
  const sameProvider = capabilities.filter(
    (item) => item.providerKey === providerKey && item.id !== toolId && item.source === 'webmcp',
  );
  const pool = sameProvider.length > 0 ? sameProvider : capabilities.filter((item) => item.id !== toolId);
  return pool.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    provider: item.provider,
  }));
}

export function rewriteWorkflowTool(workflow: SavedWorkflow, from: string, to: string, capability: Capability): SavedWorkflow {
  const serialized = JSON.stringify(workflow.steps);
  const steps = JSON.parse(
    serialized.replace(new RegExp(`"tool":\\s*"${escapeRegExp(from)}"`, 'g'), `"tool":"${to}"`),
  );
  const requiredCapabilities = workflow.requiredCapabilities.map((requirement) =>
    requirement.tool === from ? capabilityToRequired(capability) : requirement,
  );
  return { ...workflow, steps, requiredCapabilities };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
