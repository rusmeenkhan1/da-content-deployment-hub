/**
 * @param {number} seconds
 */
function formatDurationSeconds(seconds) {
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
