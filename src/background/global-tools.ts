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

/**
 * `wa.me` takes a bare international number: digits only, country code included,
 * no `+` and no national trunk prefix. Punctuation is accepted because agents copy
 * numbers straight out of page text, where they arrive formatted for humans.
 *
 * The two rejections are the mistakes that actually happen. A trunk-prefixed
 * number resolves to the wrong country rather than failing, so catching it here
 * is the difference between an error and a message to a stranger.
 */
export function whatsappNumber(raw: unknown): string {
  const original = String(raw ?? '').trim();
  const digits = original.replace(/\D/g, '');
  if (!digits) {
    throw new Error(`send_whatsapp_message needs a phone number, got "${original}"`);
  }
  if (digits.startsWith('0')) {
    throw new Error(
      `send_whatsapp_message needs a country code, but "${original}" starts with a trunk prefix. Use international format, e.g. +971501234567.`,
    );
  }
  // E.164 allows at most 15 digits; fewer than 8 is never a reachable mobile number.
  if (digits.length < 8 || digits.length > 15) {
    throw new Error(
      `send_whatsapp_message got ${digits.length} digits ("${original}"); an international number has 8 to 15.`,
    );
  }
  return digits;
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

/**
 * Both calendar targets want the same instant in UTC basic format
 * (`20260901T090000Z`) — Google in its `dates` parameter, iCalendar in DTSTART.
 */
function calendarStamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * Resolves the event window from an ISO start plus either an explicit end or a
 * duration.
 *
 * A bare date (`2026-09-01`) is rejected rather than assumed to mean midnight:
 * an agent that drops the time would otherwise book a 3 AM meeting that looks
 * deliberate. Asking again costs a step; a wrong invitation costs a person's time.
 */
export function eventWindow(args: {
  start?: unknown;
  end?: unknown;
  durationMinutes?: unknown;
}): { start: Date; end: Date } {
  const rawStart = String(args.start ?? '').trim();
  if (!rawStart) throw new Error('create_calendar_event needs a start time');
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
    throw new Error(
      `create_calendar_event needs a time of day, not just a date ("${rawStart}"). Use an ISO timestamp, e.g. 2026-09-01T09:00:00Z.`,
    );
  }
  const start = new Date(rawStart);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`create_calendar_event could not read the start time "${rawStart}"`);
  }

  const rawEnd = String(args.end ?? '').trim();
  if (rawEnd) {
    const end = new Date(rawEnd);
    if (Number.isNaN(end.getTime())) {
      throw new Error(`create_calendar_event could not read the end time "${rawEnd}"`);
    }
    if (end <= start) {
      throw new Error(`create_calendar_event got an end time ("${rawEnd}") at or before the start ("${rawStart}")`);
    }
    return { start, end };
  }

  const minutes = typeof args.durationMinutes === 'number' ? args.durationMinutes : 30;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`create_calendar_event needs a positive durationMinutes, got ${String(args.durationMinutes)}`);
  }
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
}

function attendeeList(input: unknown): string[] {
  const raw = typeof input === 'string' ? input.split(/[,;\s]+/) : toArray(input).map(String);
  return raw.map((entry) => entry.trim()).filter((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry));
}

/** Folds long lines to 75 octets and escapes the delimiters, as iCalendar requires. */
function icsLine(name: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/[;,]/g, (match) => `\\${match}`).replace(/\r?\n/g, '\\n');
  const line = `${name}:${escaped}`;
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let index = 75; index < line.length; index += 74) {
    // A continuation line starts with a single space.
    parts.push(` ${line.slice(index, index + 74)}`);
  }
  return parts.join('\r\n');
}

