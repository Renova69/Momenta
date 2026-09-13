import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { HostProfileModal } from '../../src/components/host/HostProfileModal';
import { i18n } from '../../src/i18n';
import { HostUser } from '../../src/types';

/**
 * The host's own profile dialog.
 *
 * It was at 0% coverage — never rendered by the suite at all — while owning the
 * only path by which a host edits their display name, and the rule that their
 * email is not editable because registration keyed on it.
 */

const hostUser = {
  id: 'u1',
  email: 'host@example.com',
  fullName: 'Ivan Petrov',
} as unknown as HostUser;

function renderModal(overrides: Partial<React.ComponentProps<typeof HostProfileModal>> = {}) {
  const onClose = vi.fn();
  const onSaveName = vi.fn(async () => ({ success: true }));
  const props = { isOpen: true, onClose, onSaveName, hostUser, ...overrides };
  const utils = render(<HostProfileModal {...props} />);
  return { ...utils, onClose, onSaveName: props.onSaveName };
}

describe('HostProfileModal', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders nothing at all when closed', () => {
    const { container } = render(
      <HostProfileModal isOpen={false} onClose={vi.fn()} onSaveName={vi.fn()} hostUser={hostUser} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('opens with the current name prefilled', () => {
    renderModal();
    expect(screen.getByDisplayValue('Ivan Petrov')).toBeTruthy();
  });

  it('shows the email read-only, because registration keyed on it', () => {
    renderModal();
    const email = screen.getByDisplayValue('host@example.com') as HTMLInputElement;
    expect(email.disabled).toBe(true);
    // The reason is stated to the host rather than left as a dead control.
    expect(email.title).toBe(i18n.t('host_profile.email_locked_hint'));
  });

  it('refuses to save a blank name, and does not call the server', async () => {
    const { onSaveName } = renderModal();

    fireEvent.change(screen.getByDisplayValue('Ivan Petrov'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText(i18n.t('host_profile.save_button')));

    expect(await screen.findByText(i18n.t('host_profile.name_required'))).toBeTruthy();
    expect(onSaveName).not.toHaveBeenCalled();
  });

  it('trims the name before saving', async () => {
    const { onSaveName } = renderModal();

    fireEvent.change(screen.getByDisplayValue('Ivan Petrov'), { target: { value: '  Maria Ivanova  ' } });
    fireEvent.click(screen.getByText(i18n.t('host_profile.save_button')));

    await waitFor(() => expect(onSaveName).toHaveBeenCalledWith('Maria Ivanova'));
  });

  it('confirms a successful save, then returns to the idle label', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderModal();

    fireEvent.click(screen.getByText(i18n.t('host_profile.save_button')));

    expect(await screen.findByText(i18n.t('host_profile.saved'))).toBeTruthy();

    // The confirmation is transient; the button must not stay stuck on "Saved!"
    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => expect(screen.getByText(i18n.t('host_profile.save_button'))).toBeTruthy());
  });

  it("surfaces the server's own reason when the save fails", async () => {
    renderModal({
      onSaveName: vi.fn(async () => ({ success: false, error: 'Name contains invalid characters' })),
    });

    fireEvent.click(screen.getByText(i18n.t('host_profile.save_button')));

    expect(await screen.findByText('Name contains invalid characters')).toBeTruthy();
  });

  it('falls back to a generic message when the failure carries no reason', async () => {
    renderModal({ onSaveName: vi.fn(async () => ({ success: false })) });

    fireEvent.click(screen.getByText(i18n.t('host_profile.save_button')));

    expect(await screen.findByText(i18n.t('host_profile.save_failed'))).toBeTruthy();
  });

  it('clears a previous error when reopened, rather than showing a stale one', async () => {
    const onSaveName = vi.fn(async () => ({ success: false, error: 'Boom' }));
    const { rerender } = render(
      <HostProfileModal isOpen onClose={vi.fn()} onSaveName={onSaveName} hostUser={hostUser} />
    );

    fireEvent.click(screen.getByText(i18n.t('host_profile.save_button')));
    expect(await screen.findByText('Boom')).toBeTruthy();

    rerender(
      <HostProfileModal isOpen={false} onClose={vi.fn()} onSaveName={onSaveName} hostUser={hostUser} />
    );
    rerender(
      <HostProfileModal isOpen onClose={vi.fn()} onSaveName={onSaveName} hostUser={hostUser} />
    );

    expect(screen.queryByText('Boom')).toBeNull();
  });

  it('discards an unsaved edit when reopened', () => {
    const { rerender } = render(
      <HostProfileModal isOpen onClose={vi.fn()} onSaveName={vi.fn()} hostUser={hostUser} />
    );

    fireEvent.change(screen.getByDisplayValue('Ivan Petrov'), { target: { value: 'Typed but abandoned' } });

    rerender(
      <HostProfileModal isOpen={false} onClose={vi.fn()} onSaveName={vi.fn()} hostUser={hostUser} />
    );
    rerender(<HostProfileModal isOpen onClose={vi.fn()} onSaveName={vi.fn()} hostUser={hostUser} />);

    expect(screen.getByDisplayValue('Ivan Petrov')).toBeTruthy();
  });

  it('closes on the dismiss control', () => {
    const { onClose, container } = renderModal();
    fireEvent.click(container.querySelector('button')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
