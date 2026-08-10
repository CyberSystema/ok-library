// Authority control — one heading per person, body, publisher or subject.
//
// Migration 0025 built three tables and six endpoints and there was no interface
// at all: `grep -rni "authorit" apps/web` returned one hit, the word
// "authoritative" in an unrelated comment. So no librarian could create a
// heading, see one, link one to a book, or seed a subject list. The tables were
// reachable only by hand-written HTTP.
//
// ── How this differs from the value-consistency tool ──────────────────────────
//
// Both tools answer "one person, spelled several ways", and they answer it in
// opposite directions. That collision is the reason both screens carry a note
// pointing at the other.
//
//   Value consistency REWRITES. It finds books whose `author` differs only by
//   accents or case and overwrites the column with the spelling you choose. The
//   variants are gone afterwards; there is no record they existed. Right for a
//   plain typo — "ΠΑΠΑΔΟΠΟΥΛΟΣ" vs "Παπαδόπουλος" is one spelling entered twice.
//
//   Authority control POINTS. The free text is left exactly as catalogued, and a
//   link is added to a heading that also stores the variant forms. Right when the
//   forms are all legitimate — "Επιφάνιος Σαλαμίνος", "Epiphanius of Salamis" and
//   "Ἐπιφάνιος Κύπρου" are one person under three real names, and rewriting any of
//   them into the others would destroy information.
//
// Rule of thumb, and what the Handbook will say: if one of the spellings is
// simply wrong, consolidate it. If all of them are right, make a heading.
import React, { useCallback, useEffect, useState } from 'react';
import { MARC_RELATORS } from '@ok-library/shared';
import { apiRequest } from '../api';
import { useT } from '../i18n';
import { Combobox, Dialog, fmt, useConfirm, useToast } from '../ui';
import { HelpLink } from '../handbook/context';

const KINDS = ['person', 'corporate', 'publisher', 'subject', 'uniform_title'] as const;
const SOURCES = ['local', 'lcsh', 'viaf', 'lc', 'imported'] as const;

export type Authority = {
  id: string;
  kind: string;
  preferredForm: string;
  preferredFormRomanized?: string | null;
  source: string;
  viafId?: string | null;
  lcId?: string | null;
  isni?: string | null;
  dates?: string | null;
  notes?: string | null;
  useCount: number;
};

export type AuthorityDetail = Authority & {
  variants: string[];
  usedBy: Array<{ id: string; title: string; author: string; role: string }>;
};

export type AuthorityLink = {
  authorityId: string;
  kind: string;
  role: string;
  preferredForm: string;
  preferredFormRomanized?: string | null;
  dates?: string | null;
};

const BLANK = {
  kind: 'person' as string,
  preferredForm: '',
  preferredFormRomanized: '',
  source: 'local' as string,
  dates: '',
  viafId: '',
  lcId: '',
  isni: '',
  notes: '',
  variantsText: ''
};

/** Search the authority file and pick one. Used by the book form. */
export function AuthorityPicker({ kind, onPick, label, idPrefix }: {
  kind?: string;
  onPick: (a: Authority) => void;
  label: string;
  idPrefix: string;
}) {
  const t = useT();
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<Authority[]>([]);

  // The endpoint matches the preferred form OR any variant, which is the whole
  // reason variants are stored: the librarian types the spelling they remember,
  // not the one the cataloguer chose.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      const params = new URLSearchParams({ limit: '20' });
      if (kind) params.set('kind', kind);
      if (term.trim()) params.set('q', term.trim());
      try {
        const res = await apiRequest<{ items: Authority[] }>(`/api/authorities?${params}`);
        if (!cancelled) setItems(res.items ?? []);
      } catch {
        if (!cancelled) setItems([]);
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [kind, term]);

  return (
    <Combobox<Authority>
      idPrefix={idPrefix}
      label={label}
      value={term}
      onChange={setTerm}
      placeholder={t('authorities.pickPh')}
      items={items}
      getKey={(a) => a.id}
      renderItem={(a) => (
        <>
          <strong>{a.preferredForm}</strong>
          {a.dates ? <span className="muted small"> ({a.dates})</span> : null}
          <span className="muted small" style={{ display: 'block' }}>
            {t(`authorities.kind.${a.kind}`)} · {t('authorities.usedBy', { n: fmt(a.useCount) })}
          </span>
        </>
      )}
      onPick={(a) => { onPick(a); setTerm(''); }}
    />
  );
}

