// Shared UI utilities used across the app.
// Kept in a small companion file because main.tsx already exceeds 3,000 lines.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from './i18n';

// ─── Number formatting ────────────────────────────────────────────────────
// Always uses '.' as the thousands separator regardless of the user's browser
// locale. Returns '' for null/undefined/non-finite so callers can render safely.
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n)).toString();
  return sign + abs.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ─── Diacritic / case / whitespace normalization for client-side comparisons ─
// Mirrors the FTS5 server tokenizer (unicode61 remove_diacritics 2) closely
// enough that a string the user typed will match the rows the server returned.
export function normalizeForCompare(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks (accents)
    .toLowerCase()
    .trim();
}

// ─── Toast notifications ───────────────────────────────────────────────────
// Replaces the bottom-fixed banner: stacks multiple toasts, auto-dismisses,
// and provides a hook so any component can pushToast({ kind, message }).

export type ToastKind = 'success' | 'error' | 'info';
export type ToastEntry = { id: number; kind: ToastKind; message: string };

type ToastContextValue = {
  toasts: ToastEntry[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    // Errors stay longer so users have time to read; success/info auto-dismiss faster.
    const ttl = kind === 'error' ? 7000 : 4000;
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, ttl);
  }, []);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="region" aria-label={t('common.notifications')}>
        {toasts.map((entry) => (
          <div key={entry.id} className={`toast toast-${entry.kind}`} role={entry.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-icon">
              {entry.kind === 'success' ? '✓' : entry.kind === 'error' ? '⚠' : 'ℹ'}
            </span>
            <span className="toast-msg">{entry.message}</span>
            <button className="toast-x" onClick={() => dismiss(entry.id)} aria-label={t('common.dismiss')}>✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx;
}

// ─── Confirm dialog ────────────────────────────────────────────────────────
// Promise-based replacement for window.confirm. Renders a styled modal.

type ConfirmOptions = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PendingConfirm = ConfirmOptions & {
  resolve: (ok: boolean) => void;
};

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => setPending({ ...opts, resolve }));
  }, []);

  const close = useCallback((result: boolean) => {
    if (!pending) return;
    pending.resolve(result);
    setPending(null);
  }, [pending]);

  // Esc dismisses (counts as cancel); Enter accepts.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter')  { e.preventDefault(); close(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, close]);

  // Lock background scroll while a confirm is open. Without this the modal
  // visually appears over the list, but a stray wheel event still scrolls the
  // list underneath it on long pages.
  useEffect(() => {
    if (!pending) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [pending]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="modal-overlay" onClick={() => close(false)} role="dialog" aria-modal="true">
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{pending.title}</h3>
            {pending.body && <p className="confirm-body">{pending.body}</p>}
            <div className="confirm-actions">
              <button className="secondary" onClick={() => close(false)}>
                {pending.cancelLabel ?? t('common.cancel')}
              </button>
              <button
                className={pending.danger ? 'danger' : 'primary'}
                onClick={() => close(true)}
                autoFocus
              >
                {pending.confirmLabel ?? t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const fn = useContext(ConfirmContext);
  if (!fn) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>');
  }
  return fn;
}

// ─── Search-result highlighting ───────────────────────────────────────────
// Returns ReactNode wrapping matched substrings in <mark>. Matching is
// case-insensitive AND diacritic-insensitive — it uses the same fold the
// API does (lowercase + NFKD + strip combining marks + ς→σ) so a user who
// types `γαβριήλ` (with tonos) still gets `ΓΑΒΡΙΗΛ` highlighted in the
// result, and vice versa. Tokens come from the same parser the backend
// uses (whitespace + quoted phrases).

function foldForHighlight(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/ς/g, 'σ');
}

// Build a folded copy of `text` plus a map from folded-string index back to
// the original UTF-16 index in `text`. NFKD can expand a single codepoint
// into several characters (e.g. ﬃ → ffi) so we walk codepoints and record
// the original start for every folded character emitted.
function buildFoldMap(text: string): { folded: string; startMap: number[] } {
  let folded = '';
  const startMap: number[] = [];
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const f = foldForHighlight(ch);
    for (let k = 0; k < f.length; k += 1) startMap.push(i);
    folded += f;
    i += ch.length;
  }
  startMap.push(text.length); // sentinel = end of original string
  return { folded, startMap };
}

export function highlight(text: string | null | undefined, query: string): React.ReactNode {
  if (!text) return text ?? null;
  if (!query.trim()) return text;
  const rawTokens: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null = regex.exec(query);
  while (m) {
    const t = (m[1] ?? m[2] ?? '').trim();
    if (t.length >= 2) rawTokens.push(t);
    m = regex.exec(query);
  }
  if (rawTokens.length === 0) return text;

  const tokens = rawTokens
    .map(foldForHighlight)
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return text;

  const { folded, startMap } = buildFoldMap(text);

  // Find all match ranges in folded space, then translate back to original
  // UTF-16 ranges and merge overlapping/adjacent ones.
  type Range = { start: number; end: number };
  const ranges: Range[] = [];
  for (const tok of tokens) {
    let from = 0;
    while (from <= folded.length - tok.length) {
      const idx = folded.indexOf(tok, from);
      if (idx < 0) break;
      const origStart = startMap[idx];
      const origEnd = startMap[idx + tok.length];
      if (origEnd > origStart) ranges.push({ start: origStart, end: origEnd });
      from = idx + tok.length;
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  const out: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach((r, i) => {
    if (r.start > cursor) out.push(<React.Fragment key={`p${i}`}>{text.slice(cursor, r.start)}</React.Fragment>);
    out.push(<mark key={`h${i}`} className="hl">{text.slice(r.start, r.end)}</mark>);
    cursor = r.end;
  });
  if (cursor < text.length) out.push(<React.Fragment key="tail">{text.slice(cursor)}</React.Fragment>);
  return out;
}

// ─── Sparkline / mini-bar ─────────────────────────────────────────────────
// Pure-CSS horizontal bars; used in the Dashboard for category/year/language
// distributions without pulling a charting library into the bundle.

export function MiniBar({ value, max, label, count }: { value: number; max: number; label: string; count: number }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="minibar-row">
      <span className="minibar-label" title={label}>{label}</span>
      <div className="minibar-track">
        <div className="minibar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="minibar-count">{fmt(count)}</span>
    </div>
  );
}

// ─── Skeleton loader ──────────────────────────────────────────────────────
// Renders N placeholder book cards while the real list is fetching.

export function BookCardSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="book-grid skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="book-card skeleton-card">
          <div className="skeleton skeleton-avatar" />
          <div className="skeleton-body">
            <div className="skeleton skeleton-line w70" />
            <div className="skeleton skeleton-line w40" />
            <div className="skeleton skeleton-line w55" />
          </div>
        </div>
      ))}
    </div>
  );
}
