/**
 * Why a camera or microphone would not start, as a message key (N-124).
 *
 * The browser's own message was shown when the camera failed for any reason
 * but a refusal — in English, whatever the app's language ("Requested device
 * not found", "Camera already in use") — and the microphone reported every
 * failure as a refusal, sending a guest with no microphone to browser settings
 * that could not help. The browser names the reason; the app says it.
 */
export function mediaErrorKey(err: unknown, device: 'camera' | 'mic'): string {
  const name = err instanceof Error || (typeof err === 'object' && err !== null && 'name' in err)
    ? String((err as { name?: unknown }).name)
    : '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return device === 'camera' ? 'camera.permission_subtitle' : 'audio.mic_permission_error';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return device === 'camera' ? 'camera.error_not_found' : 'audio.mic_not_found';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return device === 'camera' ? 'camera.error_busy' : 'audio.mic_busy';
  }
  return device === 'camera' ? 'camera.error_generic' : 'audio.mic_error_generic';
}
