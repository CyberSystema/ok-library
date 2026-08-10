// Where the Handbook lives, so that a "?" at any depth can reach it.
//
// Mounted in `Root()` beside the toast and confirm providers. That placement is
// the point: the "?" next to a field inside the edit dialog is six components
// deep, and prop-drilling a handbook opener through all of them would be a change
// to every form.
//
// THE "?" OPENS A DRAWER. It never switches tab. Changing the current section from
// inside the edit-book dialog would either unmount the form and lose every
// keystroke the librarian had typed, or leave the answer hidden behind the modal.
// A drawer is the only container that can appear over a form without disturbing it.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CONTENT_LOADERS, type AnchorId, type ChapterId, type ContentLang } from './registry';
import type { ContentPack } from './types';
import { useI18n } from '../i18n';

export type HandbookTarget = { chapter?: ChapterId; anchor?: AnchorId };

type HandbookValue = {
  pack: ContentPack | null;
  loading: boolean;
  /** Set while the drawer is open. */
  drawerOpen: boolean;
  target: HandbookTarget | null;
  /** Open the drawer at a chapter or anchor. */
  open: (target: HandbookTarget) => void;
  /** Move the reader without opening or closing anything — used by the page and by cross-references. */
  openAt: (target: HandbookTarget) => void;
  /**
   * Fetch the pack if it is not here yet, without moving the reader.
   *
   * The renderer calls this on mount. Without it, opening the Handbook TAB left
   * the contents list showing raw chapter ids and no prose at all: only the "?"
   * drawer ever triggered a load, because only it went through `open()`.
   */
  ensure: () => void;
  close: () => void;
};

const HandbookContext = createContext<HandbookValue | null>(null);

/** Packs already fetched, so opening the drawer twice is one network cost. */
const packCache = new Map<ContentLang, ContentPack>();

export function HandbookProvider({ children }: { children: React.ReactNode }) {
  const { lang } = useI18n();
  const [pack, setPack] = useState<ContentPack | null>(packCache.get(lang as ContentLang) ?? null);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [target, setTarget] = useState<HandbookTarget | null>(null);

  // Loaded on FIRST USE, not on mount. The Handbook is the largest thing in the
  // app and most sessions never open it; paying for it at startup would make
  // every login slower to save a click that may never come.
  const ensurePack = useCallback(async () => {
    const key = lang as ContentLang;
    const cached = packCache.get(key);
    if (cached) { setPack(cached); return; }
    setLoading(true);
    try {
      const loader = CONTENT_LOADERS[key] ?? CONTENT_LOADERS.en;
      const mod = await loader();
      const loaded = (mod.default ?? {}) as ContentPack;
      packCache.set(key, loaded);
      setPack(loaded);
    } catch {
      // A failed chunk must not take the app down: the reader gets an empty
      // Handbook and everything else keeps working.
      setPack({});
    } finally {
      setLoading(false);
    }
  }, [lang]);

  // Switching language switches pack.
  useEffect(() => {
    if (packCache.has(lang as ContentLang)) setPack(packCache.get(lang as ContentLang) ?? null);
    else if (pack) void ensurePack();
  }, [lang, ensurePack, pack]);

  const open = useCallback((next: HandbookTarget) => {
    setTarget(next);
    setDrawerOpen(true);
    void ensurePack();
  }, [ensurePack]);

  const openAt = useCallback((next: HandbookTarget) => {
    setTarget(next);
    void ensurePack();
  }, [ensurePack]);

  const close = useCallback(() => setDrawerOpen(false), []);

  // The app's first and only URL state. Deliberately kept to this: a librarian
  // sending "read this bit" to a colleague is a real need, and a hash costs
  // nothing, but routing the rest of the app is a separate decision.
  useEffect(() => {
    const fromHash = () => {
      const m = /^#handbook\/([a-z-]+)(?:\/([a-z0-9-]+))?$/.exec(window.location.hash);
      if (!m) return;
      openAt({ chapter: m[1] as ChapterId, anchor: (m[2] as AnchorId) || undefined });
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [openAt]);

  const ensure = useCallback(() => { void ensurePack(); }, [ensurePack]);

  const value = useMemo<HandbookValue>(
    () => ({ pack, loading, drawerOpen, target, open, openAt, close, ensure }),
    [pack, loading, drawerOpen, target, open, openAt, close, ensure]
  );

  return <HandbookContext.Provider value={value}>{children}</HandbookContext.Provider>;
}

export function useHandbook(): HandbookValue {
  const ctx = useContext(HandbookContext);
  if (!ctx) throw new Error('useHandbook must be used inside HandbookProvider');
  return ctx;
}

/**
 * The "?" beside a field.
 *
 * Names an ANCHOR, never a chapter, so the Handbook can be reorganised without
 * touching a single form. The anchor type is a union, so a typo or a link to a
 * section that does not exist is a build error.
 */
export function HelpLink({ anchor, label }: { anchor: AnchorId; label: string }) {
  const { open } = useHandbook();
  return (
    <button
      type="button"
      className="help-link"
      // A bare "?" is not a name. Screen readers get the field it explains.
      aria-label={label}
      title={label}
      onClick={() => open({ anchor })}
    >
      ?
    </button>
  );
}
