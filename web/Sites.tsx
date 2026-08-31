import { useEffect, useRef, useState } from 'react';
import type { ToolDescriptor } from '../src/shared/types';
import type { ExtensionCapability } from './app/extension';
import { forgetSite, openSite } from './app/extension';
import { pairings } from './app/suggest';

/** Whether the suggestions block is open, remembered between visits. */
const IDEAS_KEY = 'magpie.ideas.open';

/**
 * Everything Magpie can currently reach, grouped by the site that provides it.
 *
 * The point of the capability registry is that it spans sites — including ones
 * that are closed right now but were seen before — so this is the view that makes
 * the registry visible rather than implied. Each site gets a monogram tile and a
 * lit status indicator, and its capabilities are cards rather than list items so
 * "what can this site do" is scannable at a glance.
 */

interface Props {
  own: ToolDescriptor[];
  extension: ExtensionCapability[] | null;
  /** Re-reads the registry after a site is opened or forgotten. */
  onChanged(): void;
}

interface Group {
  key: string;
  provider: string;
  origin?: string;
  status: string;
  self?: boolean;
  items: Array<{ name: string; label: string; description: string; write: boolean }>;
}

const STATUS_TEXT: Record<string, string> = {
  AVAILABLE: 'open now',
  SITE_CLOSED: 'seen before — not open',
  AUTH_REQUIRED: 'open, but signed out',
  TOOL_CHANGED: 'changed since last seen',
  TOOL_MISSING: 'no longer exposed',
};

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad'> = {
  AVAILABLE: 'ok',
  SITE_CLOSED: 'warn',
  AUTH_REQUIRED: 'warn',
  TOOL_CHANGED: 'warn',
  TOOL_MISSING: 'bad',
};

/** Two letters is enough to tell sites apart, and never overflows the tile. */
function monogram(provider: string): string {
  const words = provider.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * One suggestion, as the two nodes that make it up plus the sentence to use.
 *
 * Copying is the whole point: there is no chat here to type into, so the useful
 * action is handing the prompt to whatever agent the visitor already has.
 */
function Idea({ idea }: { idea: ReturnType<typeof pairings>[number] }) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard?.writeText(idea.prompt).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_800);
      },
      () => setCopied(false),
    );
  };

  return (
    <li className="idea">
      <div className="idea-flow">
        <span className="idea-node read">
          <b>{idea.from.label}</b>
          <span>{idea.from.provider}</span>
        </span>
        <span className="idea-arrow" aria-hidden="true">
          →
        </span>
        <span className={`idea-node ${idea.to.writes ? 'write' : 'read'}`}>
          <b>{idea.to.label}</b>
          <span>{idea.to.provider}</span>
        </span>
      </div>
      <button type="button" className="ghost" onClick={copy} title={idea.prompt}>
        {copied ? '✓ Copied' : 'Copy prompt'}
      </button>
    </li>
  );
}

/**
 * A tool description, clamped to three lines so a site's card stays scannable.
 *
 * Sites Magpie did not write — the third-party ones the registry exists for —
 * routinely write descriptions several times longer than the demos do, and a
 * clamp with no way past it hides the very thing a visitor is reading the card
 * for. So the full text is one click away.
 *
 * The toggle is only wired up when the text is *measured* as overflowing, rather
 * than guessed at from its length: a short description that advertises an
 * expander doing nothing is worse than no expander at all.
 */
function CapDescription({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || open) return;
    // Only meaningful while collapsed — the clamp is what makes the content overflow.
    setClamped(node.scrollHeight > node.clientHeight + 1);
  }, [text, open]);

  if (!text) return null;

  const interactive = clamped || open;
  const toggle = (): void => setOpen((value) => !value);

  return (
    <p
      ref={ref}
      className={`${interactive ? 'clampable' : ''}${open ? ' open' : ''}`}
      // The tooltip covers a pointer; the click covers touch, where none appears.
      title={interactive && !open ? text : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? open : undefined}
      onClick={interactive ? toggle : undefined}
      onKeyDown={(event) => {
        if (!interactive) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      }}
    >
      {text}
    </p>
  );
}

