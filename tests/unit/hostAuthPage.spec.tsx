import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

import { HostAuthPage } from '../../src/components/host/HostAuthPage';
import { authService, DEMO_HOST_USERS } from '../../src/services/authService';
import { HostUser } from '../../src/types';
import { i18n } from '../../src/i18n';

const USER: HostUser = {
  id: 'u1',
  email: 'monika@example.com',
  fullName: 'Monika',
  role: 'couple',
  createdAt: new Date().toISOString(),
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HostAuthPage', () => {
  it('signs in with email/password and reports success upward', async () => {
    const loginSpy = vi.spyOn(authService, 'login').mockResolvedValue({ success: true, user: USER });
    const onSuccess = vi.fn();
    render(<HostAuthPage onSuccess={onSuccess} />);

    fireEvent.change(screen.getByPlaceholderText('monika.alexander@wedmoments.bg'), { target: { value: 'monika@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByText(i18n.t('host.signin_btn')));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(USER, undefined));
    expect(loginSpy).toHaveBeenCalledWith('monika@example.com', 'secret123');
  });

  it('shows the server error on failed sign-in instead of silently doing nothing', async () => {
    vi.spyOn(authService, 'login').mockResolvedValue({ success: false, error: 'Wrong password' });
    const onSuccess = vi.fn();
    render(<HostAuthPage onSuccess={onSuccess} />);

    fireEvent.change(screen.getByPlaceholderText('monika.alexander@wedmoments.bg'), { target: { value: 'monika@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText(i18n.t('host.signin_btn')));

    await waitFor(() => expect(screen.getByText('Wrong password')).toBeInTheDocument());
    expect(onSuccess).not.toHaveBeenCalled();
  });

  // N-146 — the message appeared on screen and nowhere else: a host using a
  // screen reader pressed "sign in" and heard nothing at all.
  it('announces a failed sign-in, not just shows it', async () => {
    vi.spyOn(authService, 'login').mockResolvedValue({ success: false, error: 'Wrong password' });
    render(<HostAuthPage onSuccess={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('monika.alexander@wedmoments.bg'), { target: { value: 'monika@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText(i18n.t('host.signin_btn')));

    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password');
  });

  // N-145 — which form was open was shown by colour alone.
  it('says which of sign-in, sign-up and demo is open', () => {
    render(<HostAuthPage onSuccess={vi.fn()} initialTab="signup" />);

    expect(screen.getByRole('button', { name: i18n.t('host.signup') })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: i18n.t('host.signin') })).not.toHaveAttribute('aria-current');
  });

  it('registers a new planner account with the company name field', async () => {
    const registerSpy = vi.spyOn(authService, 'register').mockResolvedValue({ success: true, user: USER });
    const onSuccess = vi.fn();
    render(<HostAuthPage onSuccess={onSuccess} />);

    fireEvent.click(screen.getByText(i18n.t('host.signup')));
    fireEvent.change(screen.getByPlaceholderText(i18n.t('auth.name_example')), { target: { value: 'Gergana Dimitrova' } });
    fireEvent.change(screen.getByPlaceholderText('monika.alexander@wedmoments.bg'), { target: { value: 'gergana@example.com' } });
    fireEvent.change(screen.getByPlaceholderText(i18n.t('auth.password_hint')), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByText(i18n.t('ui.host_auth_page.3'))); // "planner" role card
    fireEvent.change(screen.getByPlaceholderText(i18n.t('auth.company_example')), { target: { value: 'Dimitrova & Co' } });
    fireEvent.click(screen.getByText(i18n.t('host.signup_btn')));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(USER, undefined));
    expect(registerSpy).toHaveBeenCalledWith('gergana@example.com', 'Gergana Dimitrova', 'secret123', 'planner', 'Dimitrova & Co');
  });

  it('logs in instantly with a demo account', async () => {
    const demoSpy = vi.spyOn(authService, 'loginWithDemo').mockResolvedValue({ success: true, user: DEMO_HOST_USERS[0] });
    const onSuccess = vi.fn();
    render(<HostAuthPage onSuccess={onSuccess} />);

    fireEvent.click(screen.getByText(i18n.t('host.demo')));
    fireEvent.click(screen.getByText(DEMO_HOST_USERS[0].fullName));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(DEMO_HOST_USERS[0], undefined));
    expect(demoSpy).toHaveBeenCalledWith(DEMO_HOST_USERS[0]);
  });
});

describe('arriving to create an album (N-132)', () => {
  it('starts on the sign-up form, not sign-in', () => {
    render(<HostAuthPage onSuccess={vi.fn()} initialTab="signup" />);
    expect(screen.getByRole('button', { name: i18n.t('host.signup_btn') })).toBeInTheDocument();
  });
});

/**
 * N-154 — WCAG 1.3.5 (Identify Input Purpose): without `autocomplete`, a
 * password manager cannot tell sign-in from sign-up, and a phone cannot
 * offer the address or the saved password.
 */
describe('what each field is for (N-154)', () => {
  it('marks the sign-in fields as the saved email and password', () => {
    const { container } = render(<HostAuthPage onSuccess={vi.fn()} />);

    expect(container.querySelector('input[type="email"]')).toHaveAttribute('autocomplete', 'email');
    expect(container.querySelector('input[type="password"]')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('marks the sign-up fields as a name, an email and a new password', () => {
    const { container } = render(<HostAuthPage onSuccess={vi.fn()} initialTab="signup" />);

    expect(container.querySelector('input[type="text"]')).toHaveAttribute('autocomplete', 'name');
    expect(container.querySelector('input[type="email"]')).toHaveAttribute('autocomplete', 'email');
    expect(container.querySelector('input[type="password"]')).toHaveAttribute('autocomplete', 'new-password');
  });
});
