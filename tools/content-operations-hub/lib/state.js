import {
  filterAndSortPages,
  filterPagesBySearch,
} from './page-history.js';
import { resolveContentFolderPath } from './paths.js';

/** @typedef {{ kind: 'folder', name: string, folderPath: string }} FolderEntry */
/** @typedef {{ kind: 'document', helixPath: string, sourcePath: string, name: string }} DocumentEntry */
/** @typedef {'preview'|'live'|'unpreview'|'unpublish'|'delete'|'open-da'|'open-preview'|'open-live'} PageOperationId */

export const SEARCH_MIN_LEN = 3;

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
    /** True after the first successful content list load in this session. */
    initialContentLoaded: false,
    /** True until the workspace is shown for the first time this session. */
    firstSessionLoad: true,
    /** True while the first-session status fetch runs without locking the UI. */
    statusFetchBackground: false,
    /** False until the first deployment status fetch in this session has finished. */
    hasCompletedInitialStatusFetch: false,
    error: null,
    status: null,
    statusType: 'info',
    jobDetail: null,
    pageFilter: 'all',
    pageSearch: '',
    folderSearch: '',
    /** True after a successful status check for the current page set. */
    statusFetched: false,
    platformStatus: {},
    statusCheckFailed: false,
    statusError: null,
    statusChecking: false,
    /** True while silently refreshing cached deployment status from the API. */
    statusRevalidating: false,
    statusCancelled: false,
    statusProgressDone: 0,
    statusProgressTotal: 0,
    /** @type {number | null} */
    statusFetchedAt: null,
    statusFetchedFromCache: false,
    /** @type {number | null} */
    statusFetchStartedAt: null,
    /** @type {string | null} */
    statusPanelNote: null,
    /** @type {AbortController | null} */
    statusAbort: null,
    /** @type {AbortController | null} */
    statusRevalidateAbort: null,
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
  state.initialContentLoaded = false;
  state.firstSessionLoad = true;
  state.statusFetchBackground = false;
  state.hasCompletedInitialStatusFetch = false;
  state.error = null;
  state.status = null;
  state.statusType = 'info';
  state.jobDetail = null;
  state.pageFilter = 'all';
  state.pageSearch = '';
  state.folderSearch = '';
  state.statusFetched = false;
  state.platformStatus = {};
  state.statusCheckFailed = false;
  state.statusError = null;
  state.statusChecking = false;
  state.statusRevalidating = false;
  state.statusCancelled = false;
  state.statusProgressDone = 0;
  state.statusProgressTotal = 0;
  state.statusFetchedAt = null;
  state.statusFetchedFromCache = false;
  state.statusFetchStartedAt = null;
  state.statusPanelNote = null;
  state.jobStartedAt = null;
  state.jobProgressProcessed = 0;
  state.jobProgressTotal = 0;
  state.jobTopic = null;
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
 */
export function cancelStatusRevalidate(state) {
  if (state.statusRevalidateAbort) {
    state.statusRevalidateAbort.abort();
    state.statusRevalidateAbort = null;
  }
  state.statusRevalidating = false;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {boolean} [setMessage]
 */
export function cancelStatusCheck(state, setMessage = true) {
  cancelStatusRevalidate(state);
  if (state.statusAbort) {
    state.statusAbort.abort();
    state.statusAbort = null;
  }
  if (!state.statusChecking) return;
  state.statusChecking = false;
  state.statusFetchBackground = false;
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
 * Resets page scope and the preview/publish checkbox (e.g. when opening another folder).
 * @param {ReturnType<typeof createAppState>} state
 */
export function resetPagesViewState(state) {
  state.pageScope = 'folder';
}

/**
 * Clears selection, filters, search, and the preview/publish checkbox after a page operation starts.
 * @param {ReturnType<typeof createAppState>} state
 */
export function clearPageWorkspaceAfterOperation(state) {
  state.selected.clear();
  state.pageFilter = 'all';
  state.pageSearch = '';
  state.folderSearch = '';
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
 * Status fetch blocks interactions (selection, filters, DA links) when foreground.
 * @param {ReturnType<typeof createAppState>} state
 */
export function isStatusFetchBlocking(state) {
  return state.statusChecking && !state.statusFetched && !state.statusFetchBackground;
}

/**
 * Status fetch blurs the workspace and shows the inline progress bar when foreground.
 * @param {ReturnType<typeof createAppState>} state
 */
export function isStatusFetchLockingUi(state) {
  return state.statusChecking && state.statusProgressTotal > 0 && !state.statusFetchBackground;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
export function isStatusLoaded(state) {
  if (state.statusCheckFailed) return false;
  return Boolean(state.statusFetched && state.pages.length > 0);
}

/**
 * Deployment status is still loading for the current page set (no trustworthy dots/counts yet).
 * @param {ReturnType<typeof createAppState>} state
 */
export function isDeploymentStatusPending(state) {
  return state.pages.length > 0 && state.statusChecking && !state.statusFetched;
}

/**
 * First session: centered loader until the first deployment status fetch completes.
 * @param {ReturnType<typeof createAppState>} state
 */
export function isFirstSessionStatusPending(state) {
  if (state.hasCompletedInitialStatusFetch || state.pages.length === 0) return false;
  return !state.statusFetched;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
export function markInitialStatusFetchComplete(state) {
  state.hasCompletedInitialStatusFetch = true;
  state.firstSessionLoad = false;
  state.contentLoading = false;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
export function shouldShowPageStatus(state) {
  return isStatusLoaded(state);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
export function getVisiblePages(state) {
  const statusMap = buildStatusMap(state);
  const browseFolder = resolveContentFolderPath(state.folderPath);
  const filterId = String(state.pageFilter || 'all');
  let visible = filterAndSortPages(
    state.pages,
    statusMap,
    filterId,
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
  const activeCount = getActiveSelectionCount(state);
  const totalCount = state.pages.length;
  return `${activeCount} selected out of ${totalCount}`;
}
