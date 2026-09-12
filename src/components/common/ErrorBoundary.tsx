import React, { Component, ErrorInfo, ReactNode } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { i18n } from '../../i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary caught]:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-noir-900 text-cream-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-noir-800 border border-gold-500/30 rounded-3xl p-8 text-center space-y-6 shadow-2xl">
            <div className="w-16 h-16 rounded-full bg-rosewood-600/30 border border-rosewood-500/40 text-rosewood-400 mx-auto flex items-center justify-center">
              <AlertTriangle className="w-8 h-8" />
            </div>

            <div className="space-y-2">
              <h2 className="font-serif text-2xl text-cream-100 font-semibold">{i18n.t('common.error_title')}</h2>
              <p className="text-xs text-cream-400/80">
                {i18n.t('common.error_body')}
              </p>
              {/* The technical message helps during development; a wedding guest
                  should not be shown an internal stack message. */}
              {import.meta.env.DEV && this.state.error && (
                <div className="bg-noir-900/80 p-3 rounded-xl text-left text-[11px] font-mono text-rosewood-300 overflow-x-auto max-h-28 border border-white/5">
                  {this.state.error.message}
                </div>
              )}
            </div>

            <button
              onClick={this.handleReload}
              className="w-full py-3 px-6 rounded-2xl bg-gradient-to-r from-gold-500 to-gold-400 text-noir-900 font-bold text-sm flex items-center justify-center gap-2 shadow-glow hover:opacity-95 transition-opacity"
            >
              <RefreshCw className="w-4 h-4" />
              <span>{i18n.t('common.reload')}</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
