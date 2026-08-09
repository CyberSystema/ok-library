// Who this library is, and whether the world may read its catalogue.
//
// `library_settings` has existed since migration 0026 with `PUT
// /api/library-settings` accepting all six keys, and no screen. The
// consequences were quiet but real: MARC 852 $a and the OAI-PMH repository
// identifier both need the ISIL, so every record this library exported carried
// no institutional identity; and `publicSharing` — the ONLY thing keeping SRU
// and OAI-PMH shut — could not be switched on by anyone without an HTTP client.
//
// The first file under screens/. It fetches and saves for itself and takes no
// props from App(), which is what the seam in Step 0 was for. It must never
// import from main.tsx.
import React, { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api';
import { useT } from '../i18n';
import { useConfirm, useToast } from '../ui';

/** The six keys `PUT /api/library-settings` will accept. Anything else is dropped server-side. */
type Settings = {
  isil: string;
  libraryName: string;
  libraryPlace: string;
  catalogueLanguage: string;
  adminEmail: string;
  publicSharing: string;
};

const EMPTY: Settings = {
  isil: '', libraryName: '', libraryPlace: '', catalogueLanguage: '', adminEmail: '', publicSharing: ''
};

export function LibraryIdentityCard({ canEdit }: { canEdit: boolean }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<Settings>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ settings: Record<string, string | null> }>('/api/library-settings');
      const s = res.settings ?? {};
      setForm({
        isil: s.isil ?? '',
        libraryName: s.libraryName ?? '',
        libraryPlace: s.libraryPlace ?? '',
        catalogueLanguage: s.catalogueLanguage ?? '',
        adminEmail: s.adminEmail ?? '',
        publicSharing: (s.publicSharing ?? '').toLowerCase()
      });
      setLoaded(true);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const sharingOn = form.publicSharing === 'on';

  async function save(next: Partial<Settings>) {
    setSaving(true);
    try {
      // Send only what changed. The endpoint upserts per key, so a partial body
      // cannot blank a value the form has not touched.
      await apiRequest('/api/library-settings', {
        method: 'PUT',
        body: JSON.stringify(Object.fromEntries(
          Object.entries({ ...form, ...next }).map(([k, v]) => [k, String(v).trim() || null])
        ))
      });
      setForm((f) => ({ ...f, ...next }));
      toast.push('success', t('identity.saved'));
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleSharing() {
    if (!sharingOn) {
      // Turning this ON publishes every bibliographic record to anyone who asks,
      // and a harvester that has cached them cannot be made to forget. That is a
      // decision, not a setting, so it gets a confirm and names what leaves.
      const ok = await confirm({
        title: t('identity.shareOnTitle'),
        body: t('identity.shareOnBody'),
        confirmLabel: t('identity.shareOnConfirm'),
        danger: true
      });
      if (!ok) return;
      if (!form.isil.trim() || !form.libraryName.trim()) {
        // OAI-PMH identifies a repository by its ISIL and SRU's explain response
        // carries the library's name. Publishing anonymously is not useful to a
        // harvester and cannot be corrected retroactively in their caches.
        toast.push('error', t('identity.shareNeedsIsil'));
        return;
      }
    }
    await save({ publicSharing: sharingOn ? 'off' : 'on' });
  }

  if (!loaded) {
    return (
      <div className="card">
        <h3>{t('identity.heading')}</h3>
        <p className="muted small">{t('common.loading')}</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h3>{t('identity.heading')}</h3>
      <p className="muted small" style={{ marginBottom: '1rem' }}>{t('identity.intro')}</p>

      <div className="form-row">
        <div>
          <label htmlFor="idn-isil">{t('identity.isil')}</label>
          <input
            id="idn-isil"
            value={form.isil}
            disabled={!canEdit}
            onChange={(e) => setForm({ ...form, isil: e.target.value })}
            placeholder={t('identity.isilPh')}
            aria-describedby="idn-isil-hint"
          />
          <p id="idn-isil-hint" className="muted small" style={{ marginTop: '0.35rem' }}>
            {t('identity.isilHint')}
          </p>
        </div>
        <div>
          <label htmlFor="idn-name">{t('identity.name')}</label>
          <input
            id="idn-name"
            value={form.libraryName}
            disabled={!canEdit}
            onChange={(e) => setForm({ ...form, libraryName: e.target.value })}
          />
        </div>
      </div>

      <div className="form-row">
        <div>
          <label htmlFor="idn-place">{t('identity.place')}</label>
          <input
            id="idn-place"
            value={form.libraryPlace}
            disabled={!canEdit}
            onChange={(e) => setForm({ ...form, libraryPlace: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="idn-cataloguelang">{t('identity.catalogueLanguage')}</label>
          <input
            id="idn-cataloguelang"
            value={form.catalogueLanguage}
            disabled={!canEdit}
            onChange={(e) => setForm({ ...form, catalogueLanguage: e.target.value })}
            placeholder="gre"
            aria-describedby="idn-lang-hint"
          />
          <p id="idn-lang-hint" className="muted small" style={{ marginTop: '0.35rem' }}>
            {t('identity.catalogueLanguageHint')}
          </p>
        </div>
      </div>

      {canEdit && (
        <div className="button-group" style={{ marginTop: '0.5rem' }}>
          <button className="primary small" disabled={saving} onClick={() => void save({})}>
            {saving ? t('common.saving') : t('identity.save')}
          </button>
        </div>
      )}

      {/* Public sharing. Deliberately visually separated and last: it is the one
          control on this card whose effect leaves the building. */}
      <div className="sharing-block">
        <div className="sharing-state">
          <span className={`badge ${sharingOn ? 'ready' : ''}`}>
            {sharingOn ? t('identity.sharingOn') : t('identity.sharingOff')}
          </span>
          <strong>{t('identity.sharingHeading')}</strong>
        </div>
        <p className="muted small">{sharingOn ? t('identity.sharingOnBody') : t('identity.sharingOffBody')}</p>
        {sharingOn && (
          <ul className="muted small sharing-endpoints">
            <li><code>/api/sru?operation=explain</code></li>
            <li><code>/api/oai?verb=Identify</code></li>
          </ul>
        )}
        {canEdit && (
          <button
            className={sharingOn ? 'secondary small' : 'primary small'}
            disabled={saving}
            onClick={() => void toggleSharing()}
          >
            {sharingOn ? t('identity.stopSharing') : t('identity.startSharing')}
          </button>
        )}
      </div>
    </div>
  );
}
