// FE-06 — addPhoto() resolves as soon as the optimistic local copy is saved,
// deliberately not waiting on the network so the UI stays responsive and
// failed uploads can fall back to the offline queue. A bulk capture (up to
// MAX_BULK_UPLOAD_FILES=10 in CameraCaptureModal) fires one addPhoto() per
// file back-to-back, and each call's full-resolution `originalUrl` base64
// string stays alive in its own in-flight request closure until that
// request settles — with nothing pacing them, all 10 could be in flight
// (and resident in memory) at once, enough to get a mobile tab OOM-killed
// on venue Wi-Fi. This throttles the actual backend call to one at a time
// without changing when addPhoto() itself resolves for any caller.
let activePhotoUploads = 0;
const queuedPhotoUploads: (() => void)[] = [];
const MAX_CONCURRENT_PHOTO_UPLOADS = 1;

export function runThrottledPhotoUpload(task: () => Promise<void>): void {
  const start = () => {
    activePhotoUploads++;
    task().finally(() => {
      activePhotoUploads--;
      const next = queuedPhotoUploads.shift();
      if (next) next();
    });
  };
  if (activePhotoUploads < MAX_CONCURRENT_PHOTO_UPLOADS) {
    start();
  } else {
    queuedPhotoUploads.push(start);
  }
}
