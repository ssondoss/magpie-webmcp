import type { ReactElement } from 'react';
import type { CapabilityStatus, StepStatus } from '../../shared/types';

const CAPABILITY_ICONS: Record<CapabilityStatus, { icon: string; tone: string; title: string }> = {
  AVAILABLE: { icon: '✓', tone: 'ok', title: 'Ready' },
  SITE_CLOSED: { icon: '⚠', tone: 'warn', title: 'Site not open' },
  AUTH_REQUIRED: { icon: '⚠', tone: 'warn', title: 'Sign-in required' },
  TOOL_CHANGED: { icon: '⚠', tone: 'warn', title: 'Capability changed' },
  TOOL_MISSING: { icon: '✗', tone: 'bad', title: 'Capability missing' },
};

const STEP_ICONS: Record<StepStatus, { icon: string; tone: string; title: string }> = {
  pending: { icon: '·', tone: 'idle', title: 'Waiting' },
  running: { icon: '◐', tone: 'busy', title: 'Running' },
  ok: { icon: '✓', tone: 'ok', title: 'Done' },
  error: { icon: '✗', tone: 'bad', title: 'Failed' },
  skipped: { icon: '✗', tone: 'bad', title: 'Skipped' },
  blocked: { icon: '⏸', tone: 'warn', title: 'Blocked' },
};

export function CapabilityIcon({ status }: { status: CapabilityStatus }): ReactElement {
  const meta = CAPABILITY_ICONS[status];
  return (
    <span className={`icon ${meta.tone}`} title={meta.title} aria-label={meta.title}>
      {meta.icon}
    </span>
  );
}

export function StepIcon({ status }: { status: StepStatus }): ReactElement {
  const meta = STEP_ICONS[status];
  return (
    <span className={`icon ${meta.tone}`} title={meta.title} aria-label={meta.title}>
      {meta.icon}
    </span>
  );
}

export function statusLabel(status: CapabilityStatus): string {
  return CAPABILITY_ICONS[status].title;
}
