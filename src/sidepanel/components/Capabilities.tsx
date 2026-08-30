import { useMemo, useState } from 'react';
import type { Capability, PageContext } from '../../shared/types';
import { CapabilityIcon, statusLabel } from './StatusIcon';

interface Props {
  capabilities: Capability[];
  context: PageContext;
  onOpenProvider(origin: string): void;
  onForgetSite(origin: string): void;
}

interface Group {
  key: string;
  title: string;
  subtitle?: string;
  origin?: string;
  items: Capability[];
  closed: boolean;
}

/**
 * Shows capabilities the way a user thinks about them — "Search orders", grouped
 * by the app that provides them — instead of tool ids and JSON schemas.
 */
export function Capabilities({ capabilities, context, onOpenProvider, onForgetSite }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const groups = useMemo<Group[]>(() => {
    const byProvider = new Map<string, Capability[]>();
    for (const capability of capabilities) {
      const key = capability.origin ?? capability.providerKey;
      const list = byProvider.get(key);
      if (list) list.push(capability);
      else byProvider.set(key, [capability]);
    }

    const result: Group[] = [];
    for (const [key, items] of byProvider) {
      const first = items[0];
      const isCurrent = Boolean(context.origin && first.origin === context.origin);
      const closed = items.every((item) => item.status !== 'AVAILABLE');
      result.push({
        key,
        title: first.provider,
        subtitle:
          first.source === 'extension'
            ? 'Always available'
            : isCurrent
              ? 'This site'
              : closed
                ? statusLabel(items[0].status)
                : 'Open in another tab',
        origin: first.origin,
        items,
        closed: closed && first.source === 'webmcp',
      });
    }

    const rank = (group: Group): number => {
      if (context.origin && group.origin === context.origin) return 0;
      if (group.items[0].source === 'extension') return 3;
      return group.closed ? 2 : 1;
    };
    return result.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  }, [capabilities, context.origin]);

  if (groups.length === 0) {
    return (
      <div className="empty">
        No WebMCP capabilities discovered yet. Open a site that exposes tools through
        <code>navigator.modelContext</code>, or start the bundled demo apps.
      </div>
    );
  }

  return (
    <div className="capability-groups">
      {groups.map((group) => (
        <section key={group.key} className={`capability-group${group.closed ? ' is-closed' : ''}`}>
          <header>
            <div>
              <h3>{group.title}</h3>
              <span className="muted">{group.subtitle}</span>
            </div>
            {group.closed && group.origin ? (
              <button type="button" className="link" onClick={() => onOpenProvider(group.origin as string)}>
                Open
              </button>
            ) : null}
          </header>
          <ul>
            {group.items.map((capability) => (
              <li key={capability.id}>
                <button
                  type="button"
                  className="capability"
                  onClick={() => setExpanded(expanded === capability.id ? null : capability.id)}
                  title={capability.statusDetail ?? capability.description}
                >
                  <CapabilityIcon status={capability.status} />
                  <span className="capability-label">{capability.label}</span>
                  {capability.risk !== 'read' && !capability.local ? (
                    <span className={`tag ${capability.risk}`}>{capability.risk}</span>
                  ) : null}
                </button>
                {expanded === capability.id ? (
                  <div className="capability-detail">
                    <p>{capability.description || 'No description provided by the site.'}</p>
                    <code>{capability.id}</code>
                    {capability.statusDetail ? <p className="warn-text">{capability.statusDetail}</p> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {group.origin && group.items[0].source === 'webmcp' ? (
            <footer>
              <button type="button" className="link subtle" onClick={() => onForgetSite(group.origin as string)}>
                Forget this site
              </button>
            </footer>
          ) : null}
        </section>
      ))}
    </div>
  );
}
