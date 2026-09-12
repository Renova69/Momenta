import React, { useEffect, useState, useCallback } from 'react';
import { WeddingEvent } from '../../types';
import { ingestApi, IngestKeyInfo } from '../../api/ingestApi';
import { i18n } from '../../i18n';
import {
  KeyRound,
  Plus,
  Trash2,
  Camera,
  FolderSync,
  Copy,
  Check,
  Link2,
} from 'lucide-react';

interface PhotographerIngestPanelProps {
  event: WeddingEvent;
}

export const PhotographerIngestPanel: React.FC<PhotographerIngestPanelProps> = ({ event }) => {
  const [keys, setKeys] = useState<IngestKeyInfo[]>([]);
  const [label, setLabel] = useState(i18n.t('ingest.default_label'));
  const [newKey, setNewKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const ftpHost = typeof window !== 'undefined' ? window.location.hostname : '';
  const ftpPort = 2121; // default FTP_PORT (configurable server-side)
  const ingestEndpoint = `${origin}/api/ingest/${event.id}/photos`;
  // Fragment, not query string: fragments are never sent to a server, stay out
  // of access logs, and are stripped from Referer headers.
  const portalUrl = newKey ? `${origin}/e/${event.slug}/ingest#key=${newKey}` : '';

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await ingestApi.listKeys(event.id);
      setKeys(list);
    } catch (err) {
      setError((err instanceof Error ? err.message : '') || i18n.t('ingest.err_load'));
    } finally {
      setLoading(false);
    }
  }, [event.id]);

  useEffect(() => {
    if (event.id) refresh();
  }, [event.id, refresh]);

  const handleCreate = async () => {
    setError('');
    try {
      const created = await ingestApi.createKey(event.id, label);
      setNewKey(created.key || '');
      setCopied('');
      await refresh();
    } catch (err) {
      setError((err instanceof Error ? err.message : '') || i18n.t('ingest.err_create'));
    }
  };

  const handleRevoke = async (id: string) => {
    setError('');
    try {
      await ingestApi.revokeKey(id);
      await refresh();
    } catch (err) {
      setError((err instanceof Error ? err.message : '') || i18n.t('ingest.err_revoke'));
    }
  };

  const copy = (text: string, tag: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(tag);
    setTimeout(() => setCopied(''), 1500);
  };

  const activeKeys = keys.filter((k) => !k.revokedAt);

  return (
    <div className="space-y-6">
      {/* New key + portal link */}
      <div className="bg-noir-800/90 rounded-3xl p-6 border border-gold-400/20 space-y-4">
        <h4 className="font-serif text-lg font-bold text-cream-100 flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-gold-400" />
          <span>{i18n.t('ingest.key_heading')}</span>
        </h4>
        <p className="text-xs text-cream-300/80">
          {i18n.t('ingest.key_intro')}
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="flex-1 px-3 py-2.5 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
            placeholder={i18n.t('ingest.key_label_placeholder')}
          />
          <button
            onClick={handleCreate}
            className="px-5 py-2.5 rounded-xl bg-gold-400 text-noir-900 font-bold text-xs flex items-center justify-center gap-2 hover:brightness-110"
          >
            <Plus className="w-4 h-4" /> {i18n.t('ingest.generate_key')}
          </button>
        </div>

        {newKey && (
          <div className="rounded-2xl bg-noir-950 border border-gold-400/30 p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-gold-300 font-semibold">{i18n.t('ingest.copy_once')}</span>
              <button onClick={() => copy(newKey, 'key')} className="text-xs text-cream-200 hover:text-white flex items-center gap-1">
                {copied === 'key' ? <Check className="w-3.5 h-3.5 text-sage-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied === 'key' ? i18n.t('ingest.copied') : i18n.t('ingest.copy')}
              </button>
            </div>
            <code className="block font-mono text-xs text-gold-200 break-all bg-black/40 rounded-lg p-3">{newKey}</code>

            {portalUrl && (
              <button
                onClick={() => copy(portalUrl, 'url')}
                className="w-full flex items-center gap-2 text-left text-xs text-cream-200 hover:text-white bg-black/30 rounded-lg p-2.5"
              >
                <Link2 className="w-3.5 h-3.5 text-gold-400 shrink-0" />
                <span className="break-all">{portalUrl}</span>
                {copied === 'url' ? <Check className="w-3.5 h-3.5 text-sage-400 shrink-0 ml-auto" /> : <Copy className="w-3.5 h-3.5 shrink-0 ml-auto" />}
              </button>
            )}
          </div>
        )}

        {error && <p className="text-xs text-rosewood-300 bg-rosewood-900/40 border border-rosewood-400/30 rounded-xl p-3">{error}</p>}
      </div>

      {/* Existing keys */}
      <div className="bg-noir-800/90 rounded-3xl p-6 border border-cream-400/10 space-y-3">
        <h4 className="font-serif text-base font-bold text-cream-100 flex items-center gap-2">
          <Camera className="w-4 h-4 text-gold-400" />{' '}
          {i18n.t('ingest.active_keys', { count: activeKeys.length })}
        </h4>
        {loading ? (
          <p className="text-xs text-cream-400/70">{i18n.t('ingest.loading')}</p>
        ) : activeKeys.length === 0 ? (
          <p className="text-xs text-cream-400/70">{i18n.t('ingest.no_keys')}</p>
        ) : (
          activeKeys.map((k) => (
            <div key={k.id} className="flex items-center justify-between p-3 rounded-xl bg-noir-900 border border-cream-400/10">
              <div>
                <div className="text-xs font-semibold text-cream-100">{k.label}</div>
                <div className="text-[10px] text-cream-400/60 font-mono">
                  {k.masked || '\u2026'} &middot; {i18n.t('ingest.created_on')}{' '}
                  {new Date(k.createdAt).toLocaleDateString()}
                  {k.lastUsedAt
                    ? ` \u00b7 ${i18n.t('ingest.last_used')} ${new Date(k.lastUsedAt).toLocaleDateString()}`
                    : ''}
                </div>
              </div>
              <button onClick={() => handleRevoke(k.id)} className="p-2 rounded-lg text-rosewood-300 hover:bg-rosewood-900/40">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Integration instructions */}
      <div className="bg-noir-800/90 rounded-3xl p-6 border border-cream-400/10 space-y-4">
        <h4 className="font-serif text-base font-bold text-cream-100 flex items-center gap-2">
          <FolderSync className="w-4 h-4 text-gold-400" /> {i18n.t('ingest.recipes')}
        </h4>

        <div className="space-y-3 text-xs text-cream-300/85">
          <div>
            <span className="font-bold text-cream-100">{i18n.t('ingest.rest_endpoint')}</span>
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 block font-mono text-[11px] text-gold-200 bg-black/40 rounded-lg p-2 break-all">{ingestEndpoint}</code>
              <button onClick={() => copy(ingestEndpoint, 'ep')} className="p-2 rounded-lg text-cream-200 hover:bg-noir-900">
                {copied === 'ep' ? <Check className="w-3.5 h-3.5 text-sage-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
            <p className="text-cream-400/70 mt-1">
              {i18n.t('ingest.rest_hint_before')} <code className="font-mono">file</code>{' '}
              {i18n.t('ingest.rest_hint_middle')}{' '}
              <code className="font-mono">X-Ingest-Key: wmi_&hellip;</code>.{' '}
              {i18n.t('ingest.rest_hint_after')} <code className="font-mono">photographerName</code>,{' '}
              <code className="font-mono">caption</code>.
            </p>
          </div>

          <div>
            <span className="font-bold text-cream-100">{i18n.t('ingest.hotfolder_title')}</span>
            <p className="text-cream-400/70 mt-1">
              {i18n.t('ingest.hotfolder_hint')}
            </p>
            <code className="block font-mono text-[11px] text-gold-200 bg-black/40 rounded-lg p-2 mt-1 break-all">
              {`INGEST_WATCH_DIR=/path/to/exports INGEST_API_URL=${origin} INGEST_EVENT_ID=${event.id} INGEST_API_KEY=wmi_… npm run ingest:watch`}
            </code>
          </div>

          <div>
            <span className="font-bold text-cream-100">{i18n.t('ingest.ftp_title')}</span>
            <p className="text-cream-400/70 mt-1">
              {i18n.t('ingest.ftp_hint')}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2 text-[11px]">
              <div className="bg-black/30 rounded-lg p-2.5">
                <span className="text-cream-400/60">{i18n.t('ingest.ftp_server')}</span><br />
                <code className="font-mono text-gold-200 break-all">{ftpHost}</code>
              </div>
              <div className="bg-black/30 rounded-lg p-2.5">
                <span className="text-cream-400/60">{i18n.t('ingest.ftp_port')}</span><br />
                <code className="font-mono text-gold-200">{ftpPort}</code>
              </div>
              <div className="bg-black/30 rounded-lg p-2.5">
                <span className="text-cream-400/60">{i18n.t('ingest.ftp_username')}</span><br />
                <code className="font-mono text-gold-200 break-all">{event.id}</code>
              </div>
              <div className="bg-black/30 rounded-lg p-2.5">
                <span className="text-cream-400/60">{i18n.t('ingest.ftp_password')}</span><br />
                <code className="font-mono text-gold-200 break-all">{newKey || i18n.t('ingest.generate_first')}</code>
              </div>
            </div>
            <p className="text-cream-400/60 mt-2">
              {i18n.t('ingest.ftp_requires_1')} <code className="font-mono">FTP_ENABLED=true</code>{' '}
              {i18n.t('ingest.ftp_requires_2')} <code className="font-mono">FTP_PASV_URL</code>{' '}
              {i18n.t('ingest.ftp_requires_3')} <code className="font-mono">FTP_TLS_CERT</code>{' '}
              {i18n.t('ingest.ftp_requires_4')} <code className="font-mono">FTP_TLS_KEY</code>{' '}
              {i18n.t('ingest.ftp_requires_5')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
