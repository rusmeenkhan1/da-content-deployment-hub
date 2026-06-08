import {
  filterAndSortPages,
  filterPagesBySearch,
} from './page-history.js';
import { resolveContentFolderPath } from './paths.js';

/** @typedef {{ kind: 'folder', name: string, folderPath: string }} FolderEntry */
/** @typedef {{ kind: 'document', helixPath: string, sourcePath: string, name: string }} DocumentEntry */

export const SEARCH_MIN_LEN = 3;

/**
 * @typedef {{
 *   topic: 'preview' | 'live',
 *   paths: string[],
 *   urls: string[],
 *   host: string,
 *   title: string,
 *   completedAt: number,
 * }} LastOperation
 */

/**
 * @param {{ org: string, site: string, ref: string }} ctx
 */
export function createAppState(ctx) {
  return {
    root: null,
    org: ctx.org,
    site: ctx.site,
    ref: ctx.ref,
    folderPath: '',
    pageScope: 'folder',
    loading: false,
    contentLoading: false,
    error: null,
    status: null,
    statusType: 'info',
    jobDetail: null,
    activeTab: 'pages',
    pageFilter: 'all',
    pageSearch: '',
    folderSearch: '',
    /** When false, Fetch loads pages/folders only — no AEM status API calls. */
    fetchStatus: false,
    /** True after a successful status check for the current page set. */
    statusFetched: false,
    platformStatus: {},
    statusCheckFailed: false,
    statusError: null,
    statusChecking: false,
    statusCancelled: false,
    statusProgressDone: 0,
    statusProgressTotal: 0,
    /** @type {number | null} */
    statusFetchStartedAt: null,
    /** @type {LastOperation | null} */
    lastOperation: null,
    /** @type {AbortController | null} */
    statusAbort: null,
    /** @type {AbortController | null} */
    jobAbort: null,
    /** @type {number | null} */
    jobStartedAt: null,
    jobProgressProcessed: 0,
    jobProgressTotal: 0,
    /** @type {'preview'|'live'|'unpreview'|'unpublish'|'delete'|null} */
    jobTopic: null,
    /** @type {FolderEntry[]} */
    folders: [],
    /** @type {DocumentEntry[]} */
    pages: [],
    /** @type {Set<string>} */
    selected: new Set(),
  };
}

/**
 * Full reset on browser reload — empty workspace.
 * @param {ReturnType<typeof createAppState>} state
 */
export function resetWorkspace(state) {
  state.folderPath = '';
  state.pageScope = 'folder';
  state.loading = false;
  state.contentLoading = false;
  state.error = null;
  state.status = null;
  state.statusType = 'info';
  state.jobDetail = null;
  state.activeTab = 'pages';
  state.pageFilter = 'all';
  state.pageSearch = '';
  state.folderSearch = '';
  state.fetchStatus = false;
  state.statusFetched = false;
  state.platformStatus = {};
  state.statusCheckFailed = false;
  state.statusError = null;
  state.statusChecking = false;
  state.statusCancelled = false;
  state.statusProgressDone = 0;
  state.statusProgressTotal = 0;
  state.statusFetchStartedAt = null;
  state.jobStartedAt = null;
  state.jobProgressProcessed = 0;
  state.jobProgressTotal = 0;
  state.jobTopic = null;
  state.lastOperation = null;
  state.folders = [];
  state.pages = [];
  state.selected.clear();
  cancelStatusCheck(state, false);
  cancelBulkJob(state, false);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {boolean} [setMessage]
 */
export function cancelBulkJob(state, setMessage = true) {
  if (state.jobAbort) {
    state.jobAbort.abort();
  }
  if (!state.loading) return;
  state.loading = false;
  state.jobStartedAt = null;
  if (setMessage) {
    state.status = 'Bulk preview/publish stopped. The server job may still be running.';
    state.statusType = 'info';
  }
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {boolean} [setMessage]
 */
export function cancelStatusCheck(state, setMessage = true) {
  if (state.statusAbort) {
    state.statusAbort.abort();
    state.statusAbort = null;
  }
  if (!state.statusChecking) return;
  state.statusChecking = false;
  state.statusFetchStartedAt = null;
  if (setMessage) {
    const checked = state.statusProgressDone;
    const total = state.statusProgressTotal;
    state.statusCancelled = true;
    state.status = checked > 0
      ? `Status check stopped · ${checked} of ${total} pages checked (partial results kept)`
      : 'Status check cancelled before any pages were checked';
    state.statusType = 'info';
  }
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
export function buildStatusMap(state) {
  const platform = state.platformStatus || {};
  /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */
  const map = {};
  state.pages.forEach((page) => {
    map[page.helixPath] = platform[page.helixPath] || {};
  });
  return map;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
export function isStatusLoaded(state) {
  if (state.statusCheckFailed || state.statusChecking) return false;
  return Boolean(state.statusFetched && state.pages.length > 0);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
export function getVisiblePages(state) {
  const statusMap = buildStatusMap(state);
  const browseFolder = resolveContentFolderPath(state.folderPath);
  let visible = filterAndSortPages(
    state.pages,
    statusMap,
    String(state.pageFilter || 'all'),
    browseFolder,
  );
  visible = /** @type {DocumentEntry[]} */ (filterPagesBySearch(
    visible,
    String(state.pageSearch || ''),
    browseFolder,
    SEARCH_MIN_LEN,
  ));
  return { visible, statusMap, browseFolder };
}

/**
 * @param {{ name: string, folderPath: string }[]} folders
 * @param {string} query
 * @param {number} [minLen]
 */
export function filterFoldersBySearch(folders, query, minLen = SEARCH_MIN_LEN) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || q.length < minLen) return folders;
  return folders.filter((f) => (
    f.name.toLowerCase().includes(q) || f.folderPath.toLowerCase().includes(q)
  ));
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
export function getVisibleFolders(state) {
  return filterFoldersBySearch(state.folders, state.folderSearch, SEARCH_MIN_LEN);
}

/**
 * Selected pages that exist in the current page list.
 * @param {ReturnType<typeof createAppState>} state
 */
export function getActiveSelectionCount(state) {
  const pagePaths = new Set(state.pages.map((p) => p.helixPath));
  let count = 0;
  state.selected.forEach((path) => {
    if (pagePaths.has(path)) count += 1;
  });
  return count;
}

/**
 * Helix paths currently selected and present in the loaded page list.
 * @param {ReturnType<typeof createAppState>} state
 * @returns {string[]}
 */
export function getSelectedHelixPaths(state) {
  const pagePaths = new Set(state.pages.map((p) => p.helixPath));
  return [...state.selected].filter((path) => pagePaths.has(path));
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {boolean} checked
 */
export function selectAllVisible(state, checked) {
  const { visible } = getVisiblePages(state);
  if (checked) {
    visible.forEach((p) => state.selected.add(p.helixPath));
  } else {
    visible.forEach((p) => state.selected.delete(p.helixPath));
  }
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
export function formatSelectionPillText(state) {
  const { visible } = getVisiblePages(state);
  const activeCount = getActiveSelectionCount(state);
  const visibleCount = visible.length;
  const totalCount = state.pages.length;
  if (activeCount === 0) {
    return visibleCount === totalCount
      ? `No pages selected · ${totalCount} in list`
      : `No pages selected · ${visibleCount} shown (${totalCount} total)`;
  }
  if (visibleCount === totalCount) {
    return `${activeCount} of ${totalCount} selected`;
  }
  const visibleSelected = visible.filter((p) => state.selected.has(p.helixPath)).length;
  return `${activeCount} selected · ${visibleSelected} of ${visibleCount} shown`;
}
