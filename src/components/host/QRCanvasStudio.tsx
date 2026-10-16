import React, { useId, useState, useEffect } from 'react';
import { WeddingEvent, QRCanvasConfig, CanvasSize, FrameStyle, QRCenterIcon } from '../../types';
import { QRCodeSVG } from 'qrcode.react';
import { i18n } from '../../i18n';
import { centerIconDataUri } from '../../utils/qrCenterIcon';
import { formatEuDateLong } from '../../utils/date';
import { ENV } from '../../config/env';
import {
  triggerVectorPrint,
  exportPosterPdf,
  exportPosterPng,
  getPrintSpec,
} from '../../services/pdfPrintService';
import {
  Printer,
  QrCode,
  Palette,
  Heart,
  Flower2,
  FileDown,
  ImageDown,
  Loader2,
  Gem,
  Camera,
  Sparkles,
  Ban,
} from 'lucide-react';

interface QRCanvasStudioProps {
  event: WeddingEvent;
  config: QRCanvasConfig;
  onUpdateConfig: (updates: Partial<QRCanvasConfig>) => void;
}

const CENTER_ICON_OPTIONS: { id: QRCenterIcon; Icon: React.ComponentType<{ className?: string }>; labelKey: string }[] = [
  { id: 'heart', Icon: Heart, labelKey: 'canvas.icon_heart' },
  { id: 'rings', Icon: Gem, labelKey: 'canvas.icon_rings' },
  { id: 'camera', Icon: Camera, labelKey: 'canvas.icon_camera' },
  { id: 'sparkle', Icon: Sparkles, labelKey: 'canvas.icon_sparkle' },
  { id: 'none', Icon: Ban, labelKey: 'canvas.icon_none' },
];

