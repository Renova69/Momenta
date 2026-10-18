import React from 'react';
import { Eye } from 'lucide-react';
import { i18n } from '../../i18n';

/**
 * N-166 — the demo login is shared by every visitor, so the server refuses
 * anything it would change. Said at the top of the studio, before a visitor
 * fills in a form that can only be refused.
 */
export const DemoNotice: React.FC = () => (
  <div
    role="note"
    className="p-4 rounded-2xl border bg-noir-800/90 border-gold-400/30 text-cream-200 flex items-start gap-2.5"
  >
    <Eye className="w-5 h-5 shrink-0 text-gold-400" aria-hidden="true" />
    <p className="text-xs font-semibold">{i18n.t('demo.view_only_title')}</p>
  </div>
);
