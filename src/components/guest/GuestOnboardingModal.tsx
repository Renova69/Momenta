import React, { useState, useEffect, useRef } from 'react';
import { Guest } from '../../types';
import { compressAndFilterImage } from '../../services/compressionService';
import { i18n } from '../../i18n';
import {
  X,
  Camera,
  Heart,
  ImageIcon,
} from 'lucide-react';

interface GuestOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentGuest: Guest | null;
  onSaveGuest: (name: string, tableNumber?: string, avatarUrl?: string) => void;
}

export const GuestOnboardingModal: React.FC<GuestOnboardingModalProps> = ({
  isOpen,
  onClose,
  currentGuest,
  onSaveGuest,
}) => {
  const [name, setName] = useState(() => currentGuest?.id === 'anonymous' ? '' : (currentGuest?.name || ''));
  const [tableNumber, setTableNumber] = useState(currentGuest?.tableNumber || '');
  const [avatarUrl, setAvatarUrl] = useState(() => currentGuest?.id === 'anonymous' ? '' : (currentGuest?.avatarUrl || ''));
  const [isCompressing, setIsCompressing] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  // Synchronize state whenever modal opens or currentGuest changes
  useEffect(() => {
    if (isOpen && currentGuest) {
      if (currentGuest.id === 'anonymous') {
        setName('');
        setTableNumber('');
        setAvatarUrl('');
      } else {
        setName(currentGuest.name || '');
        setTableNumber(currentGuest.tableNumber || '');
        setAvatarUrl(currentGuest.avatarUrl || '');
      }
    }
  }, [isOpen, currentGuest]);

  if (!isOpen) return null;

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsCompressing(true);
    try {
      const result = await compressAndFilterImage(file, {
        maxWidth: 256,
        maxHeight: 256,
        quality: 0.85,
        filter: 'original',
      });
      setAvatarUrl(result.dataUrl);
    } catch (err) {
      console.error('Failed to compress avatar:', err);
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setAvatarUrl(event.target.result as string);
        }
      };
      reader.readAsDataURL(file);
    } finally {
      setIsCompressing(false);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSaveGuest(name.trim(), tableNumber.trim() || undefined, avatarUrl || undefined);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-md bg-noir-900 rounded-3xl border border-gold-400/30 shadow-2xl p-6 overflow-hidden">
        
        <button
          onClick={onClose}
          type="button"
          aria-label="Close"
          className="absolute top-4 right-4 p-1.5 rounded-full bg-noir-800 text-cream-300 hover:text-white transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-full bg-gold-400/20 border border-gold-400/40 flex items-center justify-center mx-auto mb-2 shadow-glow">
            <Heart className="w-6 h-6 text-gold-400 fill-gold-400" />
          </div>
          <h3 className="font-serif text-2xl font-bold text-cream-100">
            {i18n.t('profile.title')}
          </h3>
          <p className="text-xs text-cream-300/70">
            {i18n.t('profile.subtitle')}
          </p>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          
          {/* Avatar / Selfie Uploader */}
          <div className="flex flex-col items-center gap-3">
            <div className="relative w-24 h-24 rounded-full border-2 border-dashed border-gold-400/50 hover:border-gold-400 overflow-hidden flex items-center justify-center bg-noir-800 transition-colors shadow-inner">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt="Guest avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="flex flex-col items-center text-gold-400/80">
                  <Camera className="w-8 h-8 mb-1" />
                </div>
              )}

              {isCompressing && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-[10px] font-semibold">
                  {i18n.t('ui.guest_onboarding_modal.1')}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-noir-800 border border-gold-400/30 text-gold-400 text-[11px] font-semibold hover:bg-gold-400/10 transition-colors"
              >
                <Camera className="w-3.5 h-3.5" />
                {i18n.t('ui.guest_onboarding_modal.2')}
              </button>
              
              <button
                type="button"
                onClick={() => galleryInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-noir-800 border border-cream-400/20 text-cream-200 text-[11px] font-semibold hover:bg-noir-700 transition-colors"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                {i18n.t('ui.guest_onboarding_modal.3')}
              </button>
            </div>

            {/* Hidden Inputs */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="user"
              className="hidden"
              onChange={handleAvatarFile}
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleAvatarFile}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-cream-300 mb-1">
              {i18n.t('profile.name_label')}
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={i18n.t('profile.name_placeholder')}
              className="w-full px-3.5 py-2.5 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-sm focus:outline-none focus:border-gold-400"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-cream-300 mb-1">
              {i18n.t('profile.table_label')}
            </label>
            <input
              type="text"
              value={tableNumber}
              onChange={(e) => setTableNumber(e.target.value)}
              placeholder={i18n.t('profile.table_placeholder')}
              className="w-full px-3.5 py-2.5 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-sm focus:outline-none focus:border-gold-400"
            />
          </div>

          <button
            type="submit"
            className="w-full py-3.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-sm shadow-glow hover:brightness-110 active:scale-98 transition-all mt-4"
          >
            {i18n.t('profile.save_btn')}
          </button>

        </form>

      </div>
    </div>
  );
};
