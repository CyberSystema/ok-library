// The run of a periodical — what is actually on the shelf, as one statement.
//
// ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ is catalogued as 47 separate book records. A periodical
// is one title with a RUN of issues held, which is why MARC keeps holdings
// statements rather than a record per issue: "τόμος 1-10 (1880-1889), λείπει ο
// τ. 7" says in one line what 47 rows cannot, and it can be searched, exported
// and reported on as a serial.
//
// Migration 0026 built `serial_holdings` for exactly this and nothing in the
// system could read or write it — the single statement that named the table was
// a merge re-parent that could never match a row.
//
// Two deliberate choices carried from the schema:
//   · `gaps` is free text. A real gap statement is "τ. 7, 12-14", and a numeric
//     model would lose the librarian's own qualification of it.
//   · An empty list is fine. A periodical whose run nobody has written down yet
//     is a normal state — unlike a record with no copies, which falls out of the
//     catalogue entirely.
import React, { useState } from 'react';
import { formatHoldingStatement } from '@ok-library/shared';
import type { Book } from '../types';
import { apiRequest } from '../api';
import { useT } from '../i18n';
import { Dialog, useToast } from '../ui';

export type SerialHolding = {
  id: string;
  bookId: string;
  caption?: string | null;
  fromVolume?: string | null;
  toVolume?: string | null;
  fromYear?: number | null;
  toYear?: number | null;
  gaps?: string | null;
  note?: string | null;
  seq: number;
};

type Draft = {
  key: string;
  id?: string;
  caption: string;
  fromVolume: string;
  toVolume: string;
  fromYear: string;
  toYear: string;
  gaps: string;
  note: string;
};

let seq = 0;
const nextKey = () => `new-${(seq += 1)}`;

function toDraft(h: SerialHolding): Draft {
  return {
    key: h.id,
    id: h.id,
    caption: h.caption ?? '',
    fromVolume: h.fromVolume ?? '',
    toVolume: h.toVolume ?? '',
    fromYear: h.fromYear != null ? String(h.fromYear) : '',
    toYear: h.toYear != null ? String(h.toYear) : '',
    gaps: h.gaps ?? '',
    note: h.note ?? ''
  };
}

function toPayload(d: Draft) {
  const t = (v: string) => v.trim() || null;
  const n = (v: string) => {
    const parsed = Number(v.trim());
    return v.trim() && Number.isInteger(parsed) ? parsed : null;
  };
  return {
    ...(d.id ? { id: d.id } : {}),
    caption: t(d.caption),
    fromVolume: t(d.fromVolume),
    toVolume: t(d.toVolume),
    fromYear: n(d.fromYear),
    toYear: n(d.toYear),
    gaps: t(d.gaps),
    note: t(d.note)
  };
}

