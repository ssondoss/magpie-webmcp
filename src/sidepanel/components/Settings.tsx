import { useEffect, useState } from 'react';
import type { TestResult } from '../../shared/messages';
import type { PublicSettings } from '../../shared/types';
import { normalizeHttpUrl } from '../../shared/util';
import { request } from '../api';

/**
 * Configuration for the extension's own action tools, and nothing else.
 *
 * There is no model to configure: Magpie discovers capabilities and executes
 * them, and whichever agent the visitor already has does the composing. What is
 * left is the handful of things a global tool genuinely needs — where to post a
 * Slack message, where to open a draft email, whether to reopen a closed site
 * mid-run.
 */

interface Props {
  settings: PublicSettings;
  onSave(patch: { autoOpenSites?: boolean; slackWebhookUrl?: string; emailClient?: 'gmail' | 'mailto' }): void;
}

export function Settings({ settings, onSave }: Props) {
  const [slackWebhook, setSlackWebhook] = useState('');
  const [testing, setTesting] = useState(false);
  const [webhookTest, setWebhookTest] = useState<TestResult | null>(null);

  // A test result belongs to the URL it was run against; leaving it on screen
  // after an edit is how "✓ delivered" ends up next to a different webhook.
  useEffect(() => setWebhookTest(null), [slackWebhook]);

  // Validated with the same rule the worker stores by, so the panel cannot claim
  // a URL is fine that the worker will then discard.
  const webhookError =
    slackWebhook.trim() && !normalizeHttpUrl(slackWebhook)
      ? 'That is not a usable http(s) URL. Paste only the URL — selecting it on a page often picks up the button label next to it.'
      : '';

  const testWebhook = async (): Promise<void> => {
    setTesting(true);
    setWebhookTest(null);
    try {
      setWebhookTest(await request<TestResult>({ type: 'TEST_WEBHOOK', url: slackWebhook }));
    } catch (error) {
      setWebhookTest({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="panel-card">
      <h3>Settings</h3>

      <p className="muted small" style={{ marginTop: 0 }}>
        No API key is needed. Magpie discovers capabilities and executes them; whichever agent you are using does the
        composing, through the tools on the Magpie website.
      </p>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.autoOpenSites}
          onChange={(event) => onSave({ autoOpenSites: event.target.checked })}
        />
        <span>Automatically open a required site during execution</span>
      </label>

      <h3 style={{ marginTop: 18 }}>Extension tools</h3>

      <label className="field">
        <span>
          Slack incoming webhook
          {settings.hasSlackWebhook ? '' : ' — Send Slack message stays unavailable without it'}
        </span>
        <input
          type="password"
          value={slackWebhook}
          placeholder={settings.hasSlackWebhook ? '•••••••• (stored)' : 'https://hooks.slack.com/services/…'}
          onChange={(event) => setSlackWebhook(event.target.value)}
          autoComplete="off"
        />
      </label>
      {webhookError ? (
        <p className="bad-text" style={{ margin: '2px 0 0' }}>
          {webhookError}
        </p>
      ) : null}
      {settings.hasSlackWebhook && !webhookError ? (
        <p className="muted small">
          Posting to <strong>{settings.slackWebhookHost}</strong>
        </p>
      ) : null}

      <div className="actions">
        <button
          type="button"
          onClick={() => void testWebhook()}
          disabled={testing || Boolean(webhookError) || (!settings.hasSlackWebhook && !slackWebhook.trim())}
        >
          {testing ? 'Sending…' : 'Send test message'}
        </button>
        {webhookTest ? (
          <span className={webhookTest.ok ? 'ok-text small' : 'bad-text small'} style={{ margin: 0 }}>
            {webhookTest.ok ? '✓' : '✗'} {webhookTest.message}
          </span>
        ) : null}
      </div>

      <label className="field">
        <span>Email drafts open in</span>
        <div className="examples">
          {(['gmail', 'mailto'] as const).map((client) => (
            <button
              key={client}
              type="button"
              className={`chip${settings.emailClient === client ? ' active' : ''}`}
              onClick={() => onSave({ emailClient: client })}
            >
              {client === 'gmail' ? 'Gmail' : 'Default mail app'}
            </button>
          ))}
        </div>
      </label>
      <p className="muted small">
        Compose email opens a pre-filled draft — you press send. It never sends mail by itself.
      </p>

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={Boolean(webhookError)}
          onClick={() => {
            if (slackWebhook.trim()) onSave({ slackWebhookUrl: normalizeHttpUrl(slackWebhook) });
            setSlackWebhook('');
          }}
        >
          Save settings
        </button>
        {settings.hasSlackWebhook ? (
          <button type="button" className="subtle" onClick={() => onSave({ slackWebhookUrl: '' })}>
            Remove webhook
          </button>
        ) : null}
      </div>
    </section>
  );
}