export function Sites({ own, extension, onChanged }: Props) {
  const groups: Group[] = [
    {
      key: 'self',
      provider: 'Magpie (this site)',
      status: 'AVAILABLE',
      self: true,
      items: own.map((descriptor) => ({
        name: descriptor.name,
        label: descriptor.annotations?.title ?? descriptor.name,
        description: descriptor.description,
        write: descriptor.annotations?.readOnlyHint !== true,
      })),
    },
  ];

  for (const capability of extension ?? []) {
    // Magpie's own tools arrive twice when the extension is connected — it
    // discovers this page like any other site.
    if (capability.provider === 'Magpie') continue;
    const key = capability.origin ?? capability.provider;
    let group = groups.find((item) => item.key === key);
    if (!group) {
      group = {
        key,
        provider: capability.provider,
        origin: capability.origin,
        status: capability.status,
        items: [],
      };
      groups.push(group);
    }
    if (capability.status !== 'AVAILABLE') group.status = capability.status;
    group.items.push({
      name: capability.id,
      label: capability.label,
      description: capability.description,
      write: capability.risk !== 'read',
    });
  }

  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const ideas = pairings(own, extension);
  const [ideasOpen, setIdeasOpen] = useState(() => localStorage.getItem(IDEAS_KEY) !== 'false');

  const toggleIdeas = (): void => {
    setIdeasOpen((open) => {
      localStorage.setItem(IDEAS_KEY, String(!open));
      return !open;
    });
  };

  return (
    <>
      {/*
        What a visitor actually needs first: not a list of forty tool names, but
        proof that two of them can be used together, and the sentence that does it.
      */}
      {ideas.length > 0 ? (
        <article className="card">
          <button type="button" className="card-fold" onClick={toggleIdeas} aria-expanded={ideasOpen}>
            <span className="card-title">
              <span className="tile" aria-hidden="true">
                ✦
              </span>
              <span>
                <h3>Things you can ask for</h3>
                <span className="muted small">
                  <b>{total}</b> capabilities across <b>{groups.length}</b>{' '}
                  {groups.length === 1 ? 'site' : 'sites'}
                </span>
              </span>
            </span>
            <span className="caret" data-open={ideasOpen} aria-hidden="true">
              ▸
            </span>
          </button>

          {ideasOpen ? (
            <>
              <p className="muted small" style={{ marginTop: 12 }}>
                Your agent can combine any of them. These are real pairings from what is reachable now, not examples.
              </p>
              <ul className="ideas">
                {ideas.map((idea) => (
                  <Idea key={idea.id} idea={idea} />
                ))}
              </ul>
            </>
          ) : null}
        </article>
      ) : null}

      {!extension ? (
        <article className="card muted-card">
          <h3>Only this site</h3>
          <p className="muted">
            Magpie can list capabilities from every site you have visited that exposes WebMCP — but that registry
            lives in the extension, which is not connected. Install it and the sites you have seen will appear here
            alongside this one.
          </p>
        </article>
      ) : null}

      {groups.map((group) => {
        const status = STATUS_TONE[group.status] ?? 'warn';

        return (
          <article key={group.key} className="card lift">
            <header>
              <div className="card-title">
                <span className={`tile ${group.self ? 'self' : status}`} aria-hidden="true">
                  {group.self ? '◆' : monogram(group.provider)}
                </span>
                <div>
                  <h3>{group.provider}</h3>
                  <div className="status-line">
                    <span className={`led ${status}`} aria-hidden="true" />
                    <span>{STATUS_TEXT[group.status] ?? group.status}</span>
                    {group.origin ? <code>{group.origin}</code> : null}
                  </div>
                </div>
              </div>
              <div className="card-actions">
                <span className="chip accent">
                  <b>{group.items.length}</b> tools
                </span>
                {group.origin ? (
                  <>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void openSite(group.origin ?? '').then(onChanged, () => {})}
                      title={`Open ${group.provider}`}
                    >
                      {status === 'ok' ? 'Go to site' : 'Open site'}
                    </button>
                    <button
                      type="button"
                      className="card-delete"
                      title={`Forget ${group.provider}`}
                      aria-label={`Forget ${group.provider}`}
                      onClick={() => {
                        if (!window.confirm(`Forget ${group.provider}? Magpie will rediscover it when you next visit.`)) return;
                        void forgetSite(group.origin ?? '').then(onChanged, () => {});
                      }}
                    >
                      ✕
                    </button>
                  </>
                ) : null}
              </div>
            </header>

            <ul className="capabilities">
              {group.items.map((item) => (
                <li key={item.name} className={`cap${item.write ? ' write' : ''}`}>
                  <div className="cap-head">
                    <strong title={item.label}>{item.label}</strong>
                    {item.write ? <span className="tag write">writes</span> : null}
                  </div>
                  <code title={item.name}>{item.name}</code>
                  <CapDescription text={item.description} />
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </>
  );
}
