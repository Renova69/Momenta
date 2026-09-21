import { useCallback, useEffect, useRef } from 'react';

/**
 * Make an overlay behave like a dialog.
 *
 * Every modal in this app was a `<div className="fixed inset-0 …">`. It looked
 * like a dialog and behaved like nothing: no role, so a screen reader announced
 * the page as if the overlay were not there; no Escape, so the lightbox could
 * be opened by keyboard and not closed; and no focus handling, so Tab walked
 * straight out of the dialog into the page behind it — which is still rendered,
 * still focusable, and now invisible under the backdrop.
 *
 * What this gives an overlay:
 *
 * - `role="dialog"` and `aria-modal`, so assistive technology treats the rest
 *   of the page as inert while it is open.
 * - Escape closes it.
 * - Focus moves into it on open and returns to whatever opened it on close,
 *   so a guest who tabbed to "Open camera" lands back on that button.
 * - Tab cycles inside it rather than escaping behind the backdrop.
 *
 * Usage:
 *
 * ```tsx
 * const { dialogRef, dialogProps } = useDialog({ onClose, labelledBy: titleId });
 * return <div ref={dialogRef} {...dialogProps} className="fixed inset-0 …">…</div>;
 * ```
 *
 * `labelledBy` should be the id of the element holding the dialog's visible
 * title. Without a name the dialog announces only as "dialog", which tells a
 * guest nothing about what just opened.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogOptions {
  /** Called on Escape, and whatever else the dialog uses to dismiss itself. */
  onClose: () => void;
  /** Id of the element that holds the dialog's visible title. */
  labelledBy?: string;
  /**
   * Set false for an overlay Escape must not close — a capture in progress,
   * say, where dropping it would lose the photo.
   */
  closeOnEscape?: boolean;
  /**
   * False while the dialog is not on screen. A component that returns null
   * must still call this hook — the rules of hooks leave no choice — and
   * without this the key handler would be bound with nothing to focus, so
   * Tab, which the trap below prevents by default, would stop working for
   * the whole page while the dialog was closed.
   */
  enabled?: boolean;
}

export function useDialog({ onClose, labelledBy, closeOnEscape = true, enabled = true }: DialogOptions) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Held in a ref so the effect below does not tear down and re-run every
  // render an inline arrow gives it a new identity — which would move focus
  // back to the top of the dialog while someone was typing in it.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const focusables = useCallback(
    () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    []
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const first = focusables()[0] ?? dialogRef.current;
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEscape) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) {
        // Nothing to move to, so keep focus on the dialog itself rather than
        // letting Tab take it to the page underneath.
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      const outside = !dialogRef.current?.contains(active);

      if (outside) {
        event.preventDefault();
        (event.shiftKey ? lastItem : firstItem).focus();
      } else if (event.shiftKey && active === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Only take focus back if it is still inside the dialog being removed;
      // otherwise the app has already moved it somewhere deliberate.
      if (opener && (!document.activeElement || document.activeElement === document.body)) {
        opener.focus?.();
      }
    };
  }, [closeOnEscape, enabled, focusables]);

  return {
    dialogRef,
    dialogProps: {
      role: 'dialog' as const,
      'aria-modal': true,
      'aria-labelledby': labelledBy,
      tabIndex: -1,
    },
  };
}
