// The copies editor — one record, its physical volumes, one Save.
//
// `items` has eighteen columns and the replace endpoint has always written
// eleven of them. The interface offered two: a document-type select and an
// acquisition date. So nine writable columns had no control at all, including
// two that other parts of the system already read and print — `call_number`,
// which MARC 852$h exports to any library we send records to, and
// `volume_label`, which the spine-label printer puts on the label.
//
// The old pair of controls also saved on every change event. `PUT
// /api/books/:id/items` is a whole-array replace carrying an `expectedVersion`,
// so each keystroke resent every copy, bumped every copy's version and the
// record's, and — because the controls were never disabled while the request was
// in flight — a librarian moving quickly through a dropdown collided with
// themselves and got "Book was modified by someone else". Editing is now local
// state and there is exactly one request.
//
// Three things this screen deliberately does NOT let you edit:
//   · status — circulation owns it. Shown, never editable.
//   · copy_number — derived from the ORDER of the list, because the endpoint
//     renumbers by position. Reordering is therefore how you renumber.
//   · which copy is primary — that is the first one, by the same rule.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ITEM_TYPES } from '@ok-library/shared';
import type { Book, Item } from '../types';
import { apiRequest, isVersionConflict } from '../api';
import { useT } from '../i18n';
import { Dialog, endOfLocalDayIso, isoToLocalDateInput, useConfirm, useToast } from '../ui';
import { HelpLink } from '../handbook/context';

/** The editable projection of a copy. `id` absent means "this one is new". */
type Draft = {
  key: string;
  id?: string;
  barcode: string;
  volumeNum: string;
  volumeLabel: string;
  roomCode: string;
  shelfCode: string;
  callNumber: string;
  itemType: string;
  condition: string;
  acquisitionDate: string;
  notes: string;
  /** Read-only, from the server. A borrowed or held copy cannot be removed. */
  status?: string;
};

let seq = 0;
const nextKey = () => `new-${(seq += 1)}`;

function toDraft(item: Item): Draft {
  return {
    key: item.id,
    id: item.id,
    barcode: item.barcode ?? '',
    volumeNum: item.volumeNum ?? '',
    volumeLabel: item.volumeLabel ?? '',
    roomCode: item.roomCode ?? '',
    shelfCode: item.shelfCode ?? '',
    callNumber: item.callNumber ?? '',
    itemType: item.itemType ?? 'book',
    condition: item.condition ?? '',
    acquisitionDate: item.acquisitionDate ?? '',
    notes: item.notes ?? '',
    status: item.status
  };
}

function blankDraft(from?: Draft): Draft {
  // A second copy of the same book is nearly always the same kind of thing in
  // nearly the same place, so inherit those and leave the identifying fields
  // empty — copying a barcode would be a unique-constraint error waiting.
  return {
    key: nextKey(),
    barcode: '',
    volumeNum: '',
    volumeLabel: '',
    roomCode: from?.roomCode ?? '',
    shelfCode: from?.shelfCode ?? '',
    callNumber: from?.callNumber ?? '',
    itemType: from?.itemType ?? 'book',
    condition: '',
    acquisitionDate: '',
    notes: ''
  };
}

function toPayload(d: Draft) {
  const t = (v: string) => v.trim() || null;
  return {
    ...(d.id ? { id: d.id } : {}),
    barcode: t(d.barcode),
    volumeNum: t(d.volumeNum),
    volumeLabel: t(d.volumeLabel),
    roomCode: t(d.roomCode),
    shelfCode: t(d.shelfCode),
    callNumber: t(d.callNumber),
    itemType: d.itemType || 'book',
    condition: t(d.condition),
    acquisitionDate: t(d.acquisitionDate),
    notes: t(d.notes)
  };
}

