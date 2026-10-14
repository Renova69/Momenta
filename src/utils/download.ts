/** How long a saved local copy stays addressable; revoking at once can cancel the save. */
const LOCAL_COPY_TTL_MS = 60_000;

function saveFrom(href: string, filename: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Save an image to the device without leaving the page (N-114).
 *
 * An `<a download>` pointing at the image only works on the page's own origin;
 * photos live on another (the API in development, R2 in production), where
 * browsers ignore `download` and navigate the tab to the bare JPEG — the guest
 * left the album to save one photo. The image is fetched and saved from a
 * local copy instead. When its host refuses the fetch (no CORS), it opens in a
 * new tab, which the guest can save from, and the album stays where it was.
 * `data:` and `blob:` URLs are already local and are saved directly.
 */
export async function downloadImage(url: string, filename: string): Promise<void> {
  if (/^(data:|blob:)/i.test(url)) {
    saveFrom(url, filename);
    return;
  }
  try {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const localCopy = URL.createObjectURL(await response.blob());
    saveFrom(localCopy, filename);
    setTimeout(() => URL.revokeObjectURL(localCopy), LOCAL_COPY_TTL_MS);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
