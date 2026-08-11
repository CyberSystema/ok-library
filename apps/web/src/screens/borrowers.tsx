// Readers — who they are, what they have out, and what rules apply to them.
//
// The whole server side of this has existed since migration 0006, and migration
// 0029 added the `category` column that one axis of the loan-policy matrix
// resolves on. Eight endpoints, including GDPR subject-access export and
// right-to-erasure. The web bundle contained exactly ONE reference to
// /api/borrowers — a GET for the checkout autocomplete.
//
// The consequence was not cosmetic. `resolveBorrower`, the only path that ever
// created a borrower in practice, omits `category` from its INSERT, so every
// reader took the 'standard' default and nothing could change it. Every borrower
// in the development database was 'standard'; the (category × item type) matrix
// could only ever match the '*' fallback row, and half of Phase D's policy engine
// was dead. The category control here is what turns it on. (Production has no
// readers at all yet, so this is a capability waiting rather than a repair.)
//
// The GDPR pair is admin-only (`setup`), which is why it is a separate block: a
// librarian runs the desk, an administrator answers a data-subject request.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api';
import { useT } from '../i18n';
import { Dialog, fmt, useConfirm, useToast } from '../ui';
import { HelpLink } from '../handbook/context';

export type Borrower = {
  id: string;
  name: string;
  contact?: string | null;
  notes?: string | null;
  category: string;
  createdAt?: string;
  updatedAt?: string;
  totalLoans: number;
  openLoans: number;
  overdueLoans: number;
};

type BorrowerDetail = {
  id: string;
  name: string;
  contact?: string | null;
  notes?: string | null;
  category: string;
  loans: Array<{
    id: string;
    bookId: string;
    title: string;
    author: string;
    borrowedAt: string;
    dueAt: string;
    returnedAt: string | null;
    isOverdue: boolean;
  }>;
};

const PAGE = 25;
const BLANK = { name: '', contact: '', category: 'standard', notes: '' };

