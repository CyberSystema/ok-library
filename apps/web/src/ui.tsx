// Shared UI utilities used across the app.
// Kept in a small companion file because main.tsx already exceeds 3,000 lines.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

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
      <div className="toast-stack" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-icon">
              {t.kind === 'success' ? '✓' : t.kind === 'error' ? '⚠' : 'ℹ'}
            </span>
            <span className="toast-msg">{t.message}</span>
            <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss">✕</button>
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
                {pending.cancelLabel ?? 'Cancel'}
              </button>
              <button
                className={pending.danger ? 'danger' : 'primary'}
                onClick={() => close(true)}
                autoFocus
              >
                {pending.confirmLabel ?? 'Confirm'}
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
// Returns ReactNode wrapping matched substrings in <mark>. Case-insensitive.
// Tokens come from the same parser the backend uses (whitespace + quoted phrases).

export function highlight(text: string | null | undefined, query: string): React.ReactNode {
  if (!text) return text ?? null;
  if (!query.trim()) return text;
  const tokens: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null = regex.exec(query);
  while (m) {
    const t = (m[1] ?? m[2] ?? '').trim();
    if (t.length >= 2) tokens.push(t);
    m = regex.exec(query);
  }
  if (tokens.length === 0) return text;
  const escaped = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  const splitter = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(splitter);
  return parts.map((part, i) =>
    splitter.test(part)
      ? <mark key={i} className="hl">{part}</mark>
      : <React.Fragment key={i}>{part}</React.Fragment>
  );
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
