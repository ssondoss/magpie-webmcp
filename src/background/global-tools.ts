import type { PanelTask } from '../shared/messages';
import type {
  Capability,
  JsonObject,
  JsonValue,
  RiskLevel,
  Settings,
  ToolDescriptor,
} from '../shared/types';
import { isPlainObject, toArray, toJson } from '../shared/util';

/**
 * Extension-provided capabilities. They use the same registry shape as page
 * tools, so a calling agent cannot tell the difference — which is the whole point:
 * a workflow can mix site capabilities with these freely.
 */

export interface GlobalToolContext {
  /** Runs a task in the side panel document (needed for Blob URLs + clipboard). */
  runPanelTask(task: PanelTask): Promise<unknown>;
  settings: Settings;
}

interface GlobalTool {
  descriptor: ToolDescriptor;
  risk: RiskLevel;
  /** Side effects never leave this machine, so no write-approval gate. */
  local: boolean;
  /** Tools needing one-time setup report AUTH_REQUIRED until it is done. */
  configured?(settings: Settings): boolean;
  configHint?: string;
  execute(args: JsonObject, context: GlobalToolContext): Promise<JsonValue>;
}

export const GLOBAL_PROVIDER_KEY = 'global';
export const GLOBAL_PROVIDER_NAME = 'Extension';

function csvCell(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toRows(input: unknown): JsonObject[] {
  return toArray(input).map((row) => (isPlainObject(row) ? row : ({ value: toJson(row) } as JsonObject)));
}

export function buildCsv(input: unknown, requestedColumns?: string[]): { csv: string; columns: string[]; rowCount: number } {
  const rows = toRows(input);
  const columns =
    requestedColumns && requestedColumns.length > 0
      ? requestedColumns
      : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(','));
  return { csv: lines.join('\r\n'), columns, rowCount: rows.length };
}

function safeFilename(name: unknown, fallback: string): string {
  const raw = typeof name === 'string' && name.trim() ? name.trim() : fallback;
  return raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').slice(0, 120);
}

function asText(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Panel-first because the panel document can create Blob URLs; SW falls back to data URLs. */
async function download(
  context: GlobalToolContext,
  filename: string,
  content: string,
  mimeType: string,
): Promise<JsonValue> {
  try {
    const result = await context.runPanelTask({ kind: 'download', filename, content, mimeType });
    return { filename, bytes: content.length, via: 'panel', ...(isPlainObject(result) ? result : {}) };
  } catch {
    const url = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    return { filename, bytes: content.length, via: 'background', downloadId };
  }
}

const objectSchema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  properties,
  required,
});