export function buildIcs(event: {
  title: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  attendees: string[];
}): string {
  const uid = `${calendarStamp(event.start)}-${Math.random().toString(36).slice(2, 10)}@magpie`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Magpie//WebMCP//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    icsLine('UID', uid),
    `DTSTAMP:${calendarStamp(new Date())}`,
    `DTSTART:${calendarStamp(event.start)}`,
    `DTEND:${calendarStamp(event.end)}`,
    icsLine('SUMMARY', event.title),
  ];
  if (event.description) lines.push(icsLine('DESCRIPTION', event.description));
  if (event.location) lines.push(icsLine('LOCATION', event.location));
  for (const attendee of event.attendees) {
    lines.push(icsLine('ATTENDEE;RSVP=TRUE', `mailto:${attendee}`));
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  // iCalendar is CRLF-delimited; some clients reject bare LF.
  return `${lines.join('\r\n')}\r\n`;
}

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

  create_calendar_event: {
    risk: 'write',
    // The .ics path is purely local, but the Google path opens a form listing real
    // attendees. The stricter of the two decides, so the gate never depends on a
    // setting the agent cannot see.
    local: false,
    descriptor: {
      name: 'create_calendar_event',
      description:
        'Create a calendar event or meeting. Depending on the user setting this either opens a pre-filled Google Calendar form or downloads an .ics file — either way the user confirms it themselves, so this does NOT put anything on a calendar on its own and does NOT invite anyone until they save it.',
      inputSchema: objectSchema(
        {
          title: { type: 'string', description: 'Event title, e.g. "Follow-up on delayed order SO-1"' },
          start: {
            type: 'string',
            description:
              'Start as an ISO 8601 timestamp including a time of day, e.g. 2026-09-01T09:00:00Z. A date alone is rejected.',
          },
          end: { type: 'string', description: 'Optional ISO 8601 end. Omit to use durationMinutes instead.' },
          durationMinutes: {
            type: 'number',
            description: 'Length in minutes when no end is given. Defaults to 30.',
          },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional guest email addresses. Invalid entries are dropped.',
          },
          description: { type: 'string', description: 'Optional agenda or notes' },
          location: { type: 'string', description: 'Optional location or meeting link' },
        },
        ['title', 'start'],
      ),
      annotations: { title: 'Create calendar event' },
    },
    async execute(args, context) {
      const title = String(args.title ?? '').trim();
      if (!title) throw new Error('create_calendar_event needs a title');
      const { start, end } = eventWindow(args);
      const attendees = attendeeList(args.attendees);
      const description = asText(args.description).slice(0, 1800);
      const location = String(args.location ?? '').trim();

      if (context.settings.calendarClient === 'ics') {
        const ics = buildIcs({ title, start, end, description, location, attendees });
        const file = safeFilename(`${title}.ics`, 'meeting.ics');
        const result = await download(context, file, ics, 'text/calendar');
        return {
          ...(isPlainObject(result) ? result : {}),
          created: false,
          attendees,
          start: start.toISOString(),
          end: end.toISOString(),
        } as JsonValue;
      }

      const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: title,
        dates: `${calendarStamp(start)}/${calendarStamp(end)}`,
      });
      if (description) params.set('details', description);
      if (location) params.set('location', location);
      // Google takes guests as a repeated `add` parameter, one per address.
      for (const attendee of attendees) params.append('add', attendee);

      const url = `https://calendar.google.com/calendar/render?${params.toString()}`;
      const tab = await chrome.tabs.create({ url, active: false });
      return {
        drafted: true,
        created: false,
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        attendees,
        tabId: tab.id ?? null,
      };
    },
  },

  send_whatsapp_message: {
    risk: 'write',
    // Nothing is transmitted — WhatsApp opens with the message pre-filled and the
    // user presses Send — but it is addressed to a real person, so it still
    // deserves the approval gate, exactly like compose_email.
    local: false,
    descriptor: {
      name: 'send_whatsapp_message',
      description:
        'Open WhatsApp with a pre-filled message to a phone number. The user reviews it and presses send themselves — this does NOT send the message on its own. The number must include a country code. Use one call per recipient.',
      inputSchema: objectSchema(
        {
          to: {
            type: 'string',
            description:
              'Recipient phone number in international format, e.g. +971501234567. Spaces, dashes and brackets are fine; a leading 0 is not, because WhatsApp needs a country code.',
          },
          text: { type: 'string', description: 'Plain-text message body' },
        },
        ['to', 'text'],
      ),
      annotations: { title: 'Send WhatsApp message' },
    },
    async execute(args) {
      const to = whatsappNumber(args.to);
      // The message travels inside the URL, so keep the link openable.
      const text = asText(args.text).slice(0, 1800);
      if (!text) throw new Error('send_whatsapp_message received empty text');

      const url = `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
      const tab = await chrome.tabs.create({ url, active: false });
      return { drafted: true, to: `+${to}`, sent: false, tabId: tab.id ?? null };
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
