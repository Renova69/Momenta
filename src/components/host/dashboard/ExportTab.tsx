/**
 * Archive and export: the full-resolution ZIP, the JSON backup, and the
 * demo-data reset.
 *
 * Split out of `HostDashboard.tsx` (986 lines, past the project's 800-line
 * ceiling). The markup is unchanged; it reads its state from the dashboard
 * context instead of closing over the parent's scope. The tier gate that
 * decides whether this renders at all stays in `HostDashboard`.
 */

import React from 'react';
import { Download, Trash2 } from 'lucide-react';
import { i18n } from '../../../i18n';
import { useHostDashboard } from './context';

export const ExportTab: React.FC = () => {
  const {
    audioEntries, exportError, handleDownloadZip, handleExportAll, isExportingZip, onResetData, photos,
  } = useHostDashboard();

  return (
    <div className="bg-noir-800/90 rounded-3xl p-6 sm:p-8 border border-cream-400/10 space-y-6">
      <div>
        <h4 className="font-serif text-xl font-bold text-cream-100 mb-1">
          {i18n.t('host.export_zip')}
        </h4>
        <p className="text-xs text-cream-300/80">
          {i18n.t('ui.host_dashboard.19')}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <button
          onClick={handleDownloadZip}
          disabled={isExportingZip}
          className="p-5 rounded-2xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold shadow-glow hover:brightness-110 flex items-center justify-between transition-all disabled:opacity-60"
        >
          <div className="text-left">
            <div className="text-sm">{isExportingZip ? i18n.t('host.zip_downloading') : i18n.t('host.zip_download')}</div>
            <div className="text-xs font-normal opacity-85">
              {i18n.t('host.archive_contents', {
                photos: photos.length,
                audio: audioEntries.length,
              })}
            </div>
          </div>
          <Download className="w-6 h-6" />
        </button>

        {exportError && (
          <div className="rounded-2xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-xs text-red-200">
            {exportError}
          </div>
        )}

        <button
          onClick={handleExportAll}
          className="p-5 rounded-2xl bg-noir-900 border border-cream-400/20 text-cream-100 hover:border-gold-400/50 flex items-center justify-between transition-all"
        >
          <div className="text-left">
            <div className="text-sm font-bold">{i18n.t('ui.host_dashboard.20')}</div>
            <div className="text-xs text-cream-400/70">{i18n.t('ui.host_dashboard.21')}</div>
          </div>
          <Download className="w-6 h-6 text-gold-400" />
        </button>
      </div>

      {/* Reset Demo Data Danger Zone */}
      <div className="pt-6 border-t border-cream-400/10 flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-rosewood-400 block">{i18n.t('ui.host_dashboard.22')}</span>
          <span className="text-[11px] text-cream-400/60">{i18n.t('ui.host_dashboard.23')}</span>
        </div>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(i18n.t('host.reset_confirm'))) {
              onResetData();
            }
          }}
          className="px-4 py-2 rounded-xl bg-rosewood-900/40 border border-rosewood-400/30 text-rosewood-300 text-xs hover:bg-rosewood-900 transition-colors flex items-center gap-1.5"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>{i18n.t('ui.host_dashboard.24')}</span>
        </button>
      </div>
    </div>
  );
};