export function BorrowersCard({ canWrite, canAdmin }: { canWrite: boolean; canAdmin: boolean }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<Borrower[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [form, setForm] = useState(BLANK);
  const [detail, setDetail] = useState<BorrowerDetail | null>(null);
  const [busy, setBusy] = useState(false);
  /** The categories loan rules actually mention, so the field offers real values. */
  const [knownCategories, setKnownCategories] = useState<string[]>([]);

  /** Only the newest reader search may write its answer into the list. */
  const seqRef = useRef(0);
  /** True until the first load lands, so mount does not wait out the debounce. */
  const firstLoadRef = useRef(true);

  const load = useCallback(async (p: number) => {
    const seq = ++seqRef.current;
    try {
      const params = new URLSearchParams({ limit: String(PAGE), page: String(p) });
      if (query.trim()) params.set('q', query.trim());
      const res = await apiRequest<{ items: Borrower[]; total: number }>(`/api/borrowers?${params}`);
      // A slow request for "Pol" answering after the one for "Policy" used to
      // repopulate the list with rows for a prefix the box no longer holds.
      if (seq !== seqRef.current) return;
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
      setPage(p);
      setLoaded(true);
    } catch (e) {
      if (seq !== seqRef.current) return;
      toast.push('error', (e as Error).message);
    }
  }, [query, toast]);

  // One request per PAUSE in typing, not one per keystroke.
  //
  // This effect used to call load(1) synchronously, so typing a six-character
  // reader name at the desk sent six D1-backed /api/borrowers requests — the
  // exact cost the checkout autocomplete is debounced at 180 ms to avoid. The
  // first load is not delayed: the librarian opening the tab should not watch a
  // spinner for a quarter of a second to be told nothing is happening.
  useEffect(() => {
    if (firstLoadRef.current) {
      firstLoadRef.current = false;
      void load(1);
      return;
    }
    const handle = window.setTimeout(() => { void load(1); }, 250);
    return () => window.clearTimeout(handle);
  }, [load]);

  // Both sides of the matrix in one list: the categories some reader already
  // has, and the categories a loan rule is written for. A rule for a category
  // nobody is in does nothing, and a reader in a category no rule mentions
  // silently falls through to the ( * / * ) fallback — so both are worth seeing.
  useEffect(() => {
    void (async () => {
      try {
        const res = await apiRequest<{
          policies: Array<{ borrowerCategory: string }>;
          borrowerCategories: Array<{ category: string }>;
        }>('/api/loan-policies');
        const set = new Set<string>(['standard']);
        for (const p of res.policies ?? []) if (p.borrowerCategory !== '*') set.add(p.borrowerCategory);
        for (const b of res.borrowerCategories ?? []) if (b.category) set.add(b.category);
        setKnownCategories([...set].sort());
      } catch {
        setKnownCategories(['standard']);
      }
    })();
  }, []);

  async function openEdit(id: string) {
    try {
      const res = await apiRequest<BorrowerDetail>(`/api/borrowers/${id}`);
      setDetail(res);
      setForm({
        name: res.name,
        contact: res.contact ?? '',
        category: res.category ?? 'standard',
        notes: res.notes ?? ''
      });
      setEditing(id);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function save() {
    if (!form.name.trim()) {
      toast.push('error', t('borrowers.needName'));
      return;
    }
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: form.name.trim(),
        contact: form.contact.trim() || null,
        category: form.category.trim() || 'standard',
        notes: form.notes.trim() || null
      });
      if (editing === 'new') await apiRequest('/api/borrowers', { method: 'POST', body });
      else await apiRequest(`/api/borrowers/${editing}`, { method: 'PUT', body });
      toast.push('success', t('borrowers.saved'));
      setEditing(null);
      setDetail(null);
      await load(page);
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(b: Borrower) {
    if (b.openLoans > 0) {
      toast.push('error', t('borrowers.hasOpenLoans', { n: fmt(b.openLoans) }));
      return;
    }
    const ok = await confirm({
      title: t('borrowers.deleteTitle'),
      body: t('borrowers.deleteBody', { name: b.name, n: fmt(b.totalLoans) }),
      confirmLabel: t('common.delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await apiRequest(`/api/borrowers/${b.id}`, { method: 'DELETE' });
      toast.push('success', t('borrowers.deleted'));
      await load(items.length === 1 && page > 1 ? page - 1 : page);
    } catch (e) {
      // The endpoint refuses while loans reference the borrower, and says so.
      toast.push('error', (e as Error).message);
    }
  }

  async function gdprExport(b: Borrower) {
    try {
      const text = await apiRequest<string>(`/api/borrowers/${b.id}/export`, undefined, true);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `borrower-${b.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.push('success', t('borrowers.exported'));
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function gdprErase(b: Borrower) {
    const ok = await confirm({
      title: t('borrowers.eraseTitle'),
      body: t('borrowers.eraseBody', { name: b.name }),
      confirmLabel: t('borrowers.erase'),
      danger: true
    });
    if (!ok) return;
    try {
      const res = await apiRequest<{ anonymizedName: string }>(`/api/borrowers/${b.id}/erase`, { method: 'POST' });
      toast.push('success', t('borrowers.erased', { name: res.anonymizedName }));
      await load(page);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="card">
      <h3>
        👤 {t('borrowers.heading')}
        <HelpLink anchor="readers" label={t('handbook.helpAbout', { field: t('borrowers.heading') })} />
      </h3>
      <p className="muted small" style={{ marginBottom: '0.5rem' }}>{t('borrowers.intro')}</p>
      <p className="muted small callout">
        {t('borrowers.categoryNote')}
        <HelpLink anchor="reader-categories" label={t('handbook.helpAbout', { field: t('borrowers.category') })} />
      </p>

      <div className="form-row" style={{ marginTop: '0.75rem' }}>
        <div>
          <label htmlFor="bor-q">{t('borrowers.search')}</label>
          <input id="bor-q" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t('borrowers.searchPh')} />
        </div>
      </div>

      {!loaded ? (
        <p className="muted small">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <div className="empty-state" style={{ padding: '1rem 0' }}>
          <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>👤</p>
          <p style={{ fontWeight: 600 }}>{t('borrowers.none')}</p>
          <p className="muted small">{t('borrowers.noneBody')}</p>
        </div>
      ) : (
        <>
          <p className="muted small">{t('borrowers.count', { n: fmt(total) })}</p>
          <ul className="cf-list">
            {items.map((b) => (
              <li key={b.id} className="cf-row">
                <div className="cf-row-text">
                  <strong>{b.name}</strong>
                  {b.contact ? <span className="muted small"> · {b.contact}</span> : null}
                  <span className="badge">{b.category}</span>
                  <span className="muted small" style={{ display: 'block' }}>
                    {t('borrowers.loanCounts', {
                      total: fmt(b.totalLoans), open: fmt(b.openLoans)
                    })}
                    {b.overdueLoans > 0 ? ` · ${t('borrowers.overdue', { n: fmt(b.overdueLoans) })}` : ''}
                  </span>
                </div>
                <div className="button-group">
                  {canWrite && (
                    <button className="secondary small" onClick={() => void openEdit(b.id)}>{t('common.edit')}</button>
                  )}
                  {canAdmin && (
                    <>
                      <button className="secondary small" onClick={() => void gdprExport(b)}>
                        {t('borrowers.export')}
                      </button>
                      <button className="danger small" onClick={() => void gdprErase(b)}>
                        {t('borrowers.erase')}
                      </button>
                    </>
                  )}
                  {canWrite && (
                    <button className="secondary small" onClick={() => void remove(b)}>{t('common.delete')}</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="button-group" style={{ marginTop: '0.75rem' }}>
            <button className="secondary small" disabled={page <= 1} onClick={() => void load(page - 1)}>
              {t('library.page.prev')}
            </button>
            <span className="muted small" style={{ alignSelf: 'center' }}>
              {/* `library.page.info` is the bare word "Page" in all four locales —
                  no {page} placeholder — so passing one interpolated to nothing and
                  this pager read "Page of 8" at every position. The number is its
                  own node, exactly as the Library tab's pager renders it. */}
              {t('library.page.info')} {fmt(page)} {t('library.page.of')} {fmt(pages)}
            </span>
            <button className="secondary small" disabled={page >= pages} onClick={() => void load(page + 1)}>
              {t('library.page.next')}
            </button>
          </div>
        </>
      )}

      {canWrite && (
        <button className="secondary small" style={{ marginTop: '0.75rem' }}
          onClick={() => { setEditing('new'); setForm(BLANK); setDetail(null); }}>
          {t('borrowers.add')}
        </button>
      )}

      {editing && (
        <Dialog onClose={() => { setEditing(null); setDetail(null); }} labelledBy="bor-edit-title" className="modal wide">
          <div className="modal-header">
            <h3 id="bor-edit-title">
              {editing === 'new' ? t('borrowers.addTitle') : t('borrowers.editTitle')}
            </h3>
            <button className="icon-button" onClick={() => { setEditing(null); setDetail(null); }}
              aria-label={t('common.close')}>✕</button>
          </div>

          <div className="form-row">
            <div>
              <label htmlFor="bor-f-name">{t('borrowers.name')}</label>
              <input id="bor-f-name" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="bor-f-contact">{t('borrowers.contact')}</label>
              <input id="bor-f-contact" value={form.contact}
                onChange={(e) => setForm({ ...form, contact: e.target.value })}
                placeholder={t('borrowers.contactPh')} />
            </div>
          </div>

          <div className="form-field">
            {/* The one field that changes what this reader may do. Free text on
                purpose — the loan-rules table is free text too — but offered as a
                list so the two sides of the matrix are typed the same way. */}
            <label htmlFor="bor-f-category">{t('borrowers.category')}</label>
            <HelpLink anchor="reader-categories" label={t('handbook.helpAbout', { field: t('borrowers.category') })} />
            <input id="bor-f-category" list="bor-categories" value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <datalist id="bor-categories">
              {knownCategories.map((c) => <option key={c} value={c} />)}
            </datalist>
            <p className="muted small">{t('borrowers.categoryHelp')}</p>
          </div>

          <div className="form-field">
            <label htmlFor="bor-f-notes">{t('borrowers.notes')}</label>
            <input id="bor-f-notes" value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>

          {detail && detail.loans.length > 0 && (
            <div className="form-field">
              <p className="muted small" style={{ fontWeight: 600 }}>
                {t('borrowers.history', { n: fmt(detail.loans.length) })}
              </p>
              <ul className="plain-list small">
                {detail.loans.slice(0, 15).map((l) => (
                  <li key={l.id}>
                    {l.title}
                    <span className="muted">
                      {' · '}
                      {l.returnedAt
                        ? t('borrowers.returned', { date: new Date(l.returnedAt).toLocaleDateString() })
                        : t('borrowers.dueOn', { date: new Date(l.dueAt).toLocaleDateString() })}
                    </span>
                    {l.isOverdue && <span className="badge warn">{t('borrowers.overdueBadge')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="modal-actions">
            <button className="secondary" onClick={() => { setEditing(null); setDetail(null); }} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button className="primary" onClick={() => void save()} disabled={busy}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
