// MARC 21 exchange — the door between this catalogue and every other library.
//
// Phase C built the whole of it: MARCXML and MARC-in-JSON export, MARCXML
// ingest with a dry run, SRU and OAI-PMH. None of it had a control. A librarian
// asked for "your records in MARC" by another library had no way to produce
// them, and a MARC file sent by one had no way in.
//
// Two directions, and they are not symmetrical:
//   · OUT is a download of the whole catalogue. It is the format you hand to a
//     union catalogue, a national library, or a system you are migrating to.
//   · IN is matched on ISBN ALONE, so a record with no ISBN always arrives as a
//     new one — which matters here, where only 602 of 12,675 records have one.
//     The dry run is the point: it reports exactly what WOULD happen and writes
//     nothing, so the new-versus-updated split tells you whether the matching is
//     working before anything is committed.
//
// The harvesting endpoints are shown rather than called: SRU and OAI-PMH exist
// so that a peer library's software fetches from us on its own schedule. What
// they need is the URL, which is why this screen's job there is to hand it over.
import React, { useState } from 'react';
import { API_BASE, apiBlob, apiRequest, joinApiUrl } from '../api';
import { useT } from '../i18n';
import { HelpLink } from '../handbook/context';
import { useToast } from '../ui';

type ImportReport = {
  records: number;
  created: number;
  updated: number;
  skipped: number;
  dryRun: boolean;
  problems: string[];
};

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function MarcIoCard({ canExport, canImport }: { canExport: boolean; canImport: boolean }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [report, setReport] = useState<ImportReport | null>(null);

  // The endpoints a peer library is given. Absolute, because the whole point is
  // that it is pasted into someone else's software.
  const base = API_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
  const sruUrl = `${base}/api/sru?version=1.2&operation=searchRetrieve&query=`;
  const oaiUrl = `${base}/api/oai?verb=ListRecords&metadataPrefix=marcxml`;

  async function exportAs(format: 'marcxml' | 'json') {
    setBusy(format);
    try {
      const blob = await apiBlob(`/api/export/books.marcxml${format === 'json' ? '?format=json' : ''}`);
      download(blob, format === 'json' ? 'books.marc.json' : 'books.marcxml');
      toast.push('success', t('marc.exported'));
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.push('success', t('marc.copied'));
    } catch {
      // Clipboard access is denied in plenty of contexts and the URL is on
      // screen anyway, so this is a nudge, not a failure.
      toast.push('error', t('marc.copyFailed'));
    }
  }

  async function runImport(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy('import');
    setReport(null);
    try {
      const xml = await file.text();
      const res = await apiRequest<ImportReport>(
        `/api/import/marcxml${dryRun ? '?dryRun=1' : ''}`,
        { method: 'POST', body: xml, headers: { 'Content-Type': 'application/xml' } }
      );
      setReport(res);
      toast.push(
        res.skipped > 0 ? 'error' : 'success',
        dryRun
          ? t('marc.dryRunDone', { n: res.records })
          : t('marc.importDone', { created: res.created, updated: res.updated })
      );
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h3>
        🌍 {t('marc.heading')}
        <HelpLink anchor="sending-records" label={t('handbook.helpAbout', { field: t('marc.heading') })} />
      </h3>
      <p className="muted small" style={{ marginBottom: '1.25rem' }}>{t('marc.intro')}</p>

      {canExport && (
        <>
          <h4 className="subhead">{t('marc.exportHeading')}</h4>
          <p className="muted small">{t('marc.exportIntro')}</p>
          <div className="button-group">
            <button className="secondary" disabled={busy !== null} onClick={() => void exportAs('marcxml')}>
              {busy === 'marcxml' ? t('common.working') : t('marc.downloadXml')}
            </button>
            <button className="secondary" disabled={busy !== null} onClick={() => void exportAs('json')}>
              {busy === 'json' ? t('common.working') : t('marc.downloadJson')}
            </button>
          </div>
        </>
      )}

      {canImport && (
        <>
          <h4 className="subhead">{t('marc.importHeading')}</h4>
          <p className="muted small">
            {t('marc.importIntro')}
            <HelpLink anchor="dry-run" label={t('handbook.helpAbout', { field: t('marc.importHeading') })} />
          </p>
          <form onSubmit={runImport} className="simple-form">
            <div className="import-dropzone">
              <p style={{ fontSize: '2.25rem', marginBottom: '0.5rem' }}>🌍</p>
              <p id="marc-import-label" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{t('marc.choose')}</p>
              <p className="muted small" style={{ marginBottom: '1rem' }}>{t('marc.supports')}</p>
              {/* Named, because the paragraph above is only visually a label: this
                  input and the spreadsheet importer on the same tab both announced
                  as a bare "Choose File", with nothing to tell them apart. */}
              <input
                type="file"
                accept=".xml,.marcxml,text/xml,application/xml"
                aria-labelledby="marc-import-label"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); }}
                style={{ width: 'auto', display: 'block', margin: '0 auto' }}
              />
            </div>
            {file && <p className="muted small">{t('import.selected')} <strong>{file.name}</strong></p>}
            <label className="checkbox-label">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              {t('marc.dryRun')}
            </label>
            <button type="submit" className="primary" disabled={!file || busy !== null}>
              {busy === 'import' ? t('common.working') : dryRun ? t('marc.testBtn') : t('marc.importBtn')}
            </button>
          </form>

          {report && (
            <div className="import-report" role="status">
              <p style={{ fontWeight: 600 }}>
                {report.dryRun ? t('marc.reportDry') : t('marc.reportLive')}
              </p>
              <ul className="plain-list">
                <li>{t('marc.reportRecords', { n: report.records })}</li>
                <li>{t('marc.reportCreated', { n: report.created })}</li>
                <li>{t('marc.reportUpdated', { n: report.updated })}</li>
                <li>{t('marc.reportSkipped', { n: report.skipped })}</li>
              </ul>
              {report.problems.length > 0 && (
                <>
                  <p className="muted small" style={{ marginTop: '0.5rem' }}>{t('marc.reportProblems')}</p>
                  <ul className="plain-list small">
                    {report.problems.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}

      <h4 className="subhead">{t('marc.harvestHeading')}</h4>
      <p className="muted small">
        {t('marc.harvestIntro')}
        <HelpLink anchor="harvesting" label={t('handbook.helpAbout', { field: t('marc.harvestHeading') })} />
      </p>
      <ul className="plain-list">
        <li className="endpoint-row">
          <div>
            <strong>SRU</strong>
            <code className="endpoint">{sruUrl}</code>
          </div>
          <button className="secondary small" onClick={() => void copy(sruUrl)}>{t('marc.copy')}</button>
        </li>
        <li className="endpoint-row">
          <div>
            <strong>OAI-PMH</strong>
            <code className="endpoint">{oaiUrl}</code>
          </div>
          <button className="secondary small" onClick={() => void copy(oaiUrl)}>{t('marc.copy')}</button>
        </li>
      </ul>
      <p className="muted small" style={{ marginTop: '0.5rem' }}>
        {t('marc.harvestNote')}{' '}
        <a href={joinApiUrl('/api/oai?verb=Identify')} target="_blank" rel="noreferrer">
          {t('marc.harvestIdentify')}
        </a>
      </p>
    </div>
  );
}
