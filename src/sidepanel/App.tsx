import { useEffect, useMemo, useState } from 'react';
import type { PanelState } from '../shared/types';
import { connect, request } from './api';
import { Capabilities } from './components/Capabilities';
import { Settings } from './components/Settings';

/**
 * The panel is a window onto the registry, not a place to get work done.
 *
 * Magpie has no model of its own: the agent driving the Magpie website is what
 * composes and runs workflows. What only the extension can know is which sites
 * expose which capabilities — including ones that are closed right now — so that
 * is what this shows.
 */

type Tab = 'capabilities' | 'settings';

export function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [tab, setTab] = useState<Tab>('capabilities');

  useEffect(() => {
    const disconnect = connect((message) => {
      if (message.type === 'STATE') setState(message.state);
    });
    request<PanelState>({ type: 'GET_STATE' })
      .then(setState)
      .catch(() => {
        /* the worker answers on its first push instead */
      });
    return disconnect;
  }, []);

  const capabilities = state?.capabilities ?? [];
  const available = useMemo(
    () => capabilities.filter((capability) => capability.status === 'AVAILABLE').length,
    [capabilities],
  );
  const context = state?.context;

  return (
    <div className="app">
      <header className="app-header">
        <div className="titles">
          <h1>Magpie</h1>
          <p className="muted">
            {context?.webmcp
              ? `${context.provider} · ${context.toolCount} capabilit${context.toolCount === 1 ? 'y' : 'ies'} on this page`
              : context?.provider
                ? `${context.provider} · no WebMCP capabilities here`
                : 'No page context'}
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="link"
            onClick={() => void request({ type: 'REFRESH' }).catch(() => {})}
            title="Rediscover capabilities in all open tabs"
          >
            Refresh
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={tab === 'capabilities' ? 'active' : ''}
          onClick={() => setTab('capabilities')}
        >
          Capabilities{available ? ` (${available})` : ''}
        </button>
        <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          Settings
        </button>
      </nav>

      {tab === 'capabilities' && state ? (
        <main>
          <section className="panel-card">
            <p className="muted" style={{ margin: '0 0 10px' }}>
              Every capability Magpie has found, across every site you have visited. Your agent reaches these through
              the Magpie website — this panel is for seeing what is there.
            </p>
            <Capabilities
              capabilities={capabilities}
              context={state.context}
              onOpenProvider={(origin) => void request({ type: 'OPEN_PROVIDER', origin }).catch(() => {})}
              onForgetSite={(origin) => void request({ type: 'FORGET_SITE', origin }).catch(() => {})}
            />
          </section>
        </main>
      ) : null}

      {tab === 'settings' && state ? (
        <main>
          <Settings
            settings={state.settings}
            onSave={(patch) => void request({ type: 'SET_SETTINGS', settings: patch }).catch(() => {})}
          />
        </main>
      ) : null}
    </div>
  );
}