export const QRCanvasStudio: React.FC<QRCanvasStudioProps> = ({
  event,
  config,
  onUpdateConfig,
}) => {
  // One id per field, so each visible label points at the control it names.
  const fieldIds = useId();
  const [activeSize, setActiveSize] = useState<CanvasSize>(config.canvasSize || 'A2');
  const [activeFrame, setActiveFrame] = useState<FrameStyle>(config.frameStyle || 'minimal_gold');
  const [headline, setHeadline] = useState(config.headline || i18n.t('canvas.headline_default'));
  const [subtext, setSubtext] = useState(
    config.subtext || i18n.t('canvas.subtext_default')
  );
  const [accentColor, setAccentColor] = useState(config.accentColor || '#D4AF37');
  const [centerIcon, setCenterIcon] = useState<QRCenterIcon>(config.centerIcon || 'heart');
  const [qrTargetMode, setQrTargetMode] = useState<'wifi' | 'cloud'>('wifi');

  useEffect(() => {
    if (config.frameStyle) setActiveFrame(config.frameStyle);
    if (config.canvasSize) setActiveSize(config.canvasSize);
    if (config.headline) setHeadline(config.headline);
    if (config.subtext) setSubtext(config.subtext);
    if (config.accentColor) setAccentColor(config.accentColor);
    if (config.centerIcon) setCenterIcon(config.centerIcon);
  }, [config]);

  // Compute live event URL: current host origin for testing or Public Domain for real wedding printing
  // N-118 — the public address is configured (VITE_PUBLIC_APP_URL), not the
  // hardcoded https://wedmoments.app no deployment had; without one, or when
  // it is this page's own, there is nothing to choose between.
  const origin = typeof window !== 'undefined' ? window.location.origin : ENV.PUBLIC_APP_URL;
  const publicDomain = ENV.PUBLIC_APP_URL && ENV.PUBLIC_APP_URL !== origin ? ENV.PUBLIC_APP_URL : null;
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const currentUrl = `${qrTargetMode === 'cloud' && publicDomain ? publicDomain : origin}/e/${event.slug}`;

  const [exporting, setExporting] = useState<'pdf' | 'png' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const liveConfig: QRCanvasConfig = {
    ...config,
    canvasSize: activeSize,
    frameStyle: activeFrame,
    headline,
    subtext,
    accentColor,
  };

  const printSpec = getPrintSpec(activeSize);

  const handlePrint = () => {
    setExportError(null);
    try {
      triggerVectorPrint({ event, canvasConfig: liveConfig });
    } catch (err) {
      setExportError(err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err));
    }
  };

  const runExport = async (kind: 'pdf' | 'png') => {
    setExportError(null);
    setExporting(kind);
    try {
      const args = { event, canvasConfig: liveConfig };
      await (kind === 'pdf' ? exportPosterPdf(args) : exportPosterPng(args));
    } catch (err) {
      setExportError(err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Studio Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-noir-800/80 p-5 rounded-3xl border border-cream-400/10">
        <div>
          <h2 className="font-serif text-xl font-bold text-cream-100 flex items-center gap-2">
            <QrCode className="w-5 h-5 text-gold-400" />
            <span>{i18n.t('canvas.print_title')}</span>
          </h2>
          <p className="text-xs text-cream-400/80">
            {i18n.t('canvas.print_subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => runExport('pdf')}
            disabled={exporting !== null}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-gold-400 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110 active:scale-95 transition-all disabled:opacity-60 disabled:cursor-wait"
          >
            {exporting === 'pdf' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FileDown className="w-4 h-4" />
            )}
            <span>
              {exporting === 'pdf'
                ? i18n.t('canvas.export_working')
                : `${i18n.t('canvas.export_pdf')} · ${printSpec.widthMm}×${printSpec.heightMm} mm`}
            </span>
          </button>

          <button
            onClick={() => runExport('png')}
            disabled={exporting !== null}
            className="flex items-center gap-2 px-4 py-2.5 rounded-full border border-gold-400/40 text-gold-300 font-bold text-xs hover:bg-gold-400/10 active:scale-95 transition-all disabled:opacity-60 disabled:cursor-wait"
          >
            {exporting === 'png' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ImageDown className="w-4 h-4" />
            )}
            <span>
              {exporting === 'png'
                ? i18n.t('canvas.export_working')
                : `${i18n.t('canvas.export_png')} · ${printSpec.widthPx300Dpi}px`}
            </span>
          </button>

          <button
            onClick={handlePrint}
            className="flex items-center gap-2 px-4 py-2.5 rounded-full border border-cream-400/20 text-cream-200 font-bold text-xs hover:bg-cream-400/10 active:scale-95 transition-all"
          >
            <Printer className="w-4 h-4" />
            <span>{i18n.t('canvas.print_btn')}</span>
          </button>
        </div>
      </div>

      {exportError && (
        <div className="rounded-2xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-xs text-red-200">
          {exportError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* LEFT COLUMN: Customizer Controls (5 cols) */}
        <div className="lg:col-span-5 space-y-6">
          
          {/* Format Size Selector */}
          <div className="bg-noir-800 rounded-2xl p-4 border border-cream-400/10 space-y-3">
            <label className="text-xs font-bold text-cream-200 uppercase tracking-wider block">
              {i18n.t('canvas.format_label')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'A2', label: i18n.t('canvas.format_a2'), desc: '420 × 594 mm' },
                { id: 'A3', label: i18n.t('canvas.format_a3'), desc: '297 × 420 mm' },
                { id: 'TABLE_CARD', label: i18n.t('canvas.format_table'), desc: i18n.t('canvas.format_folded_card') },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setActiveSize(f.id as CanvasSize);
                    onUpdateConfig({ canvasSize: f.id as CanvasSize });
                  }}
                  className={`p-2.5 rounded-xl border text-left transition-all ${
                    activeSize === f.id
                      ? 'bg-gold-400/15 border-gold-400 text-gold-300 font-semibold shadow-glow'
                      : 'bg-noir-900 border-cream-400/10 text-cream-400 hover:text-cream-200'
                  }`}
                >
                  <span className="text-xs block font-bold text-cream-100">{f.label}</span>
                  <span className="text-[10px] text-cream-400/70">{f.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Frame Style Selector */}
          <div className="bg-noir-800 rounded-2xl p-4 border border-cream-400/10 space-y-3">
            <label className="text-xs font-bold text-cream-200 uppercase tracking-wider block">
              {i18n.t('canvas.frame_label')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'minimal_gold', label: i18n.t('canvas.frame_gold'), desc: i18n.t('canvas.frame_minimal_gold_desc') },
                { id: 'floral_vintage', label: i18n.t('canvas.frame_floral'), desc: i18n.t('canvas.frame_floral_desc') },
                { id: 'boho_arch', label: i18n.t('canvas.frame_boho'), desc: i18n.t('canvas.frame_boho_desc') },
                { id: 'modern_clean', label: i18n.t('canvas.frame_noir'), desc: i18n.t('canvas.frame_modern_desc') },
                { id: 'double_border', label: i18n.t('canvas.frame_double_border'), desc: i18n.t('canvas.frame_double_border_desc') },
                { id: 'art_deco', label: i18n.t('canvas.frame_art_deco'), desc: i18n.t('canvas.frame_art_deco_desc') },
              ].map((st) => (
                <button
                  key={st.id}
                  onClick={() => {
                    setActiveFrame(st.id as FrameStyle);
                    onUpdateConfig({ frameStyle: st.id as FrameStyle });
                  }}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    activeFrame === st.id
                      ? 'bg-gold-400/20 border-gold-400 text-gold-300 font-semibold shadow-glow'
                      : 'bg-noir-900 border-cream-400/10 text-cream-400 hover:text-cream-200'
                  }`}
                >
                  <span className="text-xs block font-bold text-cream-100">{st.label}</span>
                  <span className="text-[10px] text-cream-400/70 block mt-0.5">{st.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* QR Center Icon */}
          <div className="bg-noir-800 rounded-2xl p-4 border border-cream-400/10 space-y-3">
            <label className="text-xs font-bold text-cream-200 uppercase tracking-wider block">
              {i18n.t('canvas.icon_label')}
            </label>
            <div className="grid grid-cols-5 gap-2">
              {CENTER_ICON_OPTIONS.map(({ id, Icon, labelKey }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setCenterIcon(id);
                    onUpdateConfig({ centerIcon: id });
                  }}
                  title={i18n.t(labelKey)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-xl border transition-all ${
                    centerIcon === id
                      ? 'bg-gold-400/20 border-gold-400 text-gold-300'
                      : 'bg-noir-900 border-cream-400/10 text-cream-400 hover:text-cream-200'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="text-[9px] truncate w-full text-center">{i18n.t(labelKey)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* QR Destination Link Mode */}
          {publicDomain && (
          <div className="bg-noir-800 rounded-2xl p-4 border border-cream-400/10 space-y-3">
            <label className="text-xs font-bold text-cream-200 uppercase tracking-wider block">
              {i18n.t('canvas.qr_dest_label')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setQrTargetMode('wifi')}
                className={`p-2.5 rounded-xl border text-left text-xs transition-all ${
                  qrTargetMode === 'wifi'
                    ? 'bg-gold-400/15 border-gold-400 text-gold-300 font-semibold shadow-glow'
                    : 'bg-noir-900 border-cream-400/10 text-cream-400 hover:text-cream-200'
                }`}
              >
                <span className="font-bold block text-cream-100">{i18n.t('ui.q_r_canvas_studio.1')}</span>
                <span className="text-[10px] text-cream-400/70">{hostOf(origin)}</span>
              </button>

              <button
                onClick={() => setQrTargetMode('cloud')}
                className={`p-2.5 rounded-xl border text-left text-xs transition-all ${
                  qrTargetMode === 'cloud'
                    ? 'bg-gold-400/15 border-gold-400 text-gold-300 font-semibold shadow-glow'
                    : 'bg-noir-900 border-cream-400/10 text-cream-400 hover:text-cream-200'
                }`}
              >
                <span className="font-bold block text-cream-100">{i18n.t('ui.q_r_canvas_studio.2')}</span>
                <span className="text-[10px] text-cream-400/70">{hostOf(publicDomain)}</span>
              </button>
            </div>
          </div>
          )}

          {/* Headline & Subtext Customization */}
          <div className="bg-noir-800 rounded-2xl p-4 border border-cream-400/10 space-y-3">
            <div>
              <label htmlFor={`${fieldIds}-1`} className="block text-xs font-semibold text-cream-300 mb-1">
                {i18n.t('ui.q_r_canvas_studio.3')}
              </label>
              <input
                id={`${fieldIds}-1`}
                type="text"
                value={headline}
                onChange={(e) => {
                  setHeadline(e.target.value);
                  onUpdateConfig({ headline: e.target.value });
                }}
                className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-hidden focus:border-gold-400"
              />
            </div>

            <div>
              <label htmlFor={`${fieldIds}-2`} className="block text-xs font-semibold text-cream-300 mb-1">
                {i18n.t('ui.q_r_canvas_studio.4')}
              </label>
              <textarea
                id={`${fieldIds}-2`}
                value={subtext}
                onChange={(e) => {
                  setSubtext(e.target.value);
                  onUpdateConfig({ subtext: e.target.value });
                }}
                rows={4}
                className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-hidden focus:border-gold-400 resize-y"
              />
            </div>

            <div>
              <label htmlFor={`${fieldIds}-3`} className="block text-xs font-semibold text-cream-300 mb-1 flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5 text-gold-400" />
                <span>{i18n.t('ui.q_r_canvas_studio.5')}</span>
              </label>
              <input
                id={`${fieldIds}-3`}
                type="color"
                value={accentColor}
                onChange={(e) => {
                  setAccentColor(e.target.value);
                  onUpdateConfig({ accentColor: e.target.value });
                }}
                className="w-full h-8 rounded-lg bg-noir-900 border border-cream-400/20 cursor-pointer p-0.5"
              />
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Live Print Preview Canvas (7 cols) */}
        <div className="lg:col-span-7 flex items-center justify-center p-4 bg-noir-950/60 rounded-3xl border border-cream-400/10">
          <div
            id="printable-canvas"
            className="w-full max-w-[440px] aspect-[1/1.414] bg-cream-100 text-[#1A1817] p-8 sm:p-10 rounded-2xl shadow-2xl flex flex-col justify-between items-center text-center relative overflow-hidden transition-all duration-300"
            style={{
              border: activeFrame === 'modern_clean' ? `6px solid ${accentColor}` : undefined,
            }}
          >
            {/* Decorative Minimalist Gold Frame */}
            {activeFrame === 'minimal_gold' && (
              <div
                className="absolute inset-4 sm:inset-5 pointer-events-none rounded-xs"
                style={{ border: `1.5px solid ${accentColor}` }}
              >
                <div
                  className="absolute inset-1 pointer-events-none"
                  style={{ border: `0.5px solid ${accentColor}80` }}
                />
              </div>
            )}

            {/* Decorative Floral Vintage Frame */}
            {activeFrame === 'floral_vintage' && (
              <div
                className="absolute inset-4 sm:inset-5 pointer-events-none rounded-lg"
                style={{ border: `2px dashed ${accentColor}` }}
              >
                <Flower2
                  className="w-6 h-6 absolute -top-3 -left-3"
                  style={{ color: accentColor }}
                />
                <Flower2
                  className="w-6 h-6 absolute -top-3 -right-3"
                  style={{ color: accentColor }}
                />
                <Flower2
                  className="w-6 h-6 absolute -bottom-3 -left-3"
                  style={{ color: accentColor }}
                />
                <Flower2
                  className="w-6 h-6 absolute -bottom-3 -right-3"
                  style={{ color: accentColor }}
                />
              </div>
            )}

            {/* Decorative Boho Arch — the top curve needs real headroom above
                the poster header (badge + couple names + venue line) or it
                cuts straight through that text; a real doorway-arch motif is
                asymmetric anyway (tall open curve at top, flush at the
                bottom), so a bigger top offset than the sides/bottom is both
                the fix and the more correct shape for "arch." */}
            {activeFrame === 'boho_arch' && (
              <div
                className="absolute top-24 sm:top-28 left-4 right-4 sm:left-6 sm:right-6 bottom-4 sm:bottom-6 pointer-events-none rounded-t-full rounded-b-md"
                style={{ border: `2px solid ${accentColor}` }}
              />
            )}

            {/* Decorative Double Border Classic */}
            {activeFrame === 'double_border' && (
              <div
                className="absolute inset-3 sm:inset-4 pointer-events-none"
                style={{ border: `1px solid ${accentColor}` }}
              >
                <div
                  className="absolute inset-2 pointer-events-none"
                  style={{ border: `1px solid ${accentColor}` }}
                />
              </div>
            )}

            {/* Decorative Art Deco Corners */}
            {activeFrame === 'art_deco' && (
              <div className="absolute inset-4 sm:inset-6 pointer-events-none">
                {[
                  'top-0 left-0 border-t-2 border-l-2',
                  'top-0 right-0 border-t-2 border-r-2',
                  'bottom-0 left-0 border-b-2 border-l-2',
                  'bottom-0 right-0 border-b-2 border-r-2',
                ].map((pos) => (
                  <div
                    key={pos}
                    className={`absolute w-10 h-10 sm:w-12 sm:h-12 ${pos}`}
                    style={{ borderColor: accentColor }}
                  />
                ))}
              </div>
            )}

            {/* Poster Header */}
            <div className="space-y-1 relative z-10 pt-2">
              <div className="flex items-center justify-center gap-1.5 mb-1" style={{ color: accentColor }}>
                <Heart className="w-3.5 h-3.5 fill-current" />
                <span className="text-[10px] tracking-[0.2em] uppercase font-semibold">
                  {i18n.t('ui.q_r_canvas_studio.6')}
                </span>
                <Heart className="w-3.5 h-3.5 fill-current" />
              </div>
              <h2
                className="font-serif text-2xl sm:text-3xl font-bold tracking-tight text-[#1A1817] leading-tight"
                style={{ fontFamily: 'Cinzel, Georgia, serif' }}
              >
                {event.hostName}
              </h2>
              <p className="text-[11px] text-[#6B6560] tracking-wide">
                {event.venueName} • {formatEuDateLong(event.eventDate)}
              </p>
            </div>

            {/* Central QR Code Component */}
            <div className="my-auto relative z-10 flex flex-col items-center space-y-3">
              <div
                className="p-4 sm:p-5 bg-white rounded-2xl shadow-md flex items-center justify-center"
                style={{
                  border: `2px solid ${accentColor}40`,
                }}
              >
                <QRCodeSVG
                  value={currentUrl}
                  title={i18n.t('qr.alt')}
                  size={190}
                  level="H"
                  includeMargin={false}
                  imageSettings={
                    centerIcon === 'none'
                      ? undefined
                      : {
                          src: centerIconDataUri(centerIcon)!,
                          x: undefined,
                          y: undefined,
                          height: 36,
                          width: 36,
                          excavate: true,
                        }
                  }
                />
              </div>

              <div className="space-y-1 max-w-[260px]">
                <h3
                  className="font-serif text-base font-bold text-[#1A1817] uppercase tracking-wider"
                  style={{ color: accentColor }}
                >
                  {headline}
                </h3>
                <p className="text-[11px] text-[#55504C] leading-snug">
                  {subtext}
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="relative z-10 text-[10px] text-[#6F6862] tracking-widest uppercase font-medium pb-1">
              {i18n.t('projector.no_app')}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