/** The links on one book: contributors with relator roles, plus subjects. */
export function BookAuthorities({ bookId, canWrite, onChanged }: {
  bookId: string;
  canWrite: boolean;
  onChanged?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [links, setLinks] = useState<AuthorityLink[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ links: AuthorityLink[] }>(`/api/books/${bookId}/authorities`);
      setLinks(res.links ?? []);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }, [bookId, toast]);

  useEffect(() => { void load(); }, [load]);

  async function save(next: AuthorityLink[]) {
    setBusy(true);
    try {
      await apiRequest(`/api/books/${bookId}/authorities`, {
        method: 'PUT',
        body: JSON.stringify({ links: next.map((l) => ({ authorityId: l.authorityId, role: l.role })) })
      });
      setLinks(next);
      toast.push('success', t('authorities.linksSaved'));
      onChanged?.();
    } catch (e) {
      toast.push('error', (e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {links.length === 0 ? (
        <p className="muted small">{t('authorities.noLinks')}</p>
      ) : (
        <ul className="plain-list">
          {links.map((l) => (
            <li key={`${l.authorityId}-${l.role}`} className="endpoint-row">
              <div>
                <strong>{l.preferredForm}</strong>
                {l.dates ? <span className="muted small"> ({l.dates})</span> : null}
                <span className="muted small" style={{ display: 'block' }}>
                  {t(`relator.${l.role}`)} · {t(`authorities.kind.${l.kind}`)}
                </span>
              </div>
              {canWrite && (
                <button
                  className="secondary small"
                  disabled={busy}
                  onClick={() => void save(links.filter((x) => x.authorityId !== l.authorityId || x.role !== l.role))}
                >
                  {t('authorities.unlink')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="form-row" style={{ marginTop: '0.5rem' }}>
          <AuthorityPicker
            idPrefix={`auth-link-${bookId}`}
            label={t('authorities.addLink')}
            onPick={(a) => {
              if (links.some((l) => l.authorityId === a.id)) {
                toast.push('error', t('authorities.alreadyLinked'));
                return;
              }
              void save([...links, {
                authorityId: a.id,
                kind: a.kind,
                // A subject heading links as 'sub', which is what exports as 650;
                // anyone else defaults to author and can be changed after.
                role: a.kind === 'subject' ? 'sub' : 'aut',
                preferredForm: a.preferredForm,
                dates: a.dates
              }]);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** The management screen: browse, create, correct and retire headings. */
export function AuthoritiesCard({ canWrite, onChanged }: { canWrite: boolean; onChanged?: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [kind, setKind] = useState<string>('person');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Authority[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [form, setForm] = useState(BLANK);
  const [detail, setDetail] = useState<AuthorityDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<Array<{ label: string; bookCount: number; alreadyExists: boolean }> | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ kind, limit: '100' });
      if (query.trim()) params.set('q', query.trim());
      const res = await apiRequest<{ items: Authority[] }>(`/api/authorities?${params}`);
      setItems(res.items ?? []);
      setLoaded(true);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }, [kind, query, toast]);

  useEffect(() => { void load(); }, [load]);

  async function openEdit(id: string) {
    try {
      const res = await apiRequest<AuthorityDetail>(`/api/authorities/${id}`);
      setDetail(res);
      setForm({
        kind: res.kind,
        preferredForm: res.preferredForm,
        preferredFormRomanized: res.preferredFormRomanized ?? '',
        source: res.source,
        dates: res.dates ?? '',
        viafId: res.viafId ?? '',
        lcId: res.lcId ?? '',
        isni: res.isni ?? '',
        notes: res.notes ?? '',
        variantsText: (res.variants ?? []).join('\n')
      });
      setEditing(id);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function save() {
    if (!form.preferredForm.trim()) {
      toast.push('error', t('authorities.needForm'));
      return;
    }
    setBusy(true);
    try {
      const body = JSON.stringify({
        kind: form.kind,
        preferredForm: form.preferredForm.trim(),
        preferredFormRomanized: form.preferredFormRomanized.trim() || null,
        source: form.source,
        dates: form.dates.trim() || null,
        viafId: form.viafId.trim() || null,
        lcId: form.lcId.trim() || null,
        isni: form.isni.trim() || null,
        notes: form.notes.trim() || null,
        variants: form.variantsText.split('\n').map((v) => v.trim()).filter(Boolean)
      });
      if (editing === 'new') await apiRequest('/api/authorities', { method: 'POST', body });
      else await apiRequest(`/api/authorities/${editing}`, { method: 'PUT', body });
      toast.push('success', t('authorities.saved'));
      setEditing(null);
      setDetail(null);
      await load();
      onChanged?.();
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Authority) {
    const ok = await confirm({
      title: t('authorities.retireTitle'),
      // Retiring a heading unlinks every book pointing at it. That is deliberate
      // — a book must not point at a heading that no longer exists — but it is
      // also irreversible, so the count is said out loud.
      body: a.useCount > 0
        ? t('authorities.retireBodyUsed', { form: a.preferredForm, n: fmt(a.useCount) })
        : t('authorities.retireBody', { form: a.preferredForm }),
      confirmLabel: t('authorities.retire'),
      danger: true
    });
    if (!ok) return;
    try {
      await apiRequest(`/api/authorities/${a.id}`, { method: 'DELETE' });
      toast.push('success', t('authorities.retired'));
      await load();
      onChanged?.();
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function loadCandidates() {
    try {
      const res = await apiRequest<{ items: Array<{ label: string; bookCount: number; alreadyExists: boolean }> }>(
        '/api/authorities/subject-candidates?limit=500'
      );
      setCandidates(res.items ?? []);
      setApproved(new Set());
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function seed() {
    const labels = [...approved];
    if (labels.length === 0) return;
    setBusy(true);
    try {
      const res = await apiRequest<{ created: number; skipped: number; linked: number }>(
        '/api/authorities/seed-subjects',
        { method: 'POST', body: JSON.stringify({ labels, link: true }) }
      );
      toast.push('success', t('authorities.seeded', { n: fmt(res.created), linked: fmt(res.linked) }));
      setCandidates(null);
      setApproved(new Set());
      setKind('subject');
      await load();
      onChanged?.();
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>
        🏷 {t('authorities.heading')}
        <HelpLink anchor="making-a-heading" label={t('handbook.helpAbout', { field: t('authorities.heading') })} />
      </h3>
      <p className="muted small" style={{ marginBottom: '0.5rem' }}>{t('authorities.intro')}</p>
      {/* The reconciliation. Two tools, one librarian problem — say which is which
          at the point of use, not only in the Handbook. */}
      <p className="muted small callout">{t('authorities.vsConsistency')}</p>

      <div className="form-row" style={{ marginTop: '0.75rem' }}>
        <div>
          <label htmlFor="auth-kind">{t('authorities.kindLabel')}</label>
          <select id="auth-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k} value={k}>{t(`authorities.kind.${k}`)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="auth-q">{t('authorities.search')}</label>
          <input id="auth-q" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t('authorities.searchPh')} />
        </div>
      </div>

      {!loaded ? (
        <p className="muted small">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <div className="empty-state" style={{ padding: '1rem 0' }}>
          <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>🏷</p>
          <p style={{ fontWeight: 600 }}>{t('authorities.none')}</p>
          <p className="muted small">{t('authorities.noneBody')}</p>
        </div>
      ) : (
        <ul className="cf-list">
          {items.map((a) => (
            <li key={a.id} className="cf-row">
              <div className="cf-row-text">
                <strong>{a.preferredForm}</strong>
                {a.dates ? <span className="muted small"> ({a.dates})</span> : null}
                <span className="muted small" style={{ display: 'block' }}>
                  {t('authorities.usedBy', { n: fmt(a.useCount) })}
                  {a.source !== 'local' ? ` · ${a.source.toUpperCase()}` : ''}
                  {a.viafId ? ` · VIAF ${a.viafId}` : ''}
                </span>
              </div>
              {canWrite && (
                <div className="button-group">
                  <button className="secondary small" onClick={() => void openEdit(a.id)}>{t('common.edit')}</button>
                  <button className="secondary small" onClick={() => void remove(a)}>{t('authorities.retire')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="button-group" style={{ marginTop: '0.75rem' }}>
          <button className="secondary small" onClick={() => { setEditing('new'); setForm({ ...BLANK, kind }); setDetail(null); }}>
            {t('authorities.add')}
          </button>
          <button className="secondary small" onClick={() => void loadCandidates()}>
            {t('authorities.seedFromLabels')}
          </button>
        </div>
      )}

      {candidates && (
        <Dialog onClose={() => setCandidates(null)} labelledBy="auth-seed-title" className="modal wide">
          <div className="modal-header">
            <h3 id="auth-seed-title">{t('authorities.seedTitle')}</h3>
            <button className="icon-button" onClick={() => setCandidates(null)} aria-label={t('common.close')}>✕</button>
          </div>
          <p className="muted small">
            {t('authorities.seedIntro', { n: fmt(candidates.length) })}
            <HelpLink anchor="seeding-subjects" label={t('handbook.helpAbout', { field: t('authorities.seedTitle') })} />
          </p>
          <ul className="cf-list" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            {candidates.map((cand) => (
              <li key={cand.label} className="cf-row">
                <label className="checkbox-label" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    disabled={cand.alreadyExists}
                    checked={approved.has(cand.label)}
                    onChange={(e) => setApproved((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(cand.label); else next.delete(cand.label);
                      return next;
                    })}
                  />
                  <span>
                    {cand.label}
                    <span className="muted small"> · {t('authorities.onBooks', { n: fmt(cand.bookCount) })}</span>
                    {cand.alreadyExists && <span className="badge">{t('authorities.exists')}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setCandidates(null)}>{t('common.cancel')}</button>
            <button className="primary" disabled={busy || approved.size === 0} onClick={() => void seed()}>
              {t('authorities.seedConfirm', { n: fmt(approved.size) })}
            </button>
          </div>
        </Dialog>
      )}

      {editing && (
        <Dialog onClose={() => { setEditing(null); setDetail(null); }} labelledBy="auth-edit-title" className="modal wide">
          <div className="modal-header">
            <h3 id="auth-edit-title">
              {editing === 'new' ? t('authorities.addTitle') : t('authorities.editTitle')}
            </h3>
            <button className="icon-button" onClick={() => { setEditing(null); setDetail(null); }}
              aria-label={t('common.close')}>✕</button>
          </div>

          <div className="form-row">
            <div>
              <label htmlFor="auth-f-kind">{t('authorities.kindLabel')}</label>
              <select id="auth-f-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {KINDS.map((k) => <option key={k} value={k}>{t(`authorities.kind.${k}`)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="auth-f-source">{t('authorities.source')}</label>
              <select id="auth-f-source" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                {SOURCES.map((k) => <option key={k} value={k}>{t(`authorities.source.${k}`)}</option>)}
              </select>
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="auth-f-form">{t('authorities.preferredForm')}</label>
            <input id="auth-f-form" value={form.preferredForm}
              onChange={(e) => setForm({ ...form, preferredForm: e.target.value })}
              placeholder={t('authorities.preferredFormPh')} />
            <p className="muted small">{t('authorities.preferredFormHelp')}</p>
          </div>

          <div className="form-row">
            <div>
              <label htmlFor="auth-f-rom">{t('authorities.romanized')}</label>
              <input id="auth-f-rom" value={form.preferredFormRomanized}
                onChange={(e) => setForm({ ...form, preferredFormRomanized: e.target.value })} />
            </div>
            <div>
              <label htmlFor="auth-f-dates">{t('authorities.dates')}</label>
              <input id="auth-f-dates" value={form.dates}
                onChange={(e) => setForm({ ...form, dates: e.target.value })}
                placeholder={t('authorities.datesPh')} />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="auth-f-variants">{t('authorities.variants')}</label>
            <textarea id="auth-f-variants" rows={4} value={form.variantsText}
              onChange={(e) => setForm({ ...form, variantsText: e.target.value })}
              placeholder={t('authorities.variantsPh')} />
            <p className="muted small">{t('authorities.variantsHelp')}</p>
          </div>

          <div className="form-row">
            <div>
              <label htmlFor="auth-f-viaf">VIAF</label>
              <input id="auth-f-viaf" value={form.viafId} onChange={(e) => setForm({ ...form, viafId: e.target.value })} />
            </div>
            <div>
              <label htmlFor="auth-f-lc">LC</label>
              <input id="auth-f-lc" value={form.lcId} onChange={(e) => setForm({ ...form, lcId: e.target.value })} />
            </div>
            <div>
              <label htmlFor="auth-f-isni">ISNI</label>
              <input id="auth-f-isni" value={form.isni} onChange={(e) => setForm({ ...form, isni: e.target.value })} />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="auth-f-notes">{t('authorities.notes')}</label>
            <input id="auth-f-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>

          {detail && detail.usedBy.length > 0 && (
            <div className="form-field">
              <p className="muted small" style={{ fontWeight: 600 }}>
                {t('authorities.usedByList', { n: fmt(detail.useCount) })}
              </p>
              <ul className="plain-list small">
                {detail.usedBy.slice(0, 12).map((b) => (
                  <li key={`${b.id}-${b.role}`}>{b.title} <span className="muted">· {t(`relator.${b.role}`)}</span></li>
                ))}
              </ul>
              {/* Editing keeps every one of these links, which is exactly why an
                  edit path had to exist: retiring and recreating loses them. */}
              <p className="muted small">{t('authorities.editKeepsLinks')}</p>
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

export { MARC_RELATORS };
