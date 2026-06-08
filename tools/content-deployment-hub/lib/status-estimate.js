/** Matches fetchStatusParallel in api.js */
const BATCH_SIZE = 10;
const BATCH_PAUSE_SEC = 0.12;
const BULK_MIN_PAGES = 3;

/** Typical seconds per parallel batch (10 concurrent AEM calls). */
const BATCH_SEC_OPTIMISTIC = 1.7;
const BATCH_SEC_PESSIMISTIC = 3.1;

/** Single bulk status request before per-page fallback. */
const BULK_SEC_OPTIMISTIC = 4;
const BULK_SEC_PESSIMISTIC = 8;

/**
 * Share of pages that still need per-page checks after bulk (varies by site).
 * @param {number} pageCount
 * @param {'optimistic' | 'pessimistic'} mode
 */
function remainingAfterBulkRatio(pageCount, mode) {
  if (mode === 'optimistic') {
    if (pageCount <= 20) return 0.1;
    if (pageCount <= 80) return 0.2;
    return 0.28;
  }
  if (pageCount <= 20) return 0.35;
  if (pageCount <= 80) return 0.5;
  return 0.65;
}

/**
 * @param {number} pageCount
 * @param {'optimistic' | 'pessimistic'} mode
 */
function estimateParallelSeconds(pageCount, mode) {
  if (pageCount <= 0) return 0;
  const perBatch = mode === 'optimistic' ? BATCH_SEC_OPTIMISTIC : BATCH_SEC_PESSIMISTIC;
  const batches = Math.ceil(pageCount / BATCH_SIZE);
  const batched = batches * perBatch + Math.max(0, batches - 1) * BATCH_PAUSE_SEC;
  const perPageFloor = mode === 'optimistic' ? 0.14 : 0.42;
  return Math.max(batched, pageCount * perPageFloor);
}

/**
 * @param {number} pageCount
 * @param {'optimistic' | 'pessimistic'} mode
 */
export function estimateStatusFetchSeconds(pageCount, mode = 'optimistic') {
  const n = Math.max(0, Math.floor(pageCount));
  if (n === 0) return 0;
  if (n < BULK_MIN_PAGES) return estimateParallelSeconds(n, mode);
  const bulk = mode === 'optimistic' ? BULK_SEC_OPTIMISTIC : BULK_SEC_PESSIMISTIC;
  const remaining = Math.max(0, Math.ceil(n * remainingAfterBulkRatio(n, mode)));
  return bulk + estimateParallelSeconds(remaining, mode);
}

/**
 * @param {number} seconds
 */
export function formatDurationSeconds(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} sec`;
  const mins = Math.round(s / 60);
  if (mins < 60) return mins === 1 ? '1 min' : `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (rem === 0) return hours === 1 ? '1 hr' : `${hours} hr`;
  return `${hours} hr ${rem} min`;
}

/**
 * @param {number} pageCount
 */
export function formatStatusFetchEta(pageCount) {
  const n = Math.max(0, Math.floor(pageCount));
  if (n === 0) return null;
  const minSec = estimateStatusFetchSeconds(n, 'optimistic');
  const maxSec = estimateStatusFetchSeconds(n, 'pessimistic');
  if (maxSec - minSec < 20) {
    return `~${formatDurationSeconds((minSec + maxSec) / 2)}`;
  }
  return `~${formatDurationSeconds(minSec)}–${formatDurationSeconds(maxSec)}`;
}

/**
 * @param {number} startedAt
 * @param {number} done
 * @param {number} total
 */
export function formatRuntimeStatusEta(startedAt, done, total) {
  if (!startedAt || total <= 0 || done <= 0 || done >= total) {
    if (done >= total && total > 0) return 'Finishing up…';
    return null;
  }
  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed < 2 || done < 3) return null;
  const remainingSec = ((total - done) * elapsed) / done;
  if (remainingSec < 8) return 'Less than 10 sec remaining';
  return `About ${formatDurationSeconds(remainingSec)} remaining`;
}
