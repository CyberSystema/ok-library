// Rooms — the physical spaces the shelves are in.
//
// `rooms.write` and `rooms.delete` have sat in the permission matrix since
// Phase A governing nothing reachable: the table, the endpoints and the
// permissions all existed, and there was no screen. The catalogue currently has
// ZERO rooms and all 12,528 books unassigned, so this is less "manage rooms"
// than "create the first one".
//
// A room code is a foreign key target for every book in it, which is why the
// rename here carries its books and the delete refuses while any remain — see
// the endpoints for how that is done without tripping an immediate constraint.
import React, { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api';
import { useT } from '../i18n';
import { useConfirm, useToast } from '../ui';

type Room = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  bookCount: number;
};

const BLANK = { code: '', name: '', description: '' };

export function RoomsCard({ canWrite, canDelete, onChanged }: {
  canWrite: boolean;
  canDelete: boolean;
  /** Rooms appear in book filters and the dashboard, so the app refetches after a change. */
  onChanged?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ items: Room[] }>('/api/rooms');
      setRooms(res.items ?? []);
      setLoaded(true);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  function startCreate() { setEditingId('new'); setForm(BLANK); }
  function startEdit(r: Room) {
    setEditingId(r.id);
    setForm({ code: r.code, name: r.name, description: r.description ?? '' });
  }
  function cancel() { setEditingId(null); setForm(BLANK); }

  async function save() {
    if (!form.code.trim() || !form.name.trim()) {
      toast.push('error', t('rooms.needCodeAndName'));
      return;
    }
    const existing = rooms.find((r) => r.id === editingId);
    // Renaming the code moves every book in the room with it. Say how many
    // before it happens — the operator cannot see that from the form.
    if (existing && existing.code !== form.code.trim() && existing.bookCount > 0) {
      const ok = await confirm({
        title: t('rooms.renameTitle'),
        body: t('rooms.renameBody', { n: existing.bookCount, from: existing.code, to: form.code.trim() }),
        confirmLabel: t('rooms.renameConfirm')
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const body = JSON.stringify({
        code: form.code.trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        mapMetadata: {}
      });
      if (editingId === 'new') await apiRequest('/api/rooms', { method: 'POST', body });
      else await apiRequest(`/api/rooms/${editingId}`, { method: 'PUT', body });
      toast.push('success', t('rooms.saved'));
      cancel();
      await load();
      onChanged?.();
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Room) {
    const ok = await confirm({
      title: t('rooms.deleteTitle'),
      body: t('rooms.deleteBody', { code: r.code }),
      confirmLabel: t('common.delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await apiRequest(`/api/rooms/${r.id}`, { method: 'DELETE' });
      toast.push('success', t('rooms.deleted'));
      await load();
      onChanged?.();
    } catch (e) {
      // The endpoint refuses with a count while books remain, so this message is
      // actionable rather than a bare failure.
      toast.push('error', (e as Error).message);
    }
  }

  return (
    <div className="card">
      <h3>🚪 {t('rooms.heading')}</h3>
      <p className="muted small" style={{ marginBottom: '1rem' }}>{t('rooms.intro')}</p>

      {!loaded ? (
        <p className="muted small">{t('common.loading')}</p>
      ) : rooms.length === 0 ? (
        <div className="empty-state" style={{ padding: '1rem 0' }}>
          <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>🚪</p>
          <p style={{ fontWeight: 600 }}>{t('rooms.noneYet')}</p>
          <p className="muted small">{t('rooms.noneYetBody')}</p>
        </div>
      ) : (
        <ul className="cf-list">
          {rooms.map((r) => (
            <li key={r.id} className="cf-row">
              <div className="cf-row-text">
                <strong>{r.code}</strong>
                <span className="muted small"> · {r.name}</span>
                <span className="muted small" style={{ display: 'block' }}>
                  {t('rooms.bookCount', { n: r.bookCount })}
                  {r.description ? ` · ${r.description}` : ''}
                </span>
              </div>
              <div className="button-group">
                {canWrite && (
                  <button className="secondary small" onClick={() => startEdit(r)}>{t('common.edit')}</button>
                )}
                {canDelete && (
                  <button className="secondary small" onClick={() => void remove(r)}>{t('common.delete')}</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canWrite && (editingId ? (
        <div className="room-form">
          <div className="form-row">
            <div>
              <label htmlFor="room-code">{t('rooms.code')}</label>
              <input
                id="room-code"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder={t('rooms.codePh')}
              />
            </div>
            <div>
              <label htmlFor="room-name">{t('rooms.name')}</label>
              <input
                id="room-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="room-desc">{t('rooms.description')}</label>
            <input
              id="room-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="button-group">
            <button className="primary small" disabled={busy} onClick={() => void save()}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
            <button className="secondary small" onClick={cancel}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : (
        <button className="secondary small" style={{ marginTop: '0.75rem' }} onClick={startCreate}>
          {t('rooms.add')}
        </button>
      ))}
    </div>
  );
}