export function SerialHoldingsEditor({ book, holdings, onClose, onSaved }: {
  book: Book;
  holdings: SerialHolding[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Draft[]>(() => holdings.map(toDraft));
  const [busy, setBusy] = useState(false);

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

  async function save() {
    setBusy(true);
    try {
      await apiRequest(`/api/books/${book.id}/serial-holdings`, {
        method: 'PUT',
        body: JSON.stringify({
          holdings: drafts.map(toPayload),
          expectedVersion: book.version
        })
      });
      toast.push('success', t('serials.saved'));
      await onSaved();
      onClose();
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} labelledBy="serials-editor-title" className="modal wide">
      <div className="modal-header">
        <h3 id="serials-editor-title">{t('serials.editorTitle')}</h3>
        <button className="icon-button" onClick={onClose} aria-label={t('common.close')}>✕</button>
      </div>

      <p className="muted small">{t('serials.editorIntro')}</p>

      {drafts.length === 0 ? (
        <div className="empty-state" style={{ padding: '1rem 0' }}>
          <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>📚</p>
          <p style={{ fontWeight: 600 }}>{t('serials.none')}</p>
          <p className="muted small">{t('serials.noneBody')}</p>
        </div>
      ) : (
        <ul className="copy-drafts">
          {drafts.map((d, index) => {
            // The same function the MARC exporter uses, so what the librarian
            // reads here is exactly what another library will receive in 866$a.
            const statement = formatHoldingStatement({
              caption: d.caption,
              fromVolume: d.fromVolume,
              toVolume: d.toVolume,
              fromYear: Number(d.fromYear) || null,
              toYear: Number(d.toYear) || null
            });
            return (
              <li key={d.key} className="copy-draft">
                <div className="copy-draft-head">
                  <strong>{t('serials.nth', { n: index + 1 })}</strong>
                  <span className="copy-draft-actions">
                    <button className="secondary small" disabled={index === 0}
                      onClick={() => move(index, -1)} aria-label={t('serials.moveUp')}>↑</button>
                    <button className="secondary small" disabled={index === drafts.length - 1}
                      onClick={() => move(index, 1)} aria-label={t('serials.moveDown')}>↓</button>
                    <button className="danger small"
                      onClick={() => setDrafts((prev) => prev.filter((x) => x.key !== d.key))}>
                      {t('common.remove')}
                    </button>
                  </span>
                </div>

                <div className="form-row">
                  <div>
                    <label htmlFor={`sh-cap-${d.key}`}>{t('serials.caption')}</label>
                    <input id={`sh-cap-${d.key}`} value={d.caption}
                      onChange={(e) => patch(d.key, { caption: e.target.value })}
                      placeholder={t('serials.captionPh')} />
                  </div>
                  <div>
                    <label htmlFor={`sh-fv-${d.key}`}>{t('serials.fromVolume')}</label>
                    <input id={`sh-fv-${d.key}`} value={d.fromVolume}
                      onChange={(e) => patch(d.key, { fromVolume: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor={`sh-tv-${d.key}`}>{t('serials.toVolume')}</label>
                    <input id={`sh-tv-${d.key}`} value={d.toVolume}
                      onChange={(e) => patch(d.key, { toVolume: e.target.value })}
                      placeholder={t('serials.toVolumePh')} />
                  </div>
                </div>

                <div className="form-row">
                  <div>
                    <label htmlFor={`sh-fy-${d.key}`}>{t('serials.fromYear')}</label>
                    <input id={`sh-fy-${d.key}`} inputMode="numeric" value={d.fromYear}
                      onChange={(e) => patch(d.key, { fromYear: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor={`sh-ty-${d.key}`}>{t('serials.toYear')}</label>
                    <input id={`sh-ty-${d.key}`} inputMode="numeric" value={d.toYear}
                      onChange={(e) => patch(d.key, { toYear: e.target.value })}
                      placeholder={t('serials.toYearPh')} />
                  </div>
                </div>

                <div className="form-field">
                  <label htmlFor={`sh-gaps-${d.key}`}>{t('serials.gaps')}</label>
                  <input id={`sh-gaps-${d.key}`} value={d.gaps}
                    onChange={(e) => patch(d.key, { gaps: e.target.value })}
                    placeholder={t('serials.gapsPh')} />
                </div>

                <div className="form-field">
                  <label htmlFor={`sh-note-${d.key}`}>{t('serials.note')}</label>
                  <input id={`sh-note-${d.key}`} value={d.note}
                    onChange={(e) => patch(d.key, { note: e.target.value })}
                    placeholder={t('serials.notePh')} />
                </div>

                {statement && (
                  <p className="muted small holdings-preview">
                    {t('serials.preview')} <code>{statement}</code>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <button
        className="secondary small"
        style={{ marginTop: '0.75rem' }}
        onClick={() => setDrafts((prev) => [...prev, {
          key: nextKey(),
          // The caption is the same word all the way down a run, so carry it.
          caption: prev[prev.length - 1]?.caption ?? '',
          fromVolume: '', toVolume: '', fromYear: '', toYear: '', gaps: '', note: ''
        }])}
      >
        {t('serials.addOne')}
      </button>

      <div className="modal-actions">
        <button className="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? t('common.saving') : t('serials.saveAll')}
        </button>
      </div>
    </Dialog>
  );
}
