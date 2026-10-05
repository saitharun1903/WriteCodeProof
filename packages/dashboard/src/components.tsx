import { BAND_LABEL, formatScore } from '@writecode-proof/core/labels';
import type { ReactNode } from 'react';
import type { RunSummary, StoredCheck } from './api.js';
import { STATUS_LABEL } from './format.js';

type Band = keyof typeof BAND_LABEL;
const isBand = (value: string | null): value is Band => !!value && value in BAND_LABEL;

export function RiskBadge({
  score,
  band,
  large,
}: {
  score: number | null;
  band: string | null;
  large?: boolean;
}) {
  if (score === null || !isBand(band)) {
    return <span className="risk risk--none">–</span>;
  }
  return (
    <span className={`risk risk--${band}${large ? ' risk--large' : ''}`}>
      <span className="risk__score">{formatScore(score)}</span>
      <span className="risk__band">{BAND_LABEL[band]}</span>
    </span>
  );
}

export function RunStatus({ status }: { status: RunSummary['status'] }) {
  return <span className={`status status--${status}`}>{STATUS_LABEL[status]}</span>;
}

const CHECK_ICON: Record<StoredCheck['status'], { glyph: string; label: string }> = {
  passed: { glyph: '✓', label: 'Passed' },
  warning: { glyph: '!', label: 'Needs a look' },
  failed: { glyph: '✕', label: 'Failed' },
  skipped: { glyph: '–', label: 'Skipped' },
  error: { glyph: '?', label: 'Could not run' },
};

export function CheckIcon({ status }: { status: StoredCheck['status'] }) {
  const { glyph, label } = CHECK_ICON[status];
  return (
    <span
      className={`check-icon check-icon--${status}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {glyph}
    </span>
  );
}

export function Severity({ level }: { level: string }) {
  return <span className={`severity severity--${level}`}>{level}</span>;
}

export function Message({
  tone = 'muted',
  title,
  children,
}: {
  tone?: 'muted' | 'error';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`message message--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <p className="message__title">{title}</p>
      {children}
    </div>
  );
}
