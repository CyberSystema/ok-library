// Shared UI utilities used across the app.
// Kept in a small companion file because main.tsx already exceeds 3,000 lines.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from './i18n';
import { formatEdtfRange, parseEdtf } from '@ok-library/shared';

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

// The context carries the two ACTIONS and never the list.
//
// It used to also expose `toasts`, which made the context value change identity
// on every push AND every auto-dismiss. Screens that (correctly) list `toast` in
// a useCallback dependency array — identity.tsx, borrowers.tsx, trash.tsx,
// rooms.tsx, authorities.tsx — therefore re-created their `load` on every toast,
// and the `useEffect(() => { void load(); }, [load])` that follows re-fetched and
// overwrote local state. A toast from ANY card on the page silently reverted the
// half-typed Library-identity form to the stored values and sent the reader list
// back to page 1; a success toast auto-dismissing 4 s later did it a second time.
// Nobody reads `toasts` outside this file — the stack below renders it from local
// state — so keeping it out of the value makes the context identity permanent and
// those dependency arrays inert.
type ToastContextValue = {
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
    //
    // SC 2.2.1 Timing Adjustable: toasts are this app's only channel for
    // validation errors and import results, and a fixed timeout is a time
    // limit on reading them. An ERROR now stays until dismissed — there is no
    // other copy of it anywhere — while the transient confirmations keep their
    // timer, since re-reading "Saved" is not something anyone needs to do.
    if (kind === 'error') return;
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // `push` and `dismiss` are useCallback([]), so this object is created once and
  // never again. That is the point: see the note on ToastContextValue.
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* The live region is PERSISTENT and the toasts render inside it.
          Creating a role="status" element at the same moment as its content is
          unreliably announced across screen readers — the region has to exist
          first for the insertion to be seen as a change. role="alert" on the
          error toast stays, because that one is announced on insertion. */}
      <div
        className="toast-stack"
        role="region"
        aria-label={t('common.notifications')}
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((entry) => (
          <div key={entry.id} className={`toast toast-${entry.kind}`} role={entry.kind === 'error' ? 'alert' : undefined}>
            {/* Decorative: without aria-hidden every announcement was prefixed
                with "check mark" or "warning". */}
            <span className="toast-icon" aria-hidden="true">
              {entry.kind === 'success' ? '✓' : entry.kind === 'error' ? '⚠' : 'ℹ'}
            </span>
            <span className="toast-msg">{entry.message}</span>
            <button className="toast-x" onClick={() => dismiss(entry.id)} aria-label={t('common.dismiss')}>
              <span aria-hidden="true">✕</span>
            </button>
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

  // Escape, the focus trap, focus restore and the body-scroll lock all come from
  // <Dialog> now — none of which this had when it rolled its own overlay. It was
  // the SEVENTH such overlay and the WCAG pass missed it, because the gate only
  // ever searched main.tsx.
  //
  // Enter-accepts survives ONLY for non-destructive prompts. <Dialog> focuses the
  // first control, which is Cancel; leaving a global Enter-accepts in place would
  // mean a delete prompt where the focused button says Cancel and pressing Enter
  // deletes. For a danger prompt the focused button now does what it says, and
  // confirming takes a deliberate Tab or click.
  useEffect(() => {
    if (!pending || pending.danger) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Dialog
          onClose={() => close(false)}
          labelledBy="confirm-title"
          className="confirm-dialog"
        >
          <div>
            <h3 id="confirm-title">{pending.title}</h3>
            {pending.body && <p className="confirm-body">{pending.body}</p>}
            <div className="confirm-actions">
              <button className="secondary" onClick={() => close(false)}>
                {pending.cancelLabel ?? t('common.cancel')}
              </button>
              <button
                className={pending.danger ? 'danger' : 'primary'}
                onClick={() => close(true)}
              >
                {pending.confirmLabel ?? t('common.confirm')}
              </button>
            </div>
          </div>
        </Dialog>
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


// ─── Lifted out of main.tsx ───────────────────────────────────────────────────
// Presentational components with no App() state. They moved so files under
// screens/ and handbook/ can use them — nothing there may import main.tsx.
// A PURE MOVE: only `export` was added.

export function StatCard({ title, value, subtitle }: { title: string; value: string | number; subtitle: string }) {
  return (
    <article className="stat-card">
      <p className="stat-title">{title}</p>
      <p className="stat-value">{value}</p>
      <p className="stat-subtitle">{subtitle}</p>
    </article>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  aside
}: {
  eyebrow: string;
  title: string;
  description: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        <p className="section-eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p className="panel-help">{description}</p>
      </div>
      {aside ? <div className="section-header-aside">{aside}</div> : null}
    </div>
  );
}

export function EdtfHint({ value, t }: { value: string; t: (k: string, v?: Record<string, string | number>) => string }) {
  const raw = value.trim();
  if (!raw) return <span className="edtf-hint muted small">{t('library.add.dateHint')}</span>;
  const parsed = parseEdtf(raw);
  if (!parsed) return <span className="edtf-hint is-warn">{t('library.add.dateUnparsed')}</span>;
  if (!parsed.isRange && parsed.qualifier === 'exact') return null;
  return <span className="edtf-hint muted small">{t('library.add.dateReads', { span: formatEdtfRange(parsed) })}</span>;
}

/**
 * A text input with a keyboard-navigable suggestion list.
 *
 * Extracted from the borrower picker, which was the only real typeahead in the
 * app, so the title-duplicate warning can reuse the same interaction rather
 * than growing a second, subtly different one. Behaviour is preserved exactly —
 * in particular the three details that are easy to get wrong:
 *
 *  • `onMouseDown` + `preventDefault`, not `onClick`. The input's blur fires
 *    first on click and would tear the list down before the pick registers.
 *  • Enter only picks when something is highlighted, so pressing Enter with the
 *    list merely open still submits the surrounding form.
 *  • Arrow keys wrap around, and the highlight resets whenever a new result set
 *    arrives — otherwise index 3 of the old list silently becomes index 3 of
 *    the new one.
 *
 * `onPick` is shared by the keyboard and pointer paths so the two cannot drift.
 */
export function Combobox<T>(props: {
  idPrefix: string;
  label?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onPick: (item: T) => void;
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Hide the list without clearing it — e.g. once a choice is locked in. */
  suppressed?: boolean;
  placeholder?: string;
  required?: boolean;
  /** Field-level error styling, e.g. the add form's `input-error`. */
  inputClassName?: string;
  ariaRequired?: boolean;
  ariaInvalid?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Rendered above the list; used for "N books already have this title". */
  listHeader?: React.ReactNode;
  /** Rendered inside the positioned wrapper, below the input. */
  footer?: React.ReactNode;
  className?: string;
}) {
  const { items, suppressed, onPick, getKey } = props;
  const [highlight, setHighlight] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  // A new result set invalidates any position in the old one.
  useEffect(() => { setHighlight(-1); setDismissed(false); }, [items]);

  const open = items.length > 0 && !suppressed && !dismissed;
  const listId = `${props.idPrefix}-suggestion-list`;

  return (
    <div className={props.className ?? 'combobox'}>
      {props.label !== undefined && <label htmlFor={`${props.idPrefix}-input`}>{props.label}</label>}
      <input
        id={`${props.idPrefix}-input`}
        ref={props.inputRef}
        className={props.inputClassName}
        aria-required={props.ariaRequired || undefined}
        aria-invalid={props.ariaInvalid || undefined}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onFocus={props.onFocus}
        /* Close on blur. Without this the panel stayed open after the field lost focus and
           sat on top of the control the librarian had just Tabbed into — it is absolutely
           positioned over the following field. Picking a row cannot race this: the list
           commits on mousedown with preventDefault (see the note above), so the pick lands
           before blur would fire. */
        onBlur={() => setDismissed(true)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((i) => (i + 1) % items.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((i) => (i <= 0 ? items.length - 1 : i - 1));
          } else if (e.key === 'Enter' && highlight >= 0) {
            e.preventDefault();
            const picked = items[highlight];
            if (picked !== undefined) onPick(picked);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // stopPropagation, or this Escape keeps travelling to Dialog's handler on
            // `.modal-overlay` and closes the whole book record — losing every edit in the
            // form — when all the librarian wanted was to dismiss an autocomplete list
            // that had appeared over the field they were typing in. The guard at the top
            // of this handler returns early when no list is open, so Escape still closes
            // the dialog in every other case.
            e.stopPropagation();
            setDismissed(true);
            setHighlight(-1);
          }
        }}
        placeholder={props.placeholder}
        required={props.required}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && highlight >= 0 && items[highlight]
            ? `${props.idPrefix}-opt-${getKey(items[highlight] as T)}`
            : undefined
        }
      />
      {open && (
        <>
          {props.listHeader}
          <ul className="combobox-list" role="listbox" id={listId}>
            {items.map((item, i) => (
              <li
                key={getKey(item)}
                id={`${props.idPrefix}-opt-${getKey(item)}`}
                role="option"
                aria-selected={highlight === i}
                className={highlight === i ? 'is-active' : undefined}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
              >
                {props.renderItem(item)}
              </li>
            ))}
          </ul>
        </>
      )}
      {props.footer}
    </div>
  );
}

/**
 * The one dialog primitive.
 *
 * Six overlays each reimplemented this pattern and each implemented a different
 * incomplete subset: `role="dialog" aria-modal="true"` was on the click-away
 * BACKDROP rather than on the dialog box, none had an accessible name, none
 * moved focus in, none trapped Tab, none restored focus on close, and Escape
 * was wired for three of them in one place and one of them in another.
 *
 * `ContextMenuView` already had a correct focus-restore implementation; this
 * lifts that approach so the next overlay inherits it instead of the gaps.
 *
 * The behaviour itself lives in `useModalFocus` + `trapTab` below, because one
 * overlay in the app cannot BE a Dialog: the course has its own full-screen
 * backdrop and its own stacking level, and exactly one element in this app may
 * carry `className="modal-overlay"`. Sharing the hook rather than the markup is
 * what stops the two from drifting apart again.
 *
 * WCAG 2.4.3 (focus order), 4.1.2 (name, role, value), 2.1.2 (no keyboard trap
 * — Tab cycles WITHIN the dialog, which is what aria-modal already promises AT
 * users and what Tab did not honour).
 */
export function Dialog({ onClose, onDismissAttempt, labelledBy, label, className, style, children, initialFocus, stacked }: {
  onClose: () => void;
  /**
   * Set on a dialog that is opened FROM another dialog.
   *
   * All overlays share `z-index: 200`, so between two of them the DOM order decides — and
   * the copies editor and the serial-holdings editor are both rendered EARLIER in App than
   * the record detail dialog they are opened from. The result: clicking "Edit copy details"
   * mounted the editor behind the detail panel, where it could not be seen or reached, and
   * because it holds the modal scroll lock the page then froze with no way out. Two
   * symptoms, one stacking order.
   *
   * Raising the child rather than reordering the JSX, because the order of these blocks in
   * a 9,000-line component is not something the next edit should have to preserve.
   */
  stacked?: boolean;
  /**
   * Called INSTEAD of `onClose` for the two ways a dialog closes by accident:
   * Escape, and a click that starts on the backdrop. A dialog holding typed work passes
   * this and asks before discarding; everything else omits it and keeps the old
   * behaviour, where a stray Escape is a convenience rather than a loss.
   *
   * The explicit Cancel button and the ✕ still call `onClose` directly — the operator
   * pressed those on purpose, and it is that screen's business whether to confirm.
   */
  onDismissAttempt?: () => void;
  /** Id of the heading inside. Preferred over `label` — it names the dialog with its own title. */
  labelledBy?: string;
  label?: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  initialFocus?: 'first' | 'container';
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(boxRef, initialFocus);
  const dismiss = onDismissAttempt ?? onClose;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismiss();
      return;
    }
    trapTab(boxRef.current, e);
  }

  return (
    // The backdrop is a backdrop: it is not the dialog and must not claim the
    // role. Click-away stays, but only when the click started on the backdrop
    // itself, so a drag that ends outside the box does not close it.
    <div
      className={stacked ? 'modal-overlay modal-overlay-stacked' : 'modal-overlay'}
      onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={boxRef}
        className={className ?? 'modal'}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** Everything a keyboard can land on. Used by the focus trap and by initial focus. */
export const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * Move focus in on mount, put it back on unmount, and lock the page behind.
 *
 * Separate from <Dialog> only so an overlay that cannot use Dialog's markup can
 * still get Dialog's behaviour from the same lines: the mandatory course is a
 * `role="dialog"` of its own and had NONE of this — no initial focus, no
 * restore, nothing — on the one screen a librarian cannot leave.
 *
 * `initialFocus: 'container'` focuses the box itself, which is what a long
 * scrolling panel wants: a screen reader then announces the dialog and its name
 * instead of starting the reader on whatever control happens to come first.
 */
export function useModalFocus(
  boxRef: React.RefObject<HTMLElement | null>,
  initialFocus: 'first' | 'container' = 'first'
) {
  // Captured on mount, before focus moves: this is what focus goes back to.
  const returnToRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnToRef.current = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    if (box) {
      const focusable = box.querySelectorAll<HTMLElement>(FOCUSABLE);
      const target = initialFocus === 'container' ? box : (focusable[0] ?? box);
      // The container itself needs a tabindex to be focusable at all; -1 keeps
      // it out of the tab sequence while allowing programmatic focus.
      if (target === box) box.setAttribute('tabindex', '-1');
      target.focus();
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      // The restore had a comment describing two guards and neither guard was in
      // the code — it was a bare `returnToRef.current?.focus?.()`. Both failures
      // are real:
      //  • A dialog that opens another one — the profile dialog's "Read the
      //    course again", the only such pair in the app — yanked focus back to
      //    the navbar button that opened IT, i.e. to a control behind the modal
      //    that had just appeared.
      //  • focus() on an opener that has since been removed (row deleted, list
      //    re-filtered) silently does nothing and leaves the keyboard at <body>.
      //    That containment check is the half of ContextMenuView's implementation
      //    this file claims to have lifted and did not.
      //
      // "Focus is still inside the dialog" has to be written as "nothing else has
      // taken focus". By the time a passive cleanup runs, React has already
      // detached this subtree and nulled boxRef, and focus has fallen to <body> —
      // measured, not assumed — so a literal `box.contains(document.activeElement)`
      // test would be false on every ordinary close and would disable the restore
      // completely. `box` is the element captured above, not the ref.
      const active = document.activeElement;
      const takenElsewhere = !!active && active !== document.body && !box?.contains(active);
      const back = returnToRef.current;
      if (!takenElsewhere && back && document.body.contains(back)) back.focus();
    };
  }, [boxRef, initialFocus]);
}

/**
 * Tab cycles WITHIN the box — what `aria-modal="true"` already promises to
 * assistive technology, and what Tab did not honour.
 *
 * Call it from the container's onKeyDown. Focus sitting ON the box (the
 * 'container' initial focus) counts as the first stop, or Shift+Tab from the
 * opening position would walk straight out into the page behind.
 */
export function trapTab(box: HTMLElement | null, e: React.KeyboardEvent) {
  if (e.key !== 'Tab' || !box) return;
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * A boundary around a lazily-loaded chunk.
 *
 * `React.lazy` REJECTS when its chunk cannot be fetched — a stale index.html
 * after a deploy, a 404 on a hashed filename, an offline moment — and React
 * hands that to the nearest error boundary. There was none anywhere in this app,
 * so the root unmounted and the page went blank; on the MANDATORY course that is
 * a blank page with no navbar, no sign-out and no other tab to fall back to, and
 * the librarian cannot get past it.
 *
 * HandbookProvider.ensurePack() already catches exactly this for the content
 * pack — "A failed chunk must not take the app down" — and degrades to an empty
 * Handbook. This is the same degradation for the RENDERER, which is a component
 * and so could not be caught by that try/catch.
 *
 * A fallback should offer a reload rather than a re-render: React.lazy caches the
 * rejection, so rendering the same lazy component again throws the same error for
 * the life of the page.
 */
export class ChunkBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// ─── Local-date helpers ─────────────────────────────────────────────────────
//
// Moved down out of App() unchanged so the copies editor — which is a screen,
// and screens may never import from main.tsx — can use the same two functions
// rather than a second, subtly different pair.

// Build an end-of-day ISO datetime in the user's local timezone. The date
// input only gives us YYYY-MM-DD, and naïvely appending "T00:00:00.000Z"
// shifts the date by up to a day in non-UTC zones. Anchoring to local 23:59
// means a "due Friday" loan stays due on the librarian's Friday wherever
// they are.
export function endOfLocalDayIso(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

// Inverse of endOfLocalDayIso for the <input type="date"> value. We must NOT
// use `toISOString().slice(0,10)` here — that converts to UTC first, so a
// local end-of-day stored as `2026-05-31T06:59:59Z` (UTC-7 user picked
// May 30) would render back as May 31. Use the *local* Y-M-D so the date
// shown in the input is the same date the user originally chose.
export function isoToLocalDateInput(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
