import React, { useState } from 'react';
import { HostUser, WeddingEvent } from '../../types';
import { authService, DEMO_HOST_USERS } from '../../services/authService';
import { i18n } from '../../i18n';
import {
  Lock,
  Mail,
  User,
  Crown,
  Briefcase,
  CheckCircle2
} from 'lucide-react';

interface HostAuthPageProps {
  onSuccess: (user: HostUser, event?: Partial<WeddingEvent>) => void;
  onCancel?: () => void;
}

export const HostAuthPage: React.FC<HostAuthPageProps> = ({ onSuccess }) => {
  const [activeTab, setActiveTab] = useState<'signin' | 'signup' | 'demo'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<'couple' | 'planner'>('couple');
  const [companyName, setCompanyName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setIsLoading(true);
    setErrorMsg('');
    const res = await authService.login(email, password);
    setIsLoading(false);

    if (res.success && res.user) {
      onSuccess(res.user, res.event);
    } else {
      setErrorMsg(res.error || i18n.t('auth.invalid_credentials'));
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !fullName.trim()) return;

    setIsLoading(true);
    setErrorMsg('');
    const res = await authService.register(email, fullName, password, role, companyName);
    setIsLoading(false);

    if (res.success && res.user) {
      onSuccess(res.user, res.event);
    } else {
      setErrorMsg(res.error || i18n.t('auth.register_failed'));
    }
  };

  const handleDemoLogin = async (demoUser: HostUser) => {
    setErrorMsg('');
    const res = await authService.loginWithDemo(demoUser);
    if (res.success && res.user) {
      onSuccess(res.user, res.event);
    } else {
      setErrorMsg(res.error || i18n.t('auth.demo_unavailable'));
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center p-4 sm:p-6 animate-fade-in">
      <div className="w-full max-w-xl bg-noir-900 rounded-3xl border border-gold-400/30 shadow-2xl overflow-hidden p-6 sm:p-10 relative">
        
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-full bg-gold-400/20 border border-gold-400/40 flex items-center justify-center mx-auto mb-3 shadow-glow">
            <Lock className="w-7 h-7 text-gold-400" />
          </div>
          <h2 className="font-serif text-3xl sm:text-4xl font-bold text-cream-100 mb-2">
            {i18n.t('host.title')}
          </h2>
          <p className="text-xs sm:text-sm text-cream-300/80 max-w-md mx-auto">
            {i18n.t('host.subtitle')}
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center bg-noir-950 p-1.5 rounded-2xl border border-cream-400/10 mb-6 text-xs font-semibold">
          <button
            onClick={() => setActiveTab('signin')}
            className={`flex-1 py-2.5 rounded-xl transition-all ${
              activeTab === 'signin'
                ? 'bg-gold-400 text-noir-900 font-bold shadow-md'
                : 'text-cream-400 hover:text-cream-200'
            }`}
          >
            {i18n.t('host.signin')}
          </button>
          <button
            onClick={() => setActiveTab('signup')}
            className={`flex-1 py-2.5 rounded-xl transition-all ${
              activeTab === 'signup'
                ? 'bg-gold-400 text-noir-900 font-bold shadow-md'
                : 'text-cream-400 hover:text-cream-200'
            }`}
          >
            {i18n.t('host.signup')}
          </button>
          <button
            onClick={() => setActiveTab('demo')}
            className={`flex-1 py-2.5 rounded-xl transition-all ${
              activeTab === 'demo'
                ? 'bg-gold-400 text-noir-900 font-bold shadow-md'
                : 'text-cream-400 hover:text-cream-200'
            }`}
          >
            {i18n.t('host.demo')}
          </button>
        </div>

        {errorMsg && (
          <div className="mb-6 p-3.5 rounded-xl bg-rosewood-900/60 border border-rosewood-400/40 text-rosewood-200 text-xs text-center">
            {errorMsg}
          </div>
        )}

        {/* 1. Sign In Form */}
        {activeTab === 'signin' && (
          <form onSubmit={handleSignIn} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-cream-300 mb-1.5">
                {i18n.t('host.email')}
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-cream-400/60 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="monika.alexander@wedmoments.bg"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-sm focus:outline-none focus:border-gold-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-cream-300 mb-1.5">
                {i18n.t('host.password')}
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-cream-400/60 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-sm focus:outline-none focus:border-gold-400"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-sm shadow-glow hover:brightness-110 active:scale-98 transition-all flex items-center justify-center gap-2 mt-6 disabled:opacity-50"
            >
              {isLoading ? i18n.t('auth.signing_in') : i18n.t('host.signin_btn')}
            </button>
          </form>
        )}

        {/* 2. Sign Up Form */}
        {activeTab === 'signup' && (
          <form onSubmit={handleSignUp} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-cream-300 mb-1.5">
                {i18n.t('host.couple_names')}
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-cream-400/60 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={i18n.t('auth.name_example')}
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-sm focus:outline-none focus:border-gold-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-cream-300 mb-1.5">
                {i18n.t('host.email')}
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-cream-400/60 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="monika.alexander@wedmoments.bg"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-sm focus:outline-none focus:border-gold-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-cream-300 mb-1.5">
                {i18n.t('host.password')}
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-cream-400/60 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={i18n.t('auth.password_hint')}
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-sm focus:outline-none focus:border-gold-400"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => setRole('couple')}
                className={`p-3 rounded-xl border text-left transition-all ${
                  role === 'couple'
                    ? 'border-gold-400 bg-gold-400/10 text-gold-300'
                    : 'border-cream-400/15 bg-noir-800/60 text-cream-400'
                }`}
              >
                <Crown className="w-4 h-4 mb-1" />
                <div className="text-xs font-bold text-cream-100">{i18n.t('ui.host_auth_page.1')}</div>
                <div className="text-[10px] text-cream-400/70">{i18n.t('ui.host_auth_page.2')}</div>
              </button>

              <button
                type="button"
                onClick={() => setRole('planner')}
                className={`p-3 rounded-xl border text-left transition-all ${
                  role === 'planner'
                    ? 'border-gold-400 bg-gold-400/10 text-gold-300'
                    : 'border-cream-400/15 bg-noir-800/60 text-cream-400'
                }`}
              >
                <Briefcase className="w-4 h-4 mb-1" />
                <div className="text-xs font-bold text-cream-100">{i18n.t('ui.host_auth_page.3')}</div>
                <div className="text-[10px] text-cream-400/70">{i18n.t('ui.host_auth_page.4')}</div>
              </button>
            </div>

            {role === 'planner' && (
              <div>
                <label className="block text-xs font-semibold text-cream-300 mb-1.5">
                  {i18n.t('ui.host_auth_page.5')}
                </label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder={i18n.t('auth.company_example')}
                  className="w-full px-4 py-3 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-sm focus:outline-none focus:border-gold-400"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-sm shadow-glow hover:brightness-110 active:scale-98 transition-all flex items-center justify-center gap-2 mt-6 disabled:opacity-50"
            >
              {isLoading ? i18n.t('auth.creating') : i18n.t('host.signup_btn')}
            </button>
          </form>
        )}

        {/* 3. Demo Quick Login */}
        {activeTab === 'demo' && (
          <div className="space-y-3">
            <p className="text-xs text-cream-300/70 mb-4 text-center">
              {i18n.t('ui.host_auth_page.6')}
            </p>
            {DEMO_HOST_USERS.map((demo) => (
              <button
                key={demo.id}
                type="button"
                onClick={() => handleDemoLogin(demo)}
                className="w-full p-4 rounded-2xl bg-noir-800 hover:bg-noir-750 border border-cream-400/15 hover:border-gold-400/50 flex items-center justify-between text-left transition-all group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gold-400/20 border border-gold-400/40 flex items-center justify-center text-gold-400">
                    {demo.role === 'planner' ? <Briefcase className="w-5 h-5" /> : <Crown className="w-5 h-5" />}
                  </div>
                  <div>
                    <h4 className="font-serif text-sm font-bold text-cream-100 group-hover:text-gold-300 transition-colors">
                      {demo.fullName}
                    </h4>
                    <span className="text-[11px] text-cream-400/70">{demo.email}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs font-semibold text-gold-400">
                  <span>{i18n.t('ui.host_auth_page.7')}</span>
                  <CheckCircle2 className="w-4 h-4" />
                </div>
              </button>
            ))}
          </div>
        )}

      </div>
    </div>
  );
};
