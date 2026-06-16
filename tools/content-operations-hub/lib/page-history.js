import {
  formatPageListLabel,
  pageListRelativePath,
  sortPagesByListPath,
} from './paths.js';

/**
 * @typedef {{ previewedAt?: number, publishedAt?: number }} PageHistoryEntry
 * @typedef {Record<string, PageHistoryEntry>} HistoryMap
 */

/**
 * @param {PageHistoryEntry | undefined} entry
 * @returns {'published'|'previewed'|'untouched'}
 */
export function getPageStatus(entry) {
  if (entry?.publishedAt) return 'published';
  if (entry?.previewedAt) return 'previewed';
  return 'untouched';
}

/**
 * @param {Record<string, PageHistoryEntry>} platformStatus
 * @param {{ helixPath: string }[]} pageList
 * @returns {HistoryMap}
 */
function historyMapFrom(platformStatus, pageList) {
  /** @type {HistoryMap} */
  const map = {};
  pageList.forEach((p) => {
    map[p.helixPath] = platformStatus[p.helixPath] || {};
  });
  return map;
}

/**
 * @param {HistoryMap} statusMap
 * @param {{ helixPath: string }[]} pageList
 * @returns {{
 *   preview: number,
 *   live: number,
 *   none: number,
 *   previewed: number,
 *   orphanedLive: number,
 * }}
 */
export function countStatusBreakdown(statusMap, pageList) {
  let preview = 0;
  let live = 0;
  let none = 0;
  let previewed = 0;
  let orphanedLive = 0;
  pageList.forEach((p) => {
    const e = statusMap[p.helixPath];
    if (e?.publishedAt) {
      live += 1;
      if (e.previewedAt) previewed += 1;
      else orphanedLive += 1;
    } else if (e?.previewedAt) {
      preview += 1;
      previewed += 1;
    } else {
      none += 1;
    }
  });
  return {
    preview, live, none, previewed, orphanedLive,
  };
}

/**
 * @param {Record<string, PageHistoryEntry>} platformStatus
 * @param {{ helixPath: string }[]} pageList
 */
export function formatDeploymentSummary(platformStatus, pageList) {
  const {
    live, preview, none, orphanedLive,
  } = countStatusBreakdown(
    historyMapFrom(platformStatus, pageList),
    pageList,
  );
  return `${live} published · ${orphanedLive} published without preview · ${preview} preview only · ${none} not deployed (${pageList.length} total)`;
}

/** @type {ReadonlyArray<[string, string]>} */
export const PAGE_FILTERS = [
  ['all', 'All pages'],
  ['never-previewed', 'Not deployed (not previewed)'],
  ['never-published', 'Not published'],
  ['preview-only', 'Preview only'],
  ['orphaned-live', 'Published without preview'],
  ['recent-preview', 'Recently previewed'],
  ['recent-publish', 'Recently published'],
  ['oldest-preview', 'Oldest previewed'],
  ['oldest-publish', 'Oldest published'],
];

const DATE_SORT_FILTERS = new Set([
  'recent-preview',
  'recent-publish',
  'oldest-preview',
  'oldest-publish',
]);

/**
 * Filter pages by search query (page name / list label). Requires at least minLen characters.
 * @param {{ helixPath: string, name?: string }[]} pages
 * @param {string} query
 * @param {string} [browseFolder]
 * @param {number} [minLen]
 * @returns {{ helixPath: string, name?: string }[]}
 */
export function filterPagesBySearch(
  pages,
  query,
  browseFolder = '',
  minLen = 3,
) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return pages;
  if (q.length < minLen) return pages;
  return pages.filter((page) => {
    const name = String(page.name || '').toLowerCase();
    const path = pageListRelativePath(
      page.helixPath,
      browseFolder,
    ).toLowerCase();
    const { title } = formatPageListLabel(
      page.helixPath,
      page.name,
      browseFolder,
    );
    return (
      name.includes(q) || path.includes(q) || title.toLowerCase().includes(q)
    );
  });
}

export function filterAndSortPages(
  pages,
  history,
  filterId,
  browseFolder = '',
) {
  if (filterId === 'all') return sortPagesByListPath(pages, browseFolder);

  const withMeta = pages.map((page) => ({
    page,
    entry: history[page.helixPath] || {},
  }));

  /** @type {typeof withMeta} */
  let filtered;

  switch (filterId) {
    case 'never-previewed':
      filtered = withMeta.filter((m) => !m.entry.previewedAt);
      break;
    case 'never-published':
      filtered = withMeta.filter((m) => !m.entry.publishedAt);
      break;
    case 'preview-only':
      filtered = withMeta.filter((m) => m.entry.previewedAt && !m.entry.publishedAt);
      break;
    case 'orphaned-live':
      filtered = withMeta.filter((m) => m.entry.publishedAt && !m.entry.previewedAt);
      break;
    case 'recent-preview':
      filtered = withMeta.filter((m) => m.entry.previewedAt);
      filtered.sort(
        (a, b) => (b.entry.previewedAt || 0) - (a.entry.previewedAt || 0),
      );
      break;
    case 'recent-publish':
      filtered = withMeta.filter((m) => m.entry.publishedAt);
      filtered.sort(
        (a, b) => (b.entry.publishedAt || 0) - (a.entry.publishedAt || 0),
      );
      break;
    case 'oldest-preview':
      filtered = withMeta.filter((m) => m.entry.previewedAt);
      filtered.sort(
        (a, b) => (a.entry.previewedAt || 0) - (b.entry.previewedAt || 0),
      );
      break;
    case 'oldest-publish':
      filtered = withMeta.filter((m) => m.entry.publishedAt);
      filtered.sort(
        (a, b) => (a.entry.publishedAt || 0) - (b.entry.publishedAt || 0),
      );
      break;
    default:
      return sortPagesByListPath(pages, browseFolder);
  }

  const result = filtered.map((m) => m.page);
  if (!DATE_SORT_FILTERS.has(filterId)) {
    return sortPagesByListPath(result, browseFolder);
  }
  return result;
}

/**
 * Unambiguous worldwide offset label, e.g. UTC+05:30 or UTC-07:00.
 * @param {Date} date
 * @returns {string}
 */
export function formatUtcOffset(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const mins = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${mins}`;
}

/**
 * @param {number | undefined} ts
 * @returns {string}
 */
export function formatStatusDate(ts) {
  if (!ts) return '';
  const dt = new Date(ts);
  return dt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Column header for the last-deployed date column (UTC shown once for all rows).
 * @returns {string}
 */
export function formatLastDeployedColumnLabel() {
  return `Last deployed (${formatUtcOffset(new Date())})`;
}

/**
 * Compact label for “Last updated” — time only when today, always with UTC offset.
 * @param {number | null | undefined} ts
 * @returns {string}
 */
export function formatStatusFetchedAt(ts) {
  if (!ts || Number.isNaN(ts)) return '';
  const dt = new Date(ts);
  const now = new Date();
  const offset = formatUtcOffset(dt);
  const time = dt.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (dt.toDateString() === now.toDateString()) {
    return `${time} ${offset}`;
  }
  const date = dt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(dt.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${date}, ${time} ${offset}`;
}

/**
 * @param {'published'|'previewed'|'untouched'} status
 * @returns {string}
 */
export function statusLabel(status) {
  if (status === 'published') return 'Published';
  if (status === 'previewed') return 'Preview only';
  return 'Not deployed';
}
