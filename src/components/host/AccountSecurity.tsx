/**
 * The host's password and account (N-122): change the password, delete the
 * account. Shown in the host profile dialog, under the name and email.
 *
 * Forgotten passwords are reset by the operator until mail is configured
 * (`npm run admin:reset-password`); the host then changes it here.
 */

import React, { useId, useState } from 'react';
import { KeyRound, Trash2, Loader2, ChevronDown } from 'lucide-react';
import { i18n } from '../../i18n';

type Outcome = { success: boolean; error?: string };

interface AccountSecurityProps {
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<Outcome>;
  onDeleteAccount: (password: string) => Promise<Outcome>;
}

const MIN_PASSWORD_LENGTH = 6;

const inputClass =
  'w-full px-3 py-2.5 rounded-xl bg-noir-800 border border-cream-400/20 text-sm text-cream-100 focus:outline-hidden focus:border-gold-400';
const labelClass = 'block text-xs font-semibold text-cream-300 mb-1.5';

const ChangePasswordForm: React.FC<Pick<AccountSecurityProps, 'onChangePassword'>> = ({ onChangePassword }) => {
  const ids = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (next.length < MIN_PASSWORD_LENGTH) return setError(i18n.t('auth.password_too_short'));
    if (next !== repeat) return setError(i18n.t('account.passwords_differ'));
    setError(null);
    setIsSaving(true);
    const result = await onChangePassword(current, next);
    setIsSaving(false);
    if (!result.success) return setError(result.error || i18n.t('account.password_change_failed'));
    setCurrent('');
    setNext('');
    setRepeat('');
    setDone(true);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <h4 className="flex items-center gap-1.5 text-sm font-bold text-cream-100">
        <KeyRound className="w-4 h-4 text-gold-400" aria-hidden="true" />
        <span>{i18n.t('account.password_title')}</span>
      </h4>
      <div>
        <label htmlFor={`${ids}-current`} className={labelClass}>
          {i18n.t('account.current_password')}
        </label>
        <input
          id={`${ids}-current`}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`${ids}-next`} className={labelClass}>
          {i18n.t('account.new_password')}
        </label>
        <input
          id={`${ids}-next`}
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-describedby={`${ids}-hint`}
          className={inputClass}
        />
        <p id={`${ids}-hint`} className="text-[10px] text-cream-400/70 mt-1">
          {i18n.t('account.new_password_hint')}
        </p>
      </div>
      <div>
        <label htmlFor={`${ids}-repeat`} className={labelClass}>
          {i18n.t('account.repeat_password')}
        </label>
        <input
          id={`${ids}-repeat`}
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          className={inputClass}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-rosewood-300">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-xs text-sage-300">
          {i18n.t('account.password_changed')}
        </p>
      )}
      <button
        type="submit"
        disabled={isSaving || !current || !next || !repeat}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-noir-800 border border-gold-400/40 text-gold-300 text-sm font-semibold hover:bg-noir-700 transition-colors disabled:opacity-50"
      >
        {isSaving && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
        <span>{i18n.t('account.password_change_button')}</span>
      </button>
    </form>
  );
};

const DeleteAccount: React.FC<Pick<AccountSecurityProps, 'onDeleteAccount'>> = ({ onDeleteAccount }) => {
  const ids = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!window.confirm(i18n.t('account.delete_confirm'))) return;
    setError(null);
    setIsDeleting(true);
    const result = await onDeleteAccount(password);
    setIsDeleting(false);
    if (!result.success) setError(result.error || i18n.t('account.delete_failed'));
  };

  return (
    <div className="rounded-2xl border border-rosewood-500/30 bg-rosewood-900/20">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={`${ids}-panel`}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm font-bold text-rosewood-200"
      >
        <span className="flex items-center gap-1.5">
          <Trash2 className="w-4 h-4" aria-hidden="true" />
          <span>{i18n.t('account.delete_title')}</span>
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {isOpen && (
        <div id={`${ids}-panel`} className="px-4 pb-4 space-y-3">
          <p className="text-xs text-cream-300 leading-relaxed">{i18n.t('account.delete_warning')}</p>
          <div>
            <label htmlFor={`${ids}-password`} className={labelClass}>
              {i18n.t('account.delete_password')}
            </label>
            <input
              id={`${ids}-password`}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-rosewood-300">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting || !password}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-rosewood-600 text-white text-sm font-bold hover:bg-rosewood-500 transition-colors disabled:opacity-50"
          >
            {isDeleting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            <span>{i18n.t('account.delete_button')}</span>
          </button>
        </div>
      )}
    </div>
  );
};

export const AccountSecurity: React.FC<AccountSecurityProps> = ({ onChangePassword, onDeleteAccount }) => (
  <div className="space-y-5 pt-5 mt-5 border-t border-cream-400/10">
    <ChangePasswordForm onChangePassword={onChangePassword} />
    <DeleteAccount onDeleteAccount={onDeleteAccount} />
  </div>
);
