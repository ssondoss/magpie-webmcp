import { useState } from 'react';

/**
 * How to get the extension, shown wherever its absence is the thing a visitor is
 * looking at.
 *
 * Both places that reported the absence used to end with "install it" and never
 * said how — which is the only part a first-time visitor actually needs. The
 * `lead` differs by tab, because what is missing on the Workflows tab and on the
 * Sites tab is not quite the same thing.
 */

const RELEASES = 'https://github.com/ssondoss/magpie-webmcp/releases';

/** Browsers refuse to navigate a page to a `chrome://` URL, so this is offered to copy. */
const EXTENSIONS_PAGE = 'chrome://extensions';

export function InstallExtension({ lead }: { lead: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard?.writeText(EXTENSIONS_PAGE).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_800);
      },
      () => setCopied(false),
    );
  };

  return (
    <article className="card muted-card">
      <h3>Add the extension</h3>
      <p className="muted">{lead}</p>

      <ol className="install">
        <li>
          Download <code>magpie-extension.zip</code> from{' '}
          <a href={RELEASES} target="_blank" rel="noreferrer">
            Releases
          </a>
          , then unzip it.
        </li>
        <li>
          Open <code>{EXTENSIONS_PAGE}</code>{' '}
          <button type="button" className="ghost" onClick={copy} title="Copy the address">
            {copied ? '✓ Copied' : 'Copy'}
          </button>
          <br />
          <span className="muted small">A link cannot open it — paste it into the address bar.</span>
        </li>
        <li>
          Turn on <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>, and select the
          unzipped folder — the one containing <code>manifest.json</code>.
        </li>
        <li>
          <strong>Reload this page.</strong> Chrome only injects into tabs that were opened after an
          extension was added, so this one cannot see Magpie until it is refreshed.
        </li>
      </ol>

      <p className="muted small">
        Chrome 116 or newer. No account, no API key, nothing to configure — and it works on stable
        Chrome, since Magpie brings its own <code>modelContext</code> polyfill.
      </p>
    </article>
  );
}
