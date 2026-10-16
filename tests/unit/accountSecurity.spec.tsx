import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AccountSecurity } from '../../src/components/host/AccountSecurity';
import { i18n } from '../../src/i18n';

/**
 * N-122 — the profile's password and account section: change the password
 * (current, new, the new once more), and delete the account behind a warning,
 * the password and a final confirmation.
 */

function section(over: Partial<React.ComponentProps<typeof AccountSecurity>> = {}) {
  const props = {
    onChangePassword: vi.fn().mockResolvedValue({ success: true }),
    onDeleteAccount: vi.fn().mockResolvedValue({ success: true }),
    ...over,
  };
  render(<AccountSecurity {...props} />);
  return props;
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('changing the password', () => {
  it('sends the current and the new password, and says it worked', async () => {
    const { onChangePassword } = section();

    type(i18n.t('account.current_password'), 'Password123!');
    type(i18n.t('account.new_password'), 'NewPassword456!');
    type(i18n.t('account.repeat_password'), 'NewPassword456!');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('account.password_change_button') }));

    await waitFor(() => expect(onChangePassword).toHaveBeenCalledWith('Password123!', 'NewPassword456!'));
    expect(await screen.findByRole('status')).toHaveTextContent(i18n.t('account.password_changed'));
  });

  it('catches a mistyped new password before sending anything', () => {
    const { onChangePassword } = section();

    type(i18n.t('account.current_password'), 'Password123!');
    type(i18n.t('account.new_password'), 'NewPassword456!');
    type(i18n.t('account.repeat_password'), 'NewPasword456!');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('account.password_change_button') }));

    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('account.passwords_differ'));
    expect(onChangePassword).not.toHaveBeenCalled();
  });

  it('says why a change was refused', async () => {
    section({ onChangePassword: vi.fn().mockResolvedValue({ success: false, error: i18n.t('account.password_wrong') }) });

    type(i18n.t('account.current_password'), 'wrong');
    type(i18n.t('account.new_password'), 'NewPassword456!');
    type(i18n.t('account.repeat_password'), 'NewPassword456!');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('account.password_change_button') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('account.password_wrong'));
  });
});

describe('deleting the account', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: i18n.t('account.delete_title') }));

  it('says what goes before asking for anything', () => {
    section();

    open();

    expect(screen.getByText(i18n.t('account.delete_warning'))).toBeInTheDocument();
  });

  it('asks for the password and a final confirmation, then deletes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onDeleteAccount } = section();
    open();

    type(i18n.t('account.delete_password'), 'Password123!');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('account.delete_button') }));

    await waitFor(() => expect(onDeleteAccount).toHaveBeenCalledWith('Password123!'));
    expect(confirm).toHaveBeenCalled();
  });

  it('deletes nothing when the host thinks better of it', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onDeleteAccount } = section();
    open();

    type(i18n.t('account.delete_password'), 'Password123!');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('account.delete_button') }));

    expect(onDeleteAccount).not.toHaveBeenCalled();
  });

  it('cannot be pressed without the password', () => {
    section();
    open();

    expect(screen.getByRole('button', { name: i18n.t('account.delete_button') })).toBeDisabled();
  });

  it('says why a deletion did not happen', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    section({ onDeleteAccount: vi.fn().mockResolvedValue({ success: false, error: i18n.t('account.delete_billing_unreachable') }) });
    open();

    type(i18n.t('account.delete_password'), 'Password123!');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('account.delete_button') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('account.delete_billing_unreachable'));
  });
});
