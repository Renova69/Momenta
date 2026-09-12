import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedField } from '../../src/hooks/useDebouncedField';

/**
 * Regression for OPEN_ITEMS.md P3 — HostDashboard called onUpdateEvent on
 * every keystroke, so a 20-character venue name fired 20 concurrent PUT
 * requests. This hook is the fix: local state updates immediately (so
 * typing feels responsive), the commit callback only fires once typing
 * pauses.
 */

describe('useDebouncedField', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reflects every keystroke immediately in local value', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDebouncedField<string>('', onCommit, 500));

    act(() => result.current[1]('V'));
    expect(result.current[0]).toBe('V');
    act(() => result.current[1]('Ve'));
    expect(result.current[0]).toBe('Ve');
    act(() => result.current[1]('Venue'));
    expect(result.current[0]).toBe('Venue');

    // Not committed yet — the whole point is not firing per keystroke.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits exactly once after typing pauses, with the final value', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDebouncedField<string>('', onCommit, 500));

    for (const ch of ['V', 'Ve', 'Ven', 'Venu', 'Venue']) {
      act(() => result.current[1](ch));
      act(() => vi.advanceTimersByTime(100)); // faster than the 500ms debounce
    }

    expect(onCommit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(500));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Venue');
  });

  it('adopts an external value change (e.g. switching events)', () => {
    const onCommit = vi.fn();
    const { result, rerender } = renderHook(
      ({ external }) => useDebouncedField(external, onCommit, 500),
      { initialProps: { external: 'Old Venue' } }
    );

    expect(result.current[0]).toBe('Old Venue');

    rerender({ external: 'New Venue From Server' });

    expect(result.current[0]).toBe('New Venue From Server');
  });

  it('cancels a pending commit if the value changes again before the delay elapses', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useDebouncedField<string>('', onCommit, 500));

    act(() => result.current[1]('first'));
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current[1]('second'));
    act(() => vi.advanceTimersByTime(400)); // 800ms since 'first', but only 400ms since 'second'

    expect(onCommit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(100));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('second');
  });

  it('flushes a pending edit on unmount instead of silently dropping it (FE-08)', () => {
    const onCommit = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedField<string>('', onCommit, 500));

    act(() => result.current[1]('Grand Ballroom'));
    // Unmounts (e.g. the user switched tabs) before the 500ms debounce fires.
    unmount();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Grand Ballroom');
  });

  it('does not flush on unmount when there is no pending edit', () => {
    const onCommit = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedField<string>('', onCommit, 500));

    act(() => result.current[1]('Committed Already'));
    act(() => vi.advanceTimersByTime(500));
    expect(onCommit).toHaveBeenCalledTimes(1);

    unmount();

    // No second, spurious commit from unmounting after the debounce already fired.
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
