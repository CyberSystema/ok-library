// The trash — deleted records, and the way back.
//
// `books.delete` has always been described as putting a book in the trash, and
// the three endpoints (list, restore, purge) have existed since Phase A with no
// screen: the only deletion the librarian could see was permanent-looking, and
// a mis-click was unrecoverable without an HTTP client.
//
// Two kinds of row live here and they are NOT the same thing:
//   · a record someone deleted — restoring it is an undo
//   · a record the merge tool folded into another, carrying `mergedInto` —
//     restoring that one brings back a duplicate, and its copies stayed with
//     the keeper, so it comes back with a fresh empty copy
// They are labelled differently for that reason.
import React, { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api';
import { useT } from '../i18n';
import { useConfirm, useToast } from '../ui';
import { fmt } from '../ui';
import { HelpLink } from '../handbook/context';

type TrashedBook = {
  id: string;
  title: string;
  author: string;
  deletedAt?: string | null;
  mergedInto?: string | null;
  shelfCode?: string | null;
};

const PAGE = 25;

export function TrashCard({ canDelete, onChanged }: { canDelete: boolean; onChanged?: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<TrashedBook[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p: number) => {
    try {
      const res = await apiRequest<{ items: TrashedBook[]; total: number }>(
        `/api/books/trash?page=${p}&pageSize=${PAGE}`
      );
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
      setPage(p);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }, [toast]);

  useEffect(() => { if (open) void load(1); }, [open, load]);

  async function restore(b: TrashedBook) {
    // A merged-away record is not an accidental deletion. Bringing it back
    // re-creates the duplicate the merge removed, and its copies stayed with the
    // record that absorbed it — so it returns with one fresh empty copy.
    if (b.mergedInto) {
      const ok = await confirm({
        title: t('trash.restoreMergedTitle'),
        body: t('trash.restoreMergedBody'),
        confirmLabel: t('trash.restore')
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await apiRequest(`/api/books/${b.id}/restore`, { method: 'POST' });
      toast.push('success', t('trash.restored', { title: b.title || t('common.untitled') }));
      await load(page);
      onChanged?.();
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function purge(b: TrashedBook) {
    const ok = await confirm({
      title: t('trash.purgeTitle'),
      body: t('trash.purgeBody', { title: b.title || t('common.untitled') }),
      confirmLabel: t('trash.purge'),
      danger: true
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiRequest(`/api/books/${b.id}/purge`, { method: 'DELETE' });
      toast.push('success', t('trash.purged'));
      // The last row of the last page leaves an empty page behind.
      await load(items.length === 1 && page > 1 ? page - 1 : page);
      onChanged?.();
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="card">
      <h3>
        🗑 {t('trash.heading')}
        <HelpLink anchor="the-trash" label={t('handbook.helpAbout', { field: t('trash.heading') })} />
      </h3>
      <p className="muted small" style={{ marginBottom: '0.75rem' }}>{t('trash.intro')}</p>

      {!open ? (
        <button className="secondary" onClick={() => setOpen(true)}>{t('trash.show')}</button>
      ) : (
        <>
          <p className="muted small">{t('trash.count', { n: fmt(total) })}</p>
          {items.length === 0 ? (
            <p className="muted small" style={{ marginTop: '0.5rem' }}>{t('trash.empty')}</p>
          ) : (
            <ul className="cf-list">
              {items.map((b) => (
                <li key={b.id} className="cf-row">
                  <div className="cf-row-text">
                    <strong>{b.title || t('common.untitled')}</strong>
                    {b.author ? <span className="muted small"> · {b.author}</span> : null}
                    {b.mergedInto && <span className="badge warn">{t('trash.mergedBadge')}</span>}
                    <span className="muted small" style={{ display: 'block' }}>
                      {b.deletedAt ? t('trash.deletedOn', { date: new Date(b.deletedAt).toLocaleString() }) : ''}
                      {b.shelfCode ? ` · ${b.shelfCode}` : ''}
                    </span>
                  </div>
                  {canDelete && (
                    <div className="button-group">
                      <button className="secondary small" disabled={busy} onClick={() => void restore(b)}>
                        {t('trash.restore')}
                      </button>
                      <button className="danger small" disabled={busy} onClick={() => void purge(b)}>
                        {t('trash.purge')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="button-group" style={{ marginTop: '0.75rem' }}>
            <button className="secondary small" disabled={page <= 1} onClick={() => void load(page - 1)}>
              {t('library.page.prev')}
            </button>
            <span className="muted small" style={{ alignSelf: 'center' }}>
              {t('library.page.info', { page: fmt(page) })} {t('library.page.of')} {fmt(pages)}
            </span>
            <button className="secondary small" disabled={page >= pages} onClick={() => void load(page + 1)}>
              {t('library.page.next')}
            </button>
            <button className="secondary small" onClick={() => setOpen(false)}>{t('common.close')}</button>
          </div>
        </>
      )}
    </div>
  );
}
