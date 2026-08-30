import type { KnownSite, Settings } from '../shared/types';
import { normalizeHttpUrl } from '../shared/util';

const KEYS = {
  settings: 'settings',
  knownSites: 'knownSites',
  providerKeys: 'providerKeys',
} as const;

export const DEFAULT_SETTINGS: Settings = {
  autoOpenSites: true,
  slackWebhookUrl: '',
  emailClient: 'gmail',
};

async function read<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as T | undefined) ?? fallback;
}

async function write(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings(): Promise<Settings> {
  const stored = await read<Partial<Settings>>(KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * Settings arrive from the panel as a loose patch. Validate every field here
 * rather than trusting the sender: a value that is merely *present* but unusable
 * (a URL with a stray word in it) otherwise looks configured right up until it
 * fails mid-run.
 *
 * A field that fails validation is dropped, so the previous good value survives.
 */
export function sanitizeSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  const clean: Partial<Settings> = {};

  if (typeof patch.autoOpenSites === 'boolean') clean.autoOpenSites = patch.autoOpenSites;
  if (patch.emailClient === 'gmail' || patch.emailClient === 'mailto') {
    clean.emailClient = patch.emailClient;
  }

  // Empty is meaningful here — it is how the webhook is removed.
  if (typeof patch.slackWebhookUrl === 'string') {
    clean.slackWebhookUrl = normalizeHttpUrl(patch.slackWebhookUrl);
  }

  return clean;
}

/**
 * Settings writes are read-modify-write, so two overlapping calls would each read
 * the same "before" and the second would silently discard the first — losing, say,
 * a profile that was being saved at the same moment. Serialising them removes that
 * class of loss entirely.
 */
let settingsQueue: Promise<unknown> = Promise.resolve();

export function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = settingsQueue.then(async () => {
    const merged = { ...(await getSettings()), ...sanitizeSettingsPatch(patch) };
    await write(KEYS.settings, merged);
    return merged;
  });
  // Keep the chain alive even if one write rejects.
  settingsQueue = next.catch(() => undefined);
  return next;
}

export async function getKnownSites(): Promise<Record<string, KnownSite>> {
  return read<Record<string, KnownSite>>(KEYS.knownSites, {});
}

export async function putKnownSite(site: KnownSite): Promise<void> {
  const sites = await getKnownSites();
  sites[site.origin] = site;
  await write(KEYS.knownSites, sites);
}

export async function deleteKnownSite(origin: string): Promise<void> {
  const sites = await getKnownSites();
  delete sites[origin];
  await write(KEYS.knownSites, sites);
}

/** `from` records whether the namespace came from a declared provider name or the hostname. */
export interface ProviderKeyRecord {
  key: string;
  from: 'name' | 'host';
}

/**
 * Namespace prefixes are persisted so that a saved workflow's `orders.*` ids keep
 * pointing at the same origin across sessions, even if discovery order changes.
 */
export async function getProviderKeys(): Promise<Record<string, ProviderKeyRecord>> {
  return read<Record<string, ProviderKeyRecord>>(KEYS.providerKeys, {});
}

export async function setProviderKey(origin: string, record: ProviderKeyRecord): Promise<void> {
  const keys = await getProviderKeys();
  keys[origin] = record;
  await write(KEYS.providerKeys, keys);
}

export async function readSession<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as T | undefined) ?? fallback;
}

export async function writeSession(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}
