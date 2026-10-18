import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { HostProfileModal } from '../../src/components/host/HostProfileModal';
import { DemoNotice } from '../../src/components/host/DemoNotice';
import { ERROR_CODE_KEYS } from '../../src/api/apiClient';
import { i18n } from '../../src/i18n';
import { HostUser } from '../../src/types';

/**
 * N-166 — the demo account is view-only (the owner's rule, 2026-10-18). The
 * server refuses every change; the studio says so up front instead of letting
 * a visitor fill in forms that can only fail, and it offers no password or
 * account deletion at all.
 */

const demoUser = { id: 'demo', email: 'demo.couple@wedmoments.bg', fullName: 'Моника и Александър', isDemo: true } as HostUser;

afterEach(() => cleanup());

describe('the demo account in the studio (N-166)', () => {
  it('offers no password change or account deletion, and says why', () => {
    render(
      <HostProfileModal
        isOpen
        onClose={vi.fn()}
        hostUser={demoUser}
        onSaveName={vi.fn()}
        onChangePassword={vi.fn()}
        onDeleteAccount={vi.fn()}
      />
    );

    expect(screen.queryByText(i18n.t('account.password_title'))).toBeNull();
    expect(screen.queryByText(i18n.t('host_profile.save_button'))).toBeNull();
    expect((screen.getByDisplayValue(demoUser.fullName) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(i18n.t('demo.view_only_body'))).toBeTruthy();
  });

  it('tells the visitor at the top of the studio that nothing is saved', () => {
    render(<DemoNotice />);
    expect(screen.getByRole('note')).toHaveTextContent(i18n.t('demo.view_only_title'));
  });

  it("translates the server's refusal", () => {
    expect(ERROR_CODE_KEYS.DEMO_READ_ONLY).toBe('error.demo_read_only');
    expect(i18n.t('error.demo_read_only')).not.toBe('error.demo_read_only');
  });
});
