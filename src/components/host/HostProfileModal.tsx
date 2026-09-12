import React, { useState, useEffect } from 'react';
import { HostUser } from '../../types';
import { i18n } from '../../i18n';
import { X, User, Mail, Check, Loader2 } from 'lucide-react';

interface HostProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  hostUser: HostUser;
  onSaveName: (fullName: string) => Promise<{ success: boolean; error?: string }>;
}

export const HostProfileModal: React.FC<HostProfileModalProps> = ({
  isOpen,
  onClose,
  hostUser,
  onSaveName,
}) => {
  const [nameDraft, setNameDraft] = useState(hostUser.fullName);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setNameDraft(hostUser.fullName);
      setError(null);
      setSaved(false);
    }
  }, [isOpen, hostUser.fullName]);

  if (!isOpen) return null;

  const handleSave = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setError(i18n.t('host_profile.name_required'));
      return;
    }
    setIsSaving(true);
    setError(null);
    const result = await onSaveName(trimmed);
    setIsSaving(false);
    if (result.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError(result.error || i18n.t('host_profile.save_failed'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-md bg-noir-900 rounded-3xl border border-gold-400/30 shadow-2xl p-6 overflow-hidden">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full bg-noir-700 text-cream-300 hover:text-white transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <h3 className="font-serif text-xl font-bold text-cream-100 mb-1">
          {i18n.t('host_profile.title')}
        </h3>
        <p className="text-xs text-cream-400/70 mb-5">{i18n.t('host_profile.subtitle')}</p>

        <div className="space-y-4">
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-cream-300 mb-1.5">
              <User className="w-3.5 h-3.5 text-gold-400" />
              <span>{i18n.t('host_profile.name_label')}</span>
            </label>
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-noir-800 border border-cream-400/20 text-sm text-cream-100 focus:outline-none focus:border-gold-400"
            />
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-cream-300 mb-1.5">
              <Mail className="w-3.5 h-3.5 text-cream-400/60" />
              <span>{i18n.t('host_profile.email_label')}</span>
            </label>
            <input
              type="email"
              value={hostUser.email}
              disabled
              title={i18n.t('host_profile.email_locked_hint')}
              className="w-full px-3 py-2.5 rounded-xl bg-noir-950 border border-cream-400/10 text-sm text-cream-400/60 cursor-not-allowed"
            />
            <p className="text-[10px] text-cream-400/50 mt-1">{i18n.t('host_profile.email_locked_hint')}</p>
          </div>

          {error && <p className="text-xs text-rosewood-400">{error}</p>}

          <button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-sm shadow-glow hover:brightness-110 active:scale-98 transition-all disabled:opacity-60"
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : saved ? (
              <Check className="w-4 h-4" />
            ) : null}
            <span>{saved ? i18n.t('host_profile.saved') : i18n.t('host_profile.save_button')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
