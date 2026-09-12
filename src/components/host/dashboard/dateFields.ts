/**
 * Date and time fields for the host dashboard.
 *
 * A native `<input type="datetime-local">` displays its picker in whatever
 * format the OS/browser locale dictates (MM/DD/YYYY, AM/PM on an en-US
 * device) — the page's own language setting has no effect on it. This app's
 * couples and hosts expect DD.MM.YYYY and 24-hour time regardless of the
 * device, so the dashboard's date/time fields are fully custom text inputs
 * instead of the native widget, and these are the functions that make that
 * work.
 *
 * Pure, and extracted here from `HostDashboard.tsx` so they can be tested
 * without mounting the dashboard.
 */

export const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

export function formatDateDDMMYYYY(isoDate: string): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function formatTime24h(isoDate: string): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Keeps only digits typed so far and re-inserts the DD.MM.YYYY separators as they go. */
export function maskDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join('.');
}

/** Keeps only digits typed so far and re-inserts the HH:MM separator as they go. */
export function maskTimeInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  const parts = [digits.slice(0, 2), digits.slice(2, 4)].filter(Boolean);
  return parts.join(':');
}

/** Parses "DD.MM.YYYY" + "HH:MM" into a real Date, or null if either is incomplete/invalid. */
export function parseDateAndTime(dateText: string, timeText: string): Date | null {
  const dateMatch = dateText.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const timeMatch = timeText.match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;

  const [, dayStr, monthStr, yearStr] = dateMatch;
  const [, hourStr, minuteStr] = timeMatch;
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const parsed = new Date(year, month - 1, day, hour, minute);
  // Rejects e.g. 31.02.YYYY silently rolling over into March instead of erroring.
  if (parsed.getDate() !== day || parsed.getMonth() !== month - 1) return null;

  return parsed;
}