export function CopiesEditor({ book, onClose, onSaved }: {
  book: Book;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  /*
   * The server's copies AND version, held here rather than read from the `book` prop.
   *
   * They were read straight off the prop, so a version conflict was a dead end: the dialog
   * stayed open (right — nothing typed should be lost) holding the same stale version, so every
   * further Save could only 409 again. The only way out was to close the editor, losing the
   * work the open dialog existed to protect. Now a conflict reloads into these.
   */
  const [serverItems, setServerItems] = useState<Book['items']>(book.items ?? []);
  const [serverVersion, setServerVersion] = useState(book.version);
  const [reloadedNote, setReloadedNote] = useState(false);
  /*
   * Copies that were taken off the shelf.
   *
   * Withdrawing set items.deleted_at and NOTHING cleared it again — restoreItemsDeletedAt is
   * deliberately narrow, matching the book's own deletion stamp so restoring a record brings
   * back exactly the copies that record's deletion took down. A copy withdrawn on its own, by a
   * slip here, was gone from the app for good. Records have a trash; copies had nothing. They
   * are listed at the bottom so the way back is where the mistake was made.
   */
  const [withdrawn, setWithdrawn] = useState<Item[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>(() => (book.items ?? []).map(toDraft));
  const [busy, setBusy] = useState(false);
  // Removing a copy is a WITHDRAWAL in ISO 2789 terms, so the reason travels
  // with the save rather than being invented afterwards.
  const [withdrawalReason, setWithdrawalReason] = useState('');

  const removedIds = useMemo(() => {
    const kept = new Set(drafts.map((d) => d.id).filter(Boolean));
    return (serverItems ?? []).filter((i) => !kept.has(i.id)).map((i) => i.id);
  }, [drafts, serverItems]);

  /*
   * DIRTY, not BUSY.
   *
   * The comment on this effect said it "guards against losing typed work" and the
   * listener was attached `if (busy)` — busy meaning a save is already in flight, which
   * is the one moment when there is nothing left to lose. So the guard was armed for the
   * wrong instant and unarmed for the whole time it mattered: a librarian could enter ten
   * copies with their shelf marks, conditions and notes, press Escape or click a
   * millimetre outside the dialog, and every keystroke went with no prompt at all.
   *
   * Dirtiness is DERIVED from the drafts rather than set by a flag, so no future edit
   * path can forget to raise it — patch, move, remove and addOne all funnel through
   * `drafts`.
   */
  const dirty = useMemo(() => {
    if (removedIds.length > 0) return true;
    if (withdrawalReason.trim() !== '') return true;
    const initial = (serverItems ?? []).map(toDraft);
    if (initial.length !== drafts.length) return true;
    const strip = (d: Draft) => { const { key, ...rest } = d; return rest; };
    return JSON.stringify(initial.map(strip)) !== JSON.stringify(drafts.map(strip));
  }, [drafts, removedIds, withdrawalReason, serverItems]);

  const loadWithdrawn = useCallback(async () => {
    try {
      const res = await apiRequest<{ withdrawn?: Item[] }>(`/api/books/${book.id}/items?withdrawn=1`);
      setWithdrawn(res.withdrawn ?? []);
    } catch {
      // A list of things that are already gone is not worth an error banner over the
      // editor. The rest of the dialog works without it.
    }
  }, [book.id]);

  useEffect(() => { void loadWithdrawn(); }, [loadWithdrawn]);

  async function restoreCopy(item: Item) {
    const ok = await confirm({
      title: t('copies.restoreTitle'),
      body: t('copies.restoreBody', { n: item.copyNumber }),
      confirmLabel: t('copies.restore')
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiRequest<{ items: Item[] }>(`/api/books/${book.id}/items/${item.id}/restore`, { method: 'POST' });
      // The restore already changed the record, so the editor takes the server's list as its
      // new starting point — including the version, or the next save would conflict with the
      // change this very dialog just made.
      const fresh = await apiRequest<Book>(`/api/books/${book.id}`);
      setServerItems(res.items);
      setServerVersion(fresh.version);
      setDrafts([...res.items.map(toDraft), ...drafts.filter((d) => !d.id)]);
      await loadWithdrawn();
      toast.push('success', t('copies.restored'));
      await onSaved();
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    if (dirty || busy) window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, busy]);

  // Escape and a backdrop click are the two accidental exits, so they ask first — but
  // only when there is something to lose. With a clean editor, Escape still just closes,
  // which is what it should do.
  function requestDismiss() {
    if (!dirty) { onClose(); return; }
    void (async () => {
      const ok = await confirm({
        title: t('copies.discardTitle'),
        body: t('copies.discardBody'),
        confirmLabel: t('copies.discardConfirm'),
        danger: true
      });
      if (ok) onClose();
    })();
  }

  function patch(key: string, next: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...next } : d)));
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= drafts.length) return;
    setDrafts((prev) => {
      const copy = [...prev];
      [copy[index], copy[to]] = [copy[to], copy[index]];
      return copy;
    });
  }

  async function remove(d: Draft, index: number) {
    if (drafts.length === 1) {
      // The endpoint refuses this too. Saying it here means the librarian is not
      // told "400" after typing a reason.
      toast.push('error', t('copies.lastCopy'));
      return;
    }
    if (d.status === 'borrowed') {
      toast.push('error', t('copies.onLoan'));
      return;
    }
    if (d.id) {
      const ok = await confirm({
        title: t('copies.withdrawTitle'),
        body: t('copies.withdrawBody', { n: index + 1 }),
        confirmLabel: t('copies.withdraw'),
        danger: true
      });
      if (!ok) return;
    }
    setDrafts((prev) => prev.filter((x) => x.key !== d.key));
  }

  async function save() {
    setBusy(true);
    try {
      await apiRequest(`/api/books/${book.id}/items`, {
        method: 'PUT',
        body: JSON.stringify({
          items: drafts.map(toPayload),
          expectedVersion: serverVersion,
          ...(removedIds.length > 0 && withdrawalReason.trim()
            ? { withdrawalReason: withdrawalReason.trim() }
            : {})
        })
      });
      toast.push('success', t('copies.saved'));
      await onSaved();
      onClose();
    } catch (e) {
      // A duplicate barcode and a stale version both come back as a 409 with a
      // sentence that says which; the dialog stays open so nothing typed is lost.
      toast.push('error', (e as Error).message);
      /*
       * A stale version needs more than a message. Until add-copies started moving
       * books.version this conflict could not even happen — the guard passed and a
       * colleague's newly added copy was withdrawn instead. Now that it fires, the editor has
       * to offer a way forward, or the librarian's only option is to close the dialog and
       * lose what they typed.
       *
       * Reload into the CURRENT list, and keep the copies they had added that were never
       * saved — those have no id, so they cannot be in conflict with anything. Edits to
       * copies that already existed are replaced by the server's version of them, and the
       * note below says so rather than leaving the librarian to notice.
       */
      if (isVersionConflict(e)) {
        try {
          const fresh = await apiRequest<Book>(`/api/books/${book.id}`);
          const unsaved = drafts.filter((d) => !d.id);
          setServerItems(fresh.items ?? []);
          setServerVersion(fresh.version);
          setDrafts([...(fresh.items ?? []).map(toDraft), ...unsaved]);
          setReloadedNote(true);
        } catch {
          // Leave the dialog exactly as it is. A failed reload must not also
          // discard the drafts.
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog stacked onClose={onClose} onDismissAttempt={requestDismiss} labelledBy="copies-editor-title" className="modal wide">
      <div className="modal-header">
        <h3 id="copies-editor-title">
          {t('copies.editorTitle', { n: drafts.length })}
          <HelpLink anchor="adding-a-copy" label={t('handbook.helpAbout', { field: t('copies.editorTitle', { n: drafts.length }) })} />
        </h3>
        <button className="icon-button" onClick={onClose} aria-label={t('common.close')}>✕</button>
      </div>

      <p className="muted small">{t('copies.editorIntro')}</p>

      {reloadedNote && (
        <p className="inline-warning" role="status">{t('copies.reloadedAfterConflict')}</p>
      )}

      <ul className="copy-drafts">
        {drafts.map((d, index) => (
          <li key={d.key} className="copy-draft">
            <div className="copy-draft-head">
              <strong>{t('library.copies.nth', { n: index + 1 })}</strong>
              {d.status && (
                <span className={`status-badge status-${d.status}`}>{t(`status.${d.status}`)}</span>
              )}
              {!d.id && <span className="badge">{t('copies.new')}</span>}
              <span className="copy-draft-actions">
                <button
                  className="secondary small"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={t('copies.moveUp')}
                >↑</button>
                <button
                  className="secondary small"
                  disabled={index === drafts.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={t('copies.moveDown')}
                >↓</button>
                <button className="danger small" onClick={() => void remove(d, index)}>
                  {d.id ? t('copies.withdraw') : t('common.remove')}
                </button>
              </span>
            </div>

            <div className="form-row">
              <div>
                <label htmlFor={`cd-type-${d.key}`}>{t('policies.itemType')}</label>
                <select
                  id={`cd-type-${d.key}`}
                  value={d.itemType}
                  onChange={(e) => patch(d.key, { itemType: e.target.value })}
                >
                  {ITEM_TYPES.map((it) => <option key={it} value={it}>{t(`itemType.${it}`)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={`cd-barcode-${d.key}`}>{t('copies.barcode')}</label>
                <HelpLink anchor="why-barcodes" label={t('handbook.helpAbout', { field: t('copies.barcode') })} />
                <input
                  id={`cd-barcode-${d.key}`}
                  className="mono"
                  value={d.barcode}
                  onChange={(e) => patch(d.key, { barcode: e.target.value })}
                  placeholder={t('copies.barcodePh')}
                />
              </div>
            </div>

            <div className="form-row">
              <div>
                <label htmlFor={`cd-room-${d.key}`}>{t('copies.room')}</label>
                <input
                  id={`cd-room-${d.key}`}
                  value={d.roomCode}
                  onChange={(e) => patch(d.key, { roomCode: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`cd-shelf-${d.key}`}>{t('copies.shelf')}</label>
                <input
                  id={`cd-shelf-${d.key}`}
                  value={d.shelfCode}
                  onChange={(e) => patch(d.key, { shelfCode: e.target.value })}
                />
              </div>
              <div>
                {/* MARC 852$h. Exported to every library we send records to. */}
                <label htmlFor={`cd-call-${d.key}`}>{t('copies.callNumber')}</label>
                <HelpLink anchor="call-numbers" label={t('handbook.helpAbout', { field: t('copies.callNumber') })} />
                <input
                  id={`cd-call-${d.key}`}
                  value={d.callNumber}
                  onChange={(e) => patch(d.key, { callNumber: e.target.value })}
                  placeholder={t('copies.callNumberPh')}
                />
              </div>
            </div>

            <div className="form-row">
              <div>
                <label htmlFor={`cd-vnum-${d.key}`}>{t('copies.volumeNum')}</label>
                <input
                  id={`cd-vnum-${d.key}`}
                  value={d.volumeNum}
                  onChange={(e) => patch(d.key, { volumeNum: e.target.value })}
                  placeholder={t('copies.volumeNumPh')}
                />
              </div>
              <div>
                {/* What the spine label prints. */}
                <label htmlFor={`cd-vlabel-${d.key}`}>{t('copies.volumeLabel')}</label>
                <input
                  id={`cd-vlabel-${d.key}`}
                  value={d.volumeLabel}
                  onChange={(e) => patch(d.key, { volumeLabel: e.target.value })}
                />
              </div>
            </div>

            <div className="form-row">
              <div>
                <label htmlFor={`cd-cond-${d.key}`}>{t('copies.condition')}</label>
                <input
                  id={`cd-cond-${d.key}`}
                  value={d.condition}
                  onChange={(e) => patch(d.key, { condition: e.target.value })}
                  placeholder={t('copies.conditionPh')}
                />
              </div>
              <div>
                <label htmlFor={`cd-acq-${d.key}`}>{t('copies.acquired')}</label>
                <input
                  id={`cd-acq-${d.key}`}
                  type="date"
                  value={isoToLocalDateInput(d.acquisitionDate)}
                  onChange={(e) => patch(d.key, {
                    acquisitionDate: e.target.value ? endOfLocalDayIso(e.target.value) : ''
                  })}
                />
              </div>
            </div>

            <div className="form-field">
              <label htmlFor={`cd-notes-${d.key}`}>{t('copies.notes')}</label>
              <input
                id={`cd-notes-${d.key}`}
                value={d.notes}
                onChange={(e) => patch(d.key, { notes: e.target.value })}
                placeholder={t('copies.notesPh')}
              />
            </div>
          </li>
        ))}
      </ul>

      <button
        className="secondary small"
        onClick={() => setDrafts((prev) => [...prev, blankDraft(prev[prev.length - 1])])}
      >
        {t('copies.addOne')}
      </button>

      {removedIds.length > 0 && (
        <div className="form-field withdrawal-reason">
          <HelpLink anchor="withdrawal-reasons" label={t('handbook.helpAbout', { field: t('copies.withdrawalReason', { n: removedIds.length }) })} />
          <label htmlFor="cd-withdrawal-reason">
            {t('copies.withdrawalReason', { n: removedIds.length })}
          </label>
          <input
            id="cd-withdrawal-reason"
            value={withdrawalReason}
            onChange={(e) => setWithdrawalReason(e.target.value)}
            placeholder={t('copies.withdrawalReasonPh')}
          />
          <p className="muted small">{t('copies.withdrawalReasonHelp')}</p>
        </div>
      )}

      {withdrawn.length > 0 && (
        <details className="withdrawn-copies">
          <summary>{t('copies.withdrawnHeading', { n: withdrawn.length })}</summary>
          <p className="muted small">{t('copies.withdrawnIntro')}</p>
          <ul className="withdrawn-list">
            {withdrawn.map((w) => (
              <li key={w.id}>
                <span className="withdrawn-what">
                  {t('library.copies.nth', { n: w.copyNumber })}
                  {w.barcode && <span className="mono small"> · {w.barcode}</span>}
                  {w.shelfCode && <span className="muted small"> · {w.shelfCode}</span>}
                </span>
                {w.withdrawalReason && <span className="muted small">{w.withdrawalReason}</span>}
                <button className="secondary small" disabled={busy} onClick={() => void restoreCopy(w)}>
                  {t('copies.restore')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="modal-actions">
        <button className="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button className="primary" onClick={() => void save()} disabled={busy}>
          {/* No count here: the dialog title already carries it, and the count
              would need plural variants in four languages (Russian has four
              forms) for a single button. */}
          {busy ? t('common.saving') : t('copies.saveAll')}
        </button>
      </div>
    </Dialog>
  );
}