export const GLOBAL_TOOLS: Record<string, GlobalTool> = {
  export_csv: {
    risk: 'write',
    local: true,
    descriptor: {
      name: 'export_csv',
      description:
        'Create and download a CSV file from an array of objects. Use this whenever the user asks to export, download or save structured results as a spreadsheet/CSV.',
      inputSchema: objectSchema(
        {
          data: {
            type: 'array',
            description: 'Rows to export. Pass a reference to a previous step output, e.g. {{highValueOrders}}.',
            items: { type: 'object' },
          },
          filename: { type: 'string', description: 'File name ending in .csv' },
          columns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional explicit column order; defaults to every key found in the rows.',
          },
        },
        ['data'],
      ),
      annotations: { title: 'Export CSV' },
    },
    async execute(args, context) {
      const columns = Array.isArray(args.columns) ? (args.columns as string[]).map(String) : undefined;
      const { csv, columns: used, rowCount } = buildCsv(args.data, columns);
      if (rowCount === 0) throw new Error('export_csv received no rows to export');
      const filename = safeFilename(args.filename, 'export.csv');
      const file = filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`;
      const result = await download(context, file, csv, 'text/csv');
      return { ...(isPlainObject(result) ? result : {}), rowCount, columns: used } as JsonValue;
    },
  },

  download_file: {
    risk: 'write',
    local: true,
    descriptor: {
      name: 'download_file',
      description:
        'Download arbitrary text content (JSON, markdown, plain text) as a file on the user machine.',
      inputSchema: objectSchema(
        {
          filename: { type: 'string', description: 'File name including extension' },
          content: { description: 'Text, or an object/array that will be written as pretty JSON' },
          mimeType: { type: 'string', description: 'Defaults to text/plain' },
        },
        ['filename', 'content'],
      ),
      annotations: { title: 'Download file' },
    },
    async execute(args, context) {
      const filename = safeFilename(args.filename, 'download.txt');
      const content = asText(args.content);
      if (!content) throw new Error('download_file received empty content');
      const mimeType = typeof args.mimeType === 'string' && args.mimeType ? args.mimeType : 'text/plain';
      return download(context, filename, content, mimeType);
    },
  },

  copy_to_clipboard: {
    risk: 'write',
    local: true,
    descriptor: {
      name: 'copy_to_clipboard',
      description: 'Copy text or structured data (as JSON) to the system clipboard.',
      inputSchema: objectSchema(
        {
          text: { description: 'Text, or an object/array that will be stringified as JSON' },
        },
        ['text'],
      ),
      annotations: { title: 'Copy to clipboard' },
    },
    async execute(args, context) {
      const text = asText(args.text);
      if (!text) throw new Error('copy_to_clipboard received empty text');
      await context.runPanelTask({ kind: 'clipboard', text });
      return { copied: true, characters: text.length };
    },
  },

  compose_email: {
    risk: 'write',
    // Nothing is transmitted — a draft opens and the user presses Send — but it
    // is addressed to a real person, so it still deserves the approval gate.
    local: false,
    descriptor: {
      name: 'compose_email',
      description:
        'Open a pre-filled email draft addressed to someone. The user reviews it and presses send themselves — this does NOT send mail on its own. Use one call per recipient.',
      inputSchema: objectSchema(
        {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Subject line' },
          body: { type: 'string', description: 'Plain-text message body' },
          cc: { type: 'string', description: 'Optional cc address' },
        },
        ['to', 'subject', 'body'],
      ),
      annotations: { title: 'Compose email' },
    },
    async execute(args, context) {
      const to = String(args.to ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        throw new Error(`compose_email needs a valid recipient address, got "${to}"`);
      }
      const subject = String(args.subject ?? '');
      // Compose URLs are length-limited; keep the draft openable.
      const body = asText(args.body).slice(0, 1800);
      const cc = typeof args.cc === 'string' ? args.cc : '';

      const url =
        context.settings.emailClient === 'mailto'
          ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}${cc ? `&cc=${encodeURIComponent(cc)}` : ''}`
          : `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}${cc ? `&cc=${encodeURIComponent(cc)}` : ''}`;

      const tab = await chrome.tabs.create({ url, active: false });
      return { drafted: true, to, subject, sent: false, tabId: tab.id ?? null };
    },
  },

  send_slack_message: {
    risk: 'write',
    local: false,
    configured: (settings) => Boolean(settings.slackWebhookUrl),
    configHint: 'Add a Slack incoming-webhook URL in Settings to enable this.',
    descriptor: {
      name: 'send_slack_message',
      description:
        'Post a message to the configured Slack channel through an incoming webhook. This sends immediately — there is no draft step.',
      inputSchema: objectSchema(
        {
          text: { type: 'string', description: 'Message text. Slack mrkdwn is supported.' },
        },
        ['text'],
      ),
      annotations: { title: 'Send Slack message', destructiveHint: false },
    },
    async execute(args, context) {
      const webhook = context.settings.slackWebhookUrl;
      if (!webhook) throw new Error('No Slack webhook URL is configured. Add one in Settings.');
      const text = asText(args.text);
      if (!text) throw new Error('send_slack_message received empty text');

      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        throw new Error(`Slack rejected the message (${response.status}): ${await response.text()}`);
      }
      return { sent: true, characters: text.length };
    },
  },

  notify: {
    risk: 'write',
    local: true,
    descriptor: {
      name: 'notify',
      description:
        'Show a desktop notification. Useful as the last step of a long workflow so the user knows it finished.',
      inputSchema: objectSchema(
        {
          title: { type: 'string', description: 'Short notification title' },
          message: { type: 'string', description: 'Notification body' },
        },
        ['title', 'message'],
      ),
      annotations: { title: 'Desktop notification' },
    },
    async execute(args) {
      // The promise overload is typed as void in @types/chrome, but Chrome
      // resolves it with the generated notification id.
      const id = (await chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: String(args.title ?? 'Magpie').slice(0, 120),
        message: asText(args.message).slice(0, 500),
      })) as unknown as string | undefined;
      return { shown: true, notificationId: id ?? null };
    },
  },

  open_url: {
    risk: 'write',
    local: true,
    descriptor: {
      name: 'open_url',
      description: 'Open an http(s) URL in a new browser tab.',
      inputSchema: objectSchema(
        {
          url: { type: 'string', description: 'Absolute http or https URL' },
          active: { type: 'boolean', description: 'Focus the new tab. Defaults to false.' },
        },
        ['url'],
      ),
      annotations: { title: 'Open URL' },
    },
    async execute(args) {
      const raw = String(args.url ?? '');
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error(`open_url received an invalid URL: ${raw}`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`open_url only supports http(s) URLs, got ${url.protocol}`);
      }
      const tab = await chrome.tabs.create({ url: url.toString(), active: args.active === true });
      return { opened: url.toString(), tabId: tab.id ?? null };
    },
  },
};

/** A tool needing setup reports AUTH_REQUIRED, exactly like a site needing sign-in. */
export function isConfigured(tool: GlobalTool, settings?: Settings): boolean {
  if (!tool.configured) return true;
  return settings ? tool.configured(settings) : false;
}

export function globalCapabilities(settings?: Settings): Capability[] {
  return Object.values(GLOBAL_TOOLS).map((tool) => {
    const ready = isConfigured(tool, settings);
    return {
      id: `${GLOBAL_PROVIDER_KEY}.${tool.descriptor.name}`,
      name: tool.descriptor.name,
      label: tool.descriptor.annotations?.title ?? tool.descriptor.name,
      description: tool.descriptor.description,
      provider: GLOBAL_PROVIDER_NAME,
      providerKey: GLOBAL_PROVIDER_KEY,
      inputSchema: tool.descriptor.inputSchema,
      source: 'extension',
      status: ready ? 'AVAILABLE' : 'AUTH_REQUIRED',
      statusDetail: ready ? undefined : tool.configHint,
      risk: tool.risk,
      local: tool.local,
    };
  });
}

/** Posts a real message, so "configured" is proven rather than assumed. */
export async function testWebhook(url: string): Promise<{ ok: boolean; message: string }> {
  if (!url) return { ok: false, message: 'No webhook URL is configured.' };
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, message: 'That is not a usable URL.' };
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Test message from Magpie — your webhook works.' }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      return { ok: false, message: `${host} rejected it (${response.status}): ${detail}` };
    }
    return { ok: true, message: `Delivered to ${host} — check the channel for a test message.` };
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach ${host}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function getGlobalTool(id: string): GlobalTool | undefined {
  const [providerKey, ...rest] = id.split('.');
  if (providerKey !== GLOBAL_PROVIDER_KEY) return undefined;
  return GLOBAL_TOOLS[rest.join('.')];
}
