/* eslint-disable no-use-before-define, prefer-destructuring, no-void, no-shadow, no-console, no-unused-vars, no-unused-expressions, operator-linebreak, max-len */

import {
  collectPages,
  deleteDaDocumentsSequential,
  fetchPlatformStatusForPaths,
  wrapDaFetch,
  messageFromApiError,
  permissionErrorHint,
  getJobPollUrl,
  listFolderEntries,
  pollJob,
  resolveJobOutcome,
  runBulkRemoveJob,
  startBulkJob,
  DA_LOGIN_REQUIRED_MESSAGE,
  DA_SITE_CONTEXT_MESSAGE,
  isDaAccessError,
  isStatusPermissionError,
  STATUS_ACCESS_DENIED_MESSAGE,
} from './lib/api.js';
import {
  readBrowseLocation,
  writeBrowseLocation,
} from './lib/browse-persist.js';
import {
  displayFolderPath,
  formatPageListLabel,
  normalizeFolderPath,
  resolveContentFolderPath,
} from './lib/paths.js';
import {
  buildOptimisticStatusPatch,
  commitPlatformStatus,
  getLatestCachedStatusCheckedAt,
  getUncachedHelixPaths,
  hasCompleteCachedStatus,
  hydratePlatformStatusFromCache,
  persistCurrentPlatformStatus,
  removePathsFromStatusCache,
} from './lib/status-cache.js';
import {
  buildDaEditUrl,
  buildSiteHost,
  buildUrlsForPaths,
} from './lib/urls.js';
import {
  formatStatusDate,
  getPageStatus,
  PAGE_FILTERS,
  countStatusBreakdown,
  statusLabel,
} from './lib/page-history.js';
import {
  confirmBulkRun,
  confirmDestructiveAction,
  confirmOpenUrlsInNewTabs,
} from './lib/modal.js';
import {
  copyTextToClipboard,
  openUrlsInNewTabsQuiet,
  shouldWarnPopupBlock,
} from './lib/ui-utils.js';
import {
  closeJobModal,
  closeProgressModal,
  isJobModalOpen,
  isProgressModalOpen,
  openJobModal,
  showJobCancelledModal,
  showJobCompleteModal,
  showJobErrorModal,
  updateJobModal,
} from './lib/progress-modal.js';
import { formatRuntimeStatusEta } from './lib/status-estimate.js';
import {
  bindSearchInput,
  buildSearchField,
  patchFolderSearchResults,
  patchPageSearchResults,
  searchHintText,
  syncSelectionUI,
} from './lib/search-ui.js';
import {
  cancelBulkJob,
  cancelStatusCheck,
  cancelStatusRevalidate,
  clearPageWorkspaceAfterOperation,
  createAppState,
  formatSelectionPillText,
  getActiveSelectionCount,
  getSelectedHelixPaths,
  getVisiblePages,
  getVisibleFolders,
  isDeploymentStatusPending,
  isFirstSessionStatusPending,
  isStatusFetchBlocking,
  isStatusFetchLockingUi,
  markInitialStatusFetchComplete,
  shouldShowPageStatus,
  resetWorkspace,
  SEARCH_MIN_LEN,
  resetPagesViewState,
  selectAllVisible,
} from './lib/state.js';
import { el } from './lib/dom.js';

/* ========================================
   CONFIGURATION & CONSTANTS
   ======================================== */

/** @typedef {'preview'|'live'|'unpreview'|'unpublish'|'delete'} JobTopic */

/**
 * @param {JobTopic | null | undefined} topic
 */
function jobActionLabel(topic) {
  if (topic === 'delete') return 'delete';
  if (topic === 'unpublish') return 'unpublish';
  if (topic === 'unpreview') return 'unpreview';
  if (topic === 'live') return 'publish';
  return 'preview';
}

/**
 * @param {'unpreview'|'unpublish'|'delete'} action
 * @param {number} count
 */
function destructiveStartMessage(action, count) {
  const noun = count === 1 ? 'page' : 'pages';
  if (action === 'delete') return `Starting delete for ${count} ${noun}…`;
  if (action === 'unpublish') return `Starting unpublish for ${count} ${noun}…`;
  return `Starting unpreview for ${count} ${noun}…`;
}

/** @type {Record<'untouched'|'previewed'|'published', string>} */
const STATUS_COLOR = {
  untouched: '#c9252d',
  previewed: '#d6ad00',
  published: '#2d8a4e',
};

const SDK_URL = 'https://da.live/nx/utils/sdk.js';
const SDK_TIMEOUT_MS = 8000;
let copyToastTimer = 0;

const APP_TITLE = 'Content Operations Hub';
const APP_DESCRIPTION = 'Browse folders, select pages, and run bulk preview, publish, or removal at the current directory level.';

/** @type {ReadonlyArray<[keyof typeof STATUS_COLOR, string]>} */
const STATUS_LEGEND_ITEMS = [
  ['untouched', 'Not previewed'],
  ['previewed', 'Preview only'],
  ['published', 'Published'],
];

/** @typedef {import('./lib/state.js').PageOperationId} PageOperationId */

/** @type {{ id: PageOperationId, label: string, variant: 'deploy' | 'primary' }[]} */
const SELECTION_STRIP_OPS = [
  { id: 'preview', label: 'Preview', variant: 'deploy' },
  { id: 'live', label: 'Publish', variant: 'primary' },
];

/** @type {{ title: string, items: { id: PageOperationId, label: string, danger?: boolean }[] }[]} */
const MORE_SELECTION_GROUPS = [
  {
    title: 'Navigation',
    items: [
      { id: 'open-da', label: 'Open in DA' },
      { id: 'open-preview', label: 'Open preview URLs (.page)' },
      { id: 'open-live', label: 'Open publish URLs (.live)' },
    ],
  },
  {
    title: 'Performance',
    items: [
      { id: 'check-lhs-page', label: 'LHS score for .page URL' },
      { id: 'check-lhs-live', label: 'LHS score for .live URL' },
    ],
  },
  {
    title: 'Publishing',
    items: [
      { id: 'unpreview', label: 'Remove from preview' },
      { id: 'unpublish', label: 'Remove from publish' },
    ],
  },
  {
    title: 'Danger zone',
    items: [
      { id: 'delete', label: 'Delete from DA', danger: true },
    ],
  },
];

/** @type {Record<string, string>} */
const SELECTION_OP_ICONS = {
  preview:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8s2.2-4 5.5-4 5.5 4 5.5 4-2.2 4-5.5 4-5.5-4-5.5-4Z"/><circle cx="8" cy="8" r="1.75"/></svg>',
  live: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V3.5M5 6.5 8 3.5 11 6.5"/><path d="M3.5 12.5h9"/></svg>',
  unpreview:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l10 10M6.2 6.2A3.5 3.5 0 0 0 8 11.5a3.5 3.5 0 0 0 1.8-.5"/><path d="M2.5 8s2.2-4 5.5-4c.7 0 1.3.1 1.8.3"/></svg>',
  unpublish:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 11h11M5 11V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V11"/><path d="M6.5 8h3"/></svg>',
  delete:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5h9M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5.5 4.5l.5 8.5a1 1 0 0 0 1 .9h2a1 1 0 0 0 1-.9l.5-8.5"/></svg>',
  'open-da':
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6.5L9.5 2.5Z"/><path d="M9.5 2.5V6.5H13M6 9.5h4M6 11.5h2.5"/></svg>',
  'open-preview':
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5a8 8 0 0 1 0 11M8 2.5a8 8 0 0 0 0 11"/></svg>',
  'open-live':
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5l1.6 3.2 3.6.5-2.6 2.5.6 3.6L8 10.4l-3.2 1.7.6-3.6-2.6-2.5 3.6-.5L8 2.5Z"/></svg>',
  share:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 8.2 9.6 6.4M6.5 7.8l3.1 1.8"/><circle cx="4.6" cy="8" r="1.7"/><circle cx="11.6" cy="4" r="1.7"/><circle cx="11.6" cy="12" r="1.7"/></svg>',
  'check-lhs-page':
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14h12M8 1v10M4 7l4-6 4 6"/></svg>',
  'check-lhs-live':
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14h12M8 1v10M4 7l4-6 4 6"/></svg>',
  more: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12" cy="8" r="1"/></svg>',
};

/**
 * @param {string} operationId
 */
function buildSelectionOpIcon(operationId) {
  const icon = el('span', 'bulk-pp-selection-op-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = SELECTION_OP_ICONS[operationId] || '';
  return icon;
}

/* ========================================
   DOM UTILITIES
   ======================================== */

/**
 * Sets accessibility label and title for consistent a11y across elements
 * @param {HTMLElement} element
 * @param {string} label
 * @returns {HTMLElement}
 */
function setAccessibilityLabel(element, label) {
  element.setAttribute('aria-label', label);
  element.title = label;
  return element;
}

/**
 * Safely query element by selector and type
 * @template {HTMLElement} T
 * @param {HTMLElement | null} root
 * @param {string} selector
 * @param {new(...args: any[]) => T} [constructor]
 * @returns {T | null}
 */
function safeQuery(root, selector, constructor = HTMLElement) {
  if (!root) return null;
  const element = root.querySelector(selector);
  return element instanceof constructor ? element : null;
}

/**
 * Clear an input element's value safely
 * @param {HTMLElement | null} root
 * @param {string} selector
 */
function clearInputValue(root, selector) {
  const input = safeQuery(root, selector, HTMLInputElement);
  if (input) input.value = '';
}

/**
 * Safely clears filter select to 'all' option
 * @param {HTMLElement | null} root
 */
function clearFilterSelect(root) {
  const filterSelect = safeQuery(
    root,
    '#bulk-pp-page-filter',
    HTMLSelectElement,
  );
  if (filterSelect) filterSelect.value = 'all';
}

/**
 * @param {string} [message]
 */
function buildDaAccessErrorPanel(message = DA_LOGIN_REQUIRED_MESSAGE) {
  const wrap = el('div', 'bulk-pp-da-access-error');
  wrap.append(
    el('h3', 'bulk-pp-da-access-error-title', 'Sign in required'),
    el('p', 'bulk-pp-da-access-error-lead', message),
  );
  return wrap;
}

async function initSdk() {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('DA SDK not available')), SDK_TIMEOUT_MS);
  });
  try {
    const mod = await import(SDK_URL);
    const sdk = await Promise.race([mod.default, timeout]);
    const { context = {}, actions = {} } = sdk;
    return { context, actions };
  } catch {
    return {
      context: {
        org: 'local-org',
        repo: 'local-repo',
        ref: 'main',
        path: '',
      },
      actions: {},
    };
  }
}

/**
 * @param {Record<string, string>} context
 */
function resolveSiteContext(context) {
  let org = String(context.org || context.owner || '').trim();
  let site = String(context.repo || context.site || '').trim();
  const ref = context.ref || 'main';
  const appMatch = window.location.pathname.match(/\/app\/([^/]+)\/([^/]+)/);
  if (appMatch) {
    const [, matchedOrg, matchedSite] = appMatch;
    if (!org) org = matchedOrg;
    if (!site) site = matchedSite;
  }
  return { org, site, ref };
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function syncBrowseLocation(state) {
  const {
    org, site, ref, folderPath, pageScope,
  } = state;
  const params = new URLSearchParams(window.location.search);
  if (ref && ref !== 'main') params.set('ref', ref);
  else params.delete('ref');
  const normalized = normalizeFolderPath(folderPath);
  if (normalized) params.set('path', normalized);
  else params.delete('path');
  if (pageScope === 'tree') params.set('scope', 'tree');
  else params.delete('scope');
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', url);
  writeBrowseLocation(org, site, ref, normalized, pageScope);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {boolean} workspaceLocked
 */
function buildPagesSectionHead() {
  const head = el('div', 'bulk-pp-section-head');
  const titleWrap = el('div', 'bulk-pp-section-title-wrap');
  const icon = el('span', 'bulk-pp-section-icon bulk-pp-section-icon-pages');
  icon.setAttribute('aria-hidden', 'true');
  titleWrap.append(icon, el('h3', 'bulk-pp-section-title', 'Pages'));
  head.append(titleWrap);
  return head;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {boolean} workspaceLocked
 */
function buildPagesScopeRow(state, workspaceLocked) {
  const locked = workspaceLocked || state.contentLoading;
  const scopeRow = el('div', 'bulk-pp-pages-scope-row');
  const scopeCheck = el('input');
  scopeCheck.type = 'checkbox';
  scopeCheck.id = 'bulk-pp-include-subdirectories';
  scopeCheck.checked = state.pageScope === 'tree';
  scopeCheck.disabled = locked;
  scopeCheck.addEventListener('change', () => {
    state.onToggleIncludeSubdirectories(scopeCheck.checked);
  });
  const scopeLabel = el('label', 'bulk-pp-pages-scope-check');
  scopeLabel.htmlFor = 'bulk-pp-include-subdirectories';
  scopeLabel.append(
    scopeCheck,
    document.createTextNode(' Include all subdirectories'),
  );
  scopeRow.append(scopeLabel);
  return scopeRow;
}

/**
 * @param {string} title
 * @param {string | number} count
 * @param {string} [countId]
 * @param {'folders'|'pages'} [variant]
 */
function buildSectionHead(title, count, countId = '', variant = 'folders') {
  const head = el('div', 'bulk-pp-section-head');
  const titleWrap = el('div', 'bulk-pp-section-title-wrap');
  const icon = el(
    'span',
    `bulk-pp-section-icon bulk-pp-section-icon-${variant}`,
  );
  icon.setAttribute('aria-hidden', 'true');
  titleWrap.append(icon, el('h3', 'bulk-pp-section-title', title));
  const countEl = el('span', 'bulk-pp-section-count', String(count));
  if (countId) countEl.id = countId;
  head.append(titleWrap, countEl);
  return head;
}

function buildBreadcrumb(folderPath, onNavigate, locked = false) {
  const nav = el('nav', 'bulk-pp-breadcrumb');
  nav.setAttribute('aria-label', 'Current folder');
  const normalized = normalizeFolderPath(folderPath);

  if (!normalized) {
    nav.append(el('span', 'bulk-pp-breadcrumb-current', 'Site root'));
    return nav;
  }

  const rootBtn = el('button', 'bulk-pp-breadcrumb-segment', 'Site root');
  rootBtn.type = 'button';
  rootBtn.disabled = locked;
  if (!locked) {
    setAccessibilityLabel(rootBtn, 'Go to site root');
    rootBtn.addEventListener('click', () => onNavigate(''));
  }
  nav.append(rootBtn);
  const segments = normalized.split('/').filter(Boolean);
  segments.forEach((segment, index) => {
    nav.append(el('span', 'bulk-pp-breadcrumb-sep', '›'));
    const path = segments.slice(0, index + 1).join('/');
    if (index === segments.length - 1) {
      nav.append(el('span', 'bulk-pp-breadcrumb-current', segment));
    } else {
      const btn = el('button', 'bulk-pp-breadcrumb-segment', segment);
      btn.type = 'button';
      btn.disabled = locked;
      if (!locked) {
        setAccessibilityLabel(btn, `Navigate to ${segment}`);
        btn.addEventListener('click', () => onNavigate(path));
      }
      nav.append(btn);
    }
  });
  return nav;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {string} safeFolder
 * @param {boolean} locked
 */
function buildEmptyBrowseState(state, safeFolder, locked) {
  const wrap = el('div', 'bulk-pp-empty-browse-state');
  const breadcrumb = buildBreadcrumb(
    safeFolder,
    (path) => state.onNavigate(path),
    locked,
  );
  breadcrumb.classList.add('bulk-pp-empty-browse-breadcrumb');
  wrap.append(breadcrumb);

  const normalized = normalizeFolderPath(safeFolder);
  if (normalized) {
    const segments = normalized.split('/').filter(Boolean);
    const parentPath = segments.slice(0, -1).join('/');
    const upBtn = el(
      'button',
      'bulk-pp-btn bulk-pp-btn-secondary bulk-pp-empty-browse-up',
      'Go to parent directory',
    );
    upBtn.type = 'button';
    upBtn.disabled = locked;
    setAccessibilityLabel(upBtn, 'Go to parent directory');
    upBtn.addEventListener('click', () => state.onNavigate(parentPath));
    wrap.append(upBtn);
  }

  wrap.append(el('p', 'bulk-pp-list-empty', 'No folders or pages in this location.'));
  return wrap;
}

function formatRowModifiedLabel(entry, showStatus) {
  if (!showStatus || !entry) return '';
  const ts = Math.max(entry.previewedAt || 0, entry.publishedAt || 0);
  return ts ? formatStatusDate(ts) : '';
}

function buildPageListColumnHeader() {
  const head = el('div', 'bulk-pp-list-colhead bulk-pp-list-colhead-pages');
  head.setAttribute('aria-hidden', 'true');
  head.append(
    el('span', 'bulk-pp-list-colhead-check'),
    el('span', 'bulk-pp-list-colhead-icon'),
    el('span', 'bulk-pp-list-colhead-name', 'Name'),
    el('span', 'bulk-pp-list-colhead-modified', 'Modified'),
    el('span', 'bulk-pp-list-colhead-actions'),
  );
  return head;
}

function buildFolderRow(folder, onNavigate, locked = false) {
  const li = el('li', 'bulk-pp-list-item bulk-pp-list-item-folder');
  if (locked) li.classList.add('bulk-pp-list-item-locked');
  const icon = el('span', 'bulk-pp-item-icon bulk-pp-icon-folder', '');
  icon.setAttribute('aria-hidden', 'true');
  const link = el('button', 'bulk-pp-folder-link', folder.name);
  link.type = 'button';
  link.disabled = locked;
  if (locked) {
    link.setAttribute('aria-disabled', 'true');
    setAccessibilityLabel(link, 'Unavailable while status is loading');
  } else {
    setAccessibilityLabel(link, `Open folder ${folder.name}`);
  }
  link.addEventListener('click', (e) => {
    if (locked) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onNavigate(folder.folderPath);
  });
  li.append(icon, link);
  if (!locked) {
    li.addEventListener('click', (e) => {
      if (e.target !== link) link.click();
    });
  }
  return li;
}

/**
 * Creates a status indicator dot with accessibility attributes
 * @param {string} [status]
 * @returns {Element}
 */
function buildStatusDot(status) {
  const isPending = !status;
  const classList = isPending
    ? 'bulk-pp-status-dot bulk-pp-status-dot-pending'
    : `bulk-pp-status-dot bulk-pp-status-dot-${status}`;
  const dot = el('span', classList);
  const label = isPending ? 'Status loading' : statusLabel(status);
  if (!isPending) setAccessibilityLabel(dot, label);
  else dot.setAttribute('aria-label', label);
  return dot;
}

function buildPageRow(
  page,
  entry,
  browseFolder,
  state,
  showStatus,
  siteCtx,
  interactionsLocked = false,
) {
  const li = el('li', 'bulk-pp-list-item bulk-pp-list-item-document');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.className = 'bulk-pp-page-cb';
  cb.value = page.helixPath;
  cb.dataset.path = page.helixPath;
  cb.checked = state.selected.has(page.helixPath);
  cb.disabled = interactionsLocked;
  cb.id = `page-${page.helixPath.replace(/\W/g, '_')}`;
  cb.addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const path = input.dataset.path || input.value;
    if (input.checked) state.selected.add(path);
    else state.selected.delete(path);
    state.onSelectionChange();
  });

  const icon = el('span', 'bulk-pp-item-icon bulk-pp-icon-document', '');
  icon.setAttribute('aria-hidden', 'true');
  const { title } = formatPageListLabel(
    page.helixPath,
    page.name,
    browseFolder,
  );
  const labelWrap = el('div', 'bulk-pp-item-main');
  const label = el('label', 'bulk-pp-item-label', title);
  label.htmlFor = cb.id;
  labelWrap.append(label);

  const modifiedText = formatRowModifiedLabel(entry, showStatus);
  const modifiedEl = el('span', 'bulk-pp-item-modified', modifiedText);
  if (!modifiedText) modifiedEl.setAttribute('aria-hidden', 'true');

  const rowActions = el('div', 'bulk-pp-row-actions');
  const daUrl = buildDaEditUrl(
    siteCtx.org,
    siteCtx.site,
    page.helixPath,
    page.sourcePath,
    siteCtx.ref,
  );
  const multiSelected = getActiveSelectionCount(state) > 1;
  const daDisabled = interactionsLocked || multiSelected;
  const daLink = el('a', 'bulk-pp-btn bulk-pp-btn-open-da', 'DA');
  daLink.dataset.href = daUrl;
  if (daDisabled) {
    daLink.classList.add('bulk-pp-btn-open-da-disabled');
    daLink.setAttribute('aria-disabled', 'true');
    const disabledLabel = multiSelected
      ? 'Use More → Open in DA when multiple pages are selected'
      : 'Unavailable while status is loading';
    setAccessibilityLabel(daLink, disabledLabel);
    daLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  } else {
    daLink.href = daUrl;
    daLink.target = '_top';
    daLink.rel = 'noopener noreferrer';
    setAccessibilityLabel(daLink, 'Open this page in Document Authoring');
    daLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        (window.top || window).location.assign(daUrl);
      } catch {
        window.open(daUrl, '_blank', 'noopener,noreferrer');
      }
    });
  }
  rowActions.append(daLink);
  rowActions.append(
    showStatus ? buildStatusDot(getPageStatus(entry)) : buildStatusDot(),
  );
  li.append(cb, icon, labelWrap, modifiedEl, rowActions);
  return li;
}

/**
 * @param {string[]} urls
 * @param {ReturnType<typeof createAppState>} [state]
 */
async function openUrlsInNewTabs(urls, state = null) {
  if (urls.length === 0) return;
  const ok = await confirmOpenUrlsInNewTabs(urls.length);
  if (!ok) return;
  if (state) {
    applyOperationWorkspaceReset(state);
  }
  const result = openUrlsInNewTabsQuiet(urls);
  if (shouldWarnPopupBlock(result) && state) {
    state.status = 'Your browser blocked new tabs. Allow pop-ups for this site, or copy URLs from the operation completion dialog.';
    state.statusType = 'error';
    if (state.root) render(/** @type {HTMLElement} */ (state.root), state);
  }
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {'preview'|'live'} env
 * @param {string[]} paths
 */
async function openEnvUrls(state, env, paths) {
  if (paths.length === 0) return;
  await openUrlsInNewTabs(
    buildUrlsForPaths(paths, state.org, state.site, state.ref, env),
    state,
  );
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {'preview'|'live'} env
 */
async function openSelectedUrls(state, env) {
  await openEnvUrls(state, env, getSelectedHelixPaths(state));
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
async function copySelectedPreviewUrls(state) {
  const paths = getSelectedHelixPaths(state);
  if (paths.length === 0) return;
  const urls = buildUrlsForPaths(
    paths,
    state.org,
    state.site,
    state.ref,
    'preview',
  );
  try {
    await copyTextToClipboard(urls.join('\n'));
    const noun = urls.length === 1 ? 'URL' : 'URLs';
    state.status = `Copied ${urls.length} .page ${noun} to clipboard.`;
    state.statusType = 'success';
    showCopyToast('Copied', 'URLs have been copied to the clipboard.');
  } catch {
    state.status = 'Unable to copy .page URLs. Check clipboard permissions and try again.';
    state.statusType = 'error';
  }
  if (state.root) render(/** @type {HTMLElement} */ (state.root), state);
}

/**
 * @param {string} title
 * @param {string} message
 */
function showCopyToast(title, message) {
  const existing = document.querySelector('.bulk-pp-copy-toast');
  if (existing) existing.remove();
  if (copyToastTimer) window.clearTimeout(copyToastTimer);

  const toast = el('div', 'bulk-pp-copy-toast');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const head = el('div', 'bulk-pp-copy-toast-head');
  const icon = el('span', 'bulk-pp-copy-toast-icon', 'i');
  icon.setAttribute('aria-hidden', 'true');
  head.append(icon, el('span', 'bulk-pp-copy-toast-title', title));
  toast.append(head, el('p', 'bulk-pp-copy-toast-message', message));

  document.body.append(toast);
  copyToastTimer = window.setTimeout(() => {
    toast.remove();
    copyToastTimer = 0;
  }, 2600);
}

async function openSelectedDa(state) {
  const pageByPath = new Map(state.pages.map((p) => [p.helixPath, p]));
  const urls = getSelectedHelixPaths(state)
    .map((path) => pageByPath.get(path))
    .filter(Boolean)
    .map((page) => buildDaEditUrl(
      state.org,
      state.site,
      page.helixPath,
      page.sourcePath,
      state.ref,
    ));
  await openUrlsInNewTabs(urls, state);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {'preview'|'live'} env
 */
async function checkLhsForSelectedUrls(state, env) {
  const paths = getSelectedHelixPaths(state);
  if (paths.length === 0) return;
  const contentUrls = buildUrlsForPaths(paths, state.org, state.site, state.ref, env);
  const psUrls = contentUrls.map((url) => {
    const encoded = encodeURIComponent(url);
    return `https://pagespeed.web.dev/analysis?url=${encoded}`;
  });
  await openUrlsInNewTabs(psUrls, state);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @returns {boolean}
 */
function isOperationBlocked(state) {
  return (
    state.loading
    || state.contentLoading
    || isStatusFetchBlocking(state)
    || isJobModalOpen()
    || getActiveSelectionCount(state) === 0
  );
}

/**
 * @param {PageOperationId} operationId
 * @returns {import('./lib/api.js').AdminOperation | ''}
 */
function operationApiKey(operationId) {
  if (operationId === 'live') return 'live';
  if (operationId === 'preview') return 'preview';
  if (operationId === 'unpreview') return 'unpreview';
  if (operationId === 'unpublish') return 'unpublish';
  if (operationId === 'delete') return 'delete';
  return '';
}

/**
 * @param {unknown} err
 * @param {string} message
 * @returns {string}
 */
function errorHintFrom(err, message) {
  const status = err && typeof err === 'object' && 'status' in err
    ? Number(/** @type {{ status?: number }} */ (err).status)
    : 0;
  return permissionErrorHint(status, message);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {JobTopic} topic
 * @param {unknown} err
 * @param {import('./lib/api.js').AdminOperation | ''} [operation]
 */
function presentJobError(state, topic, err, operation = '') {
  const msg = messageFromApiError(err, 'Operation failed.', operation);
  state.status = msg;
  state.statusType = 'error';
  if (err && typeof err === 'object' && 'data' in err && err.data) {
    state.jobDetail = JSON.stringify(err.data, null, 2);
  }
  showJobErrorModal({
    message: msg,
    topic,
    hint: errorHintFrom(err, msg),
    onClose: () => finishProgressModal(state),
  });
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {PageOperationId} operationId
 */
async function runPageOperation(state, operationId) {
  if (isOperationBlocked(state)) return;

  try {
    if (operationId === 'preview' || operationId === 'live') {
      await state.onRun(operationId);
      return;
    }
    if (
      operationId === 'unpreview'
      || operationId === 'unpublish'
      || operationId === 'delete'
    ) {
      await state.onRunDestructive(operationId);
      return;
    }
    if (operationId === 'open-da') {
      await openSelectedDa(state);
      return;
    }
    if (operationId === 'open-preview') {
      await openSelectedUrls(state, 'preview');
      return;
    }
    if (operationId === 'open-live') {
      await openSelectedUrls(state, 'live');
      return;
    }
    if (operationId === 'check-lhs-page') {
      await checkLhsForSelectedUrls(state, 'preview');
      return;
    }
    if (operationId === 'check-lhs-live') {
      await checkLhsForSelectedUrls(state, 'live');
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    const op = operationApiKey(operationId);
    const msg = messageFromApiError(err, 'Operation failed.', op);
    state.status = msg;
    state.statusType = 'error';
    const { root } = state;
    if (root) render(/** @type {HTMLElement} */ (root), state);
  }
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @returns {boolean}
 */
function isSelectionActionsBlocked(state) {
  return (
    state.loading
    || state.contentLoading
    || isStatusFetchBlocking(state)
    || isJobModalOpen()
  );
}

/**
 * @param {HTMLButtonElement} btn
 * @param {ReturnType<typeof createAppState>} state
 * @param {PageOperationId} operationId
 * @param {string} label
 * @param {'default' | 'deploy' | 'primary'} [variant]
 */
function bindSelectionOpButton(
  btn,
  state,
  operationId,
  label,
  variant = 'default',
) {
  btn.type = 'button';
  btn.dataset.operation = operationId;
  btn.classList.add(
    'bulk-pp-selection-strip-btn',
    `bulk-pp-selection-strip-btn-${variant}`,
  );
  if (operationId === 'delete') btn.classList.add('bulk-pp-selection-strip-btn-danger');
  btn.append(
    buildSelectionOpIcon(operationId),
    el('span', 'bulk-pp-selection-op-label', label),
  );
  btn.addEventListener('click', () => {
    runPageOperation(state, operationId);
  });
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function buildSelectionActionBar(state) {
  const count = getActiveSelectionCount(state);
  const blocked = isSelectionActionsBlocked(state);
  const anchor = el('div', 'bulk-pp-selection-strip-anchor');
  anchor.id = 'bulk-pp-selection-bar';
  if (count === 0) anchor.hidden = true;

  const bar = el('div', 'bulk-pp-selection-strip');
  bar.setAttribute('role', 'toolbar');
  setAccessibilityLabel(bar, 'Actions for selected pages');

  const left = el('div', 'bulk-pp-selection-strip-left');
  const badge = el('div', 'bulk-pp-selection-strip-badge');
  const countEl = el(
    'span',
    'bulk-pp-selection-count',
    formatSelectionBarText(count),
  );
  countEl.id = 'bulk-pp-selection-count';
  badge.append(countEl);

  const selectAllBtn = el('button', 'bulk-pp-selection-clear', 'Select all');
  selectAllBtn.type = 'button';
  selectAllBtn.id = 'bulk-pp-select-all';
  setAccessibilityLabel(selectAllBtn, 'Select all visible pages');
  selectAllBtn.disabled = blocked || getVisiblePages(state).length === 0;
  selectAllBtn.addEventListener('click', () => state.onSelectAll(true));

  const clearBtn = el('button', 'bulk-pp-selection-clear', 'Clear selection');
  clearBtn.type = 'button';
  clearBtn.id = 'bulk-pp-select-none';
  setAccessibilityLabel(clearBtn, 'Clear selection');
  clearBtn.disabled = blocked;
  clearBtn.addEventListener('click', () => state.onSelectAll(false));
  const shareBtn = el(
    'button',
    'bulk-pp-selection-strip-btn bulk-pp-selection-strip-btn-share',
    '',
  );
  shareBtn.type = 'button';
  shareBtn.id = 'bulk-pp-selection-share';
  setAccessibilityLabel(shareBtn, 'Share selected preview URLs');
  shareBtn.disabled = blocked;
  shareBtn.append(
    buildSelectionOpIcon('share'),
    el('span', 'bulk-pp-selection-op-label', 'Share'),
  );
  shareBtn.addEventListener('click', () => {
    void copySelectedPreviewUrls(state);
  });
  left.append(badge, selectAllBtn, clearBtn);

  const actions = el('div', 'bulk-pp-selection-strip-actions');
  const deployGroup = el(
    'div',
    'bulk-pp-selection-strip-group bulk-pp-selection-strip-group-deploy',
  );
  SELECTION_STRIP_OPS.forEach(({ id, label, variant }) => {
    const btn = el('button');
    bindSelectionOpButton(btn, state, id, label, variant);
    btn.disabled = blocked;
    deployGroup.append(btn);
  });
  actions.append(deployGroup, shareBtn);

  const moreWrap = el('div', 'bulk-pp-selection-more-wrap');
  const moreBtn = el(
    'button',
    'bulk-pp-selection-strip-btn bulk-pp-selection-more-trigger',
    '',
  );
  moreBtn.type = 'button';
  moreBtn.id = 'bulk-pp-selection-more';
  moreBtn.setAttribute('aria-haspopup', 'true');
  moreBtn.setAttribute('aria-expanded', 'false');
  setAccessibilityLabel(moreBtn, 'More page operations');
  moreBtn.disabled = blocked;
  moreBtn.append(el('span', 'bulk-pp-selection-op-label', 'More'));

  const menu = el('div', 'bulk-pp-selection-more-menu');
  menu.setAttribute('role', 'menu');
  const menuPanel = el('div', 'bulk-pp-selection-more-menu-panel');
  MORE_SELECTION_GROUPS.forEach(({ title, items }, groupIndex) => {
    if (groupIndex > 0) {
      menuPanel.append(el('div', 'bulk-pp-selection-more-divider'));
    }
    menuPanel.append(el('div', 'bulk-pp-selection-more-section-title', title));
    items.forEach(({ id, label, danger }) => {
      const item = el('button', 'bulk-pp-selection-more-item');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      if (danger) item.classList.add('bulk-pp-selection-more-item-danger');
      item.disabled = blocked;
      item.append(
        buildSelectionOpIcon(id),
        el('span', 'bulk-pp-selection-more-item-label', label),
      );
      item.addEventListener('click', () => {
        runPageOperation(state, id);
        moreBtn.setAttribute('aria-expanded', 'false');
        menu.classList.remove('bulk-pp-selection-more-menu-open');
      });
      menuPanel.append(item);
    });
  });
  menu.append(menuPanel);

  // Use centralized menu manager for accessibility and consistency
  attachMenuManager(moreWrap, moreBtn, menu);

  moreWrap.append(moreBtn, menu);
  actions.append(el('div', 'bulk-pp-selection-strip-divider'), moreWrap);
  bar.append(left, actions);
  anchor.append(bar);
  return anchor;
}

/**
 * @param {number} count
 */
function formatSelectionBarText(count) {
  return count === 1 ? '1 page selected' : `${count} pages selected`;
}

/* ========================================
   DOM & STATE UTILITIES
   ======================================== */

/**
 * Attaches hover/focus menu management with proper accessibility
 * Handles open/close with keyboard and mouse events, with debounced closing
 * @param {HTMLElement} menuWrap - Container for menu trigger and menu
 * @param {HTMLElement} menuTrigger - Button or element that opens the menu
 * @param {HTMLElement} menu - The menu element
 * @param {number} [closeDelay=220] - Delay in ms before closing on blur
 */
function attachMenuManager(menuWrap, menuTrigger, menu, closeDelay = 220) {
  let closeTimer = null;

  const openMenu = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    menu.classList.add('bulk-pp-selection-more-menu-open');
    menuTrigger.setAttribute('aria-expanded', 'true');
  };

  const scheduleClose = () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      menu.classList.remove('bulk-pp-selection-more-menu-open');
      menuTrigger.setAttribute('aria-expanded', 'false');
      closeTimer = null;
    }, closeDelay);
  };

  const toggleMenu = (e) => {
    e.stopPropagation();
    if (menu.classList.contains('bulk-pp-selection-more-menu-open')) {
      scheduleClose();
    } else {
      openMenu();
    }
  };

  // Mouse events
  menuWrap.addEventListener('mouseenter', openMenu);
  menuWrap.addEventListener('mouseleave', scheduleClose);

  // Focus events
  menuWrap.addEventListener('focusin', openMenu);
  menuWrap.addEventListener('focusout', (e) => {
    if (!menuWrap.contains(/** @type {Node} */ (e.relatedTarget))) {
      scheduleClose();
    }
  });

  // Click to toggle
  menuTrigger.addEventListener('click', toggleMenu);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function applyOperationWorkspaceReset(state) {
  clearPageWorkspaceAfterOperation(state);
  const root = /** @type {HTMLElement | null} */ (state.root);
  closeProgressModal(root);

  clearFilterSelect(root);
  clearInputValue(root, '#bulk-pp-page-search');
  clearInputValue(root, '#bulk-pp-folder-search');

  if (root) patchPagesFilterControls(root, state);

  patchPageSearchResults(
    root,
    state,
    { org: state.org, site: state.site, ref: state.ref },
    buildPageRow,
  );
  patchFolderSearchResults(root, state, buildFolderRow);
  syncSelectionUI(root, state);
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function patchPagesFilterControls(root, state) {
  const filterSelect = safeQuery(
    root,
    '#bulk-pp-page-filter',
    HTMLSelectElement,
  );
  if (!filterSelect) return;

  filterSelect.querySelectorAll('option').forEach((opt) => {
    if (!(opt instanceof HTMLOptionElement)) return;
    const baseLabel = PAGE_FILTERS.find(([v]) => v === opt.value)?.[1] || opt.textContent;
    opt.disabled = false;
    opt.textContent = baseLabel;
  });

  const filterNote = root.querySelector('.bulk-pp-pages-filter-note');
  if (filterNote) filterNote.remove();
}

/**
 * Clears in-memory preview/publish indicators (checkbox off or folder change).
 * @param {ReturnType<typeof createAppState>} state
 */
function clearPagesStatusDisplay(state) {
  if (state.statusChecking) {
    persistCurrentPlatformStatus(state);
  }
  cancelStatusCheck(state, false);
  state.pageFilter = 'all';
  state.statusFetched = false;
  state.statusFetchedAt = null;
  state.statusFetchedFromCache = false;
  state.platformStatus = {};
  state.statusCheckFailed = false;
  state.statusError = null;
  state.statusPanelNote = null;
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function patchPagesHeader(root, state) {
  const host = safeQuery(root, '.bulk-pp-pages-header');
  if (!host) return;
  const statusTools = safeQuery(host, '.bulk-pp-pages-status-tools');
  host.replaceWith(
    buildPagesHeader(state, isStatusFetchBlocking(state), statusTools),
  );
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function patchPagesStatusLoading(root, state) {
  patchPagesHeader(root, state);
  const host = safeQuery(root, '#bulk-pp-pages-status-loading');
  if (host) host.remove();
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function refreshDeploymentUi(state) {
  const root = /** @type {HTMLElement | null} */ (state.root);
  if (!root) return;
  const siteCtx = siteCtxFromState(state);
  patchPagesStatusProgressBar(root, state);
  syncStatusFetchLockUi(root, state);
  syncFirstSessionLockUi(root, state);
  patchPagesStatusSummary(root, state);
  patchPagesStatusNotice(root, state);
  patchPagesStatusLoading(root, state);
  patchPagesFilterControls(root, state);
  patchPageSearchResults(root, state, siteCtx, buildPageRow);
  syncSelectionUI(root, state);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {{ visiblePages: { helixPath: string }[] }} opts
 */
function buildPagesSelectionRow(state, { visiblePages }) {
  const row = el('div', 'bulk-pp-pages-selection-row');
  const activeCount = getActiveSelectionCount(state);
  row.classList.add(
    activeCount > 0 ? 'bulk-pp-pages-selection-row-active' : 'bulk-pp-pages-selection-row-idle',
  );
  const selectionPill = el(
    'span',
    'bulk-pp-selection-pill',
    formatSelectionPillText(state),
  );
  selectionPill.classList.add(
    activeCount > 0 ? 'bulk-pp-selection-pill-active' : 'bulk-pp-selection-pill-idle',
  );
  selectionPill.id = 'bulk-pp-selection-pill';
  row.append(selectionPill);
  return row;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {boolean} workspaceLocked
 */
function buildPagesHeader(state, workspaceLocked, statusTools = null) {
  const header = el('div', 'bulk-pp-pages-header');
  const topRow = el('div', 'bulk-pp-pages-header-top');
  const mainSection = el('div', 'bulk-pp-pages-header-main');
  const breadcrumb = buildBreadcrumb(
    state.folderPath,
    (path) => state.onNavigate(path),
    workspaceLocked,
  );
  breadcrumb.classList.add('bulk-pp-pages-breadcrumb');
  const directoryBlock = el('div', 'bulk-pp-pages-directory');
  directoryBlock.append(
    el('span', 'bulk-pp-pages-directory-label', 'Current directory'),
    breadcrumb,
    buildPagesScopeRow(state, workspaceLocked),
  );
  mainSection.append(buildPagesSectionHead(), directoryBlock);

  const aside = el('div', 'bulk-pp-pages-header-aside');
  if (state.pages.length > 0) {
    aside.append(buildPagesStatusSummary(state));
    aside.append(buildStatusActionCard(state));
    if (statusTools) aside.append(statusTools);
  } else {
    const countEl = el('span', 'bulk-pp-section-count', '0');
    countEl.id = 'bulk-pp-page-count';
    aside.append(countEl);
  }
  topRow.append(mainSection, aside);
  header.append(topRow);

  return header;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {string[]} helixPaths
 */
function removePagesFromState(state, helixPaths) {
  const remove = new Set(helixPaths);
  state.pages = state.pages.filter((p) => !remove.has(p.helixPath));
  helixPaths.forEach((path) => state.selected.delete(path));
  const nextStatus = { ...state.platformStatus };
  helixPaths.forEach((path) => {
    delete nextStatus[path];
  });
  state.platformStatus = nextStatus;
  removePathsFromStatusCache(state.org, state.site, state.ref, helixPaths);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {Function | null} daFetch
 * @param {string[]} paths
 * @param {'preview'|'live'|'unpreview'|'unpublish'|'delete'} topic
 */
async function refreshPlatformStatusAfterJob(state, daFetch, paths, topic) {
  if (!daFetch || paths.length === 0) return;
  if (topic === 'delete') {
    removePathsFromStatusCache(state.org, state.site, state.ref, paths);
    const next = { ...state.platformStatus };
    paths.forEach((path) => {
      delete next[path];
    });
    state.platformStatus = next;
    refreshDeploymentUi(state);
    return;
  }

  const isRemoval = topic === 'unpreview' || topic === 'unpublish';
  const optimistic = buildOptimisticStatusPatch(
    topic,
    paths,
    state.platformStatus,
  );
  // Always apply optimistic updates for removal operations, even if patch is empty
  if (Object.keys(optimistic).length > 0 || isRemoval) {
    commitPlatformStatus(
      state,
      optimistic,
      isRemoval ? { replacePaths: paths } : undefined,
    );
    refreshDeploymentUi(state);
  }

  try {
    const refreshed = await fetchPlatformStatusForPaths(
      daFetch,
      state.org,
      state.site,
      state.ref,
      paths,
      undefined,
      { folderPath: state.folderPath },
    );
    commitPlatformStatus(
      state,
      refreshed,
      isRemoval ? { replacePaths: paths, removalTopic: topic } : undefined,
    );
  } catch (refreshErr) {
    console.warn('[bulk-pp] status refresh after job failed', refreshErr);
  }
  refreshDeploymentUi(state);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {string[]} paths
 * @param {string} [phaseLabel]
 * @param {Record<string, unknown>} job
 */
function applyJobProgress(state, paths, phaseLabel, job) {
  const progress = job.progress || job.job?.progress;
  if (progress && typeof progress === 'object') {
    const { total, processed, failed } = /** @type {{
      total?: number,
      processed?: number,
      failed?: number,
    }} */ (progress);
    const proc = Number(processed ?? 0);
    const tot = Number(total ?? paths.length);
    state.jobProgressProcessed = proc;
    state.jobProgressTotal = tot || paths.length;
    updateJobModal({
      jobStartedAt: state.jobStartedAt,
      processed: proc,
      total: tot || paths.length,
      failed: Number(failed ?? 0),
      stateLabel: String(job.state || job.job?.state || 'running'),
      phaseLabel,
    });
  }
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {string[]} paths
 * @param {string} phaseLabel
 * @param {number} processed
 * @param {number} failed
 * @param {number} [total]
 */
function setSequentialProgress(
  state,
  paths,
  phaseLabel,
  processed,
  failed,
  total = paths.length,
) {
  state.jobProgressProcessed = processed;
  state.jobProgressTotal = total;
  updateJobModal({
    jobStartedAt: state.jobStartedAt,
    processed,
    total,
    failed,
    stateLabel: 'running',
    phaseLabel,
  });
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {Function} daFetch
 * @param {'preview'|'live'} partition
 * @param {string[]} paths
 * @param {string} phaseLabel
 */
async function runRemovePartitionJob(
  state,
  daFetch,
  partition,
  paths,
  phaseLabel,
) {
  const finalJob = await runBulkRemoveJob(
    daFetch,
    state.org,
    state.site,
    state.ref,
    partition,
    paths,
    (job) => {
      if (state.jobAbort?.signal.aborted) return;
      applyJobProgress(state, paths, phaseLabel, job);
    },
    state.jobAbort?.signal,
  );
  return resolveJobOutcome(finalJob);
}

/**
 * @param {string} message
 */
function formatStatusAccessMessage(message) {
  return isStatusPermissionError(message)
    ? STATUS_ACCESS_DENIED_MESSAGE
    : message;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function buildPagesStatusNotice(state) {
  if (state.statusPanelNote) {
    return el('p', 'bulk-pp-status-note', state.statusPanelNote);
  }
  if (state.statusCheckFailed && state.statusError && state.pages.length > 0) {
    const note = el(
      'p',
      'bulk-pp-status-note bulk-pp-status-note-error',
      formatStatusAccessMessage(state.statusError),
    );
    note.id = 'bulk-pp-pages-status-notice';
    note.setAttribute('role', 'alert');
    return note;
  }
  return null;
}

function buildStatusLegend() {
  const legend = el('div', 'bulk-pp-status-legend');
  legend.setAttribute('aria-label', 'Deployment status key');
  STATUS_LEGEND_ITEMS.forEach(([key, text]) => {
    const item = el('span', 'bulk-pp-legend-item');
    const dot = el('span', 'bulk-pp-legend-dot');
    dot.style.background = STATUS_COLOR[key];
    item.append(dot, document.createTextNode(text));
    legend.append(item);
  });
  return legend;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function siteCtxFromState(state) {
  return { org: state.org, site: state.site, ref: state.ref };
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function buildPagesStatusSummary(state) {
  if (isDeploymentStatusPending(state)) {
    return buildPagesStatusSummaryLoading();
  }
  const helixPaths = state.pages.map((p) => p.helixPath);
  const hasAnyStatus = helixPaths.some((path) => {
    const entry = state.platformStatus[path];
    return Boolean(entry?.previewedAt || entry?.publishedAt);
  });
  if (state.statusCheckFailed && state.statusError && !hasAnyStatus) {
    const strip = el(
      'div',
      'bulk-pp-pages-summary bulk-pp-pages-summary-error',
    );
    strip.id = 'bulk-pp-pages-summary';
    strip.setAttribute('aria-label', 'Deployment status unavailable');
    strip.append(
      el(
        'span',
        'bulk-pp-pages-summary-error-text',
        formatStatusAccessMessage(state.statusError),
      ),
    );
    return strip;
  }
  const {
    live, previewOnly, none, total,
  } = deploymentCountsForPaths(
    state.platformStatus,
    helixPaths,
  );
  const loading = state.statusRevalidating;
  const strip = el(
    'div',
    `bulk-pp-pages-summary${loading ? ' bulk-pp-pages-summary-loading' : ''}`,
  );
  strip.id = 'bulk-pp-pages-summary';
  strip.setAttribute('aria-label', 'Deployment summary for pages in this view');

  /** @type {[string, number, string][]} */
  const items = [
    ['live', live, 'Published pages'],
    ['preview', previewOnly, 'Only Previewed Pages'],
    ['none', none, 'Not deployed pages'],
    ['total', total, 'Total Pages'],
  ];
  items.forEach(([mod, value, label]) => {
    const item = el(
      'div',
      `bulk-pp-pages-summary-item bulk-pp-pages-summary-${mod}`,
    );
    item.append(
      el('span', 'bulk-pp-pages-summary-value', String(value)),
      el('span', 'bulk-pp-pages-summary-label', label),
    );
    strip.append(item);
  });
  return strip;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {string} pageFilter
 * @param {boolean} contentLoading
 * @returns {{ filterField: HTMLElement, filterSelect: HTMLSelectElement }}
 */
function buildPagesFilterField(state, pageFilter, contentLoading) {
  const filterField = el(
    'div',
    'bulk-pp-pages-filter-field bulk-pp-field-filter',
  );
  const filterSelect = document.createElement('select');
  filterSelect.id = 'bulk-pp-page-filter';
  filterSelect.className = 'bulk-pp-filter-select';
  filterSelect.setAttribute('aria-label', 'Filter by status');
  filterSelect.disabled = contentLoading;
  PAGE_FILTERS.forEach(([value, labelText]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = labelText;
    if (value === (pageFilter || 'all')) opt.selected = true;
    filterSelect.append(opt);
  });
  filterField.append(filterSelect);
  return { filterField, filterSelect };
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function buildRealtimeStatusButton(state) {
  const btn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-fetch-deployment bulk-pp-pages-refresh-status',
  );
  btn.type = 'button';
  btn.disabled = state.pages.length === 0
    || state.contentLoading
    || state.loading
    || state.statusChecking;
  setAccessibilityLabel(btn, 'Fetch live deployment status');
  btn.innerHTML = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 3.5v3.2h-3.2"/></svg>';
  btn.addEventListener('click', () => {
    if (typeof state.onRefreshStatus === 'function') {
      state.onRefreshStatus();
    }
  });
  return btn;
}

/**
 * @param {number | null | undefined} ts
 */
function formatStatusFetchedAt(ts) {
  if (!ts || Number.isNaN(ts)) return '';
  const dt = new Date(ts);
  const now = new Date();
  if (dt.toDateString() === now.toDateString()) {
    return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return dt.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function buildStatusActionCard(state) {
  const card = el('div', 'bulk-pp-status-action-card');

  const left = el('div', 'bulk-pp-status-action-left');
  const label = el('span', 'bulk-pp-status-action-label');
  const when = formatStatusFetchedAt(state.statusFetchedAt);
  if (!when) {
    label.textContent = 'Last fetched: not yet fetched';
  } else {
    label.textContent = state.statusFetchedFromCache
      ? `Last fetched: ${when} (cached)`
      : `Last fetched: ${when}`;
  }
  left.append(label);
  left.append(buildRealtimeStatusButton(state));

  card.append(left);
  return card;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function shouldShowStatusProgressBar(state) {
  return isStatusFetchLockingUi(state);
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function syncStatusFetchLockUi(root, state) {
  const locked = isStatusFetchLockingUi(state);
  root.classList.toggle('bulk-pp-status-fetch-active', locked);
  const busy = locked || isFirstSessionStatusPending(state);
  root.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function syncFirstSessionLockUi(root, state) {
  const locked = isFirstSessionStatusPending(state)
    && !state.contentLoading
    && !state.statusChecking;
  root.classList.toggle('bulk-pp-first-session-loading', locked);
  const overlay = root.querySelector('#bulk-pp-first-session-overlay');
  if (locked) {
    if (!overlay) root.append(buildFirstSessionFetchOverlay());
  } else if (overlay) {
    overlay.remove();
  }
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function buildPagesStatusProgressBar(state) {
  const bar = el('div', 'bulk-pp-pages-status-progress');
  bar.id = 'bulk-pp-pages-status-progress';

  const head = el('div', 'bulk-pp-pages-status-progress-head');
  head.append(
    el(
      'span',
      'bulk-pp-pages-status-progress-title',
      'Fetching deployment status',
    ),
  );
  const stopBtn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-text bulk-pp-pages-status-progress-stop',
    'Stop',
  );
  stopBtn.type = 'button';
  stopBtn.addEventListener('click', () => state.onCancelStatus());
  head.append(stopBtn);
  bar.append(head);

  const track = el('div', 'bulk-pp-progress-track');
  const fill = el('div', 'bulk-pp-progress-fill');
  fill.id = 'bulk-pp-pages-status-progress-fill';
  track.append(fill);
  bar.append(track);

  const meta = el('div', 'bulk-pp-pages-status-progress-meta');
  const label = el('span', 'bulk-pp-pages-status-progress-label', 'Starting…');
  label.id = 'bulk-pp-pages-status-progress-label';
  const eta = el('span', 'bulk-pp-pages-status-progress-eta', '');
  eta.id = 'bulk-pp-pages-status-progress-eta';
  meta.append(label, eta);
  bar.append(meta);

  updatePagesStatusProgressBar(bar, state);
  return bar;
}

/**
 * @param {HTMLElement} bar
 * @param {ReturnType<typeof createAppState>} state
 */
function updatePagesStatusProgressBar(bar, state) {
  const done = state.statusProgressDone;
  const total = state.statusProgressTotal;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const fill = bar.querySelector('#bulk-pp-pages-status-progress-fill');
  if (fill instanceof HTMLElement) fill.style.width = `${pct}%`;
  const label = bar.querySelector('#bulk-pp-pages-status-progress-label');
  if (label) {
    label.textContent = total > 0 ? `${done} of ${total} pages checked (${pct}%)` : 'Starting…';
  }
  const eta = bar.querySelector('#bulk-pp-pages-status-progress-eta');
  if (eta) {
    const runtime = formatRuntimeStatusEta(
      state.statusFetchStartedAt,
      done,
      total,
    );
    eta.textContent = runtime || '';
  }
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function patchPagesStatusProgressBar(root, state) {
  const pagesSection = root.querySelector('.bulk-pp-content-section-pages');
  if (!pagesSection) return;
  let bar = root.querySelector('#bulk-pp-pages-status-progress');
  const show = shouldShowStatusProgressBar(state);
  if (!show) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = buildPagesStatusProgressBar(state);
    pagesSection.insertBefore(bar, pagesSection.firstChild);
    return;
  }
  updatePagesStatusProgressBar(bar, state);
}

/**
 * @param {HTMLSelectElement | null} filterSelect
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function bindDeploymentFilterSelect(filterSelect, root, state) {
  const siteCtx = siteCtxFromState(state);
  filterSelect?.addEventListener('change', () => {
    if (!filterSelect || filterSelect.disabled) return;
    state.pageFilter = filterSelect.value;
    patchPageSearchResults(root, state, siteCtx, buildPageRow);
  });
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function patchPagesStatusSummary(root, state) {
  const host = root.querySelector('#bulk-pp-pages-summary');
  if (!host || state.pages.length === 0) return;
  host.replaceWith(buildPagesStatusSummary(state));
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function patchPagesStatusNotice(root, state) {
  const existing = root.querySelector('#bulk-pp-pages-status-notice');
  const next = buildPagesStatusNotice(state);
  if (existing && !next) {
    existing.remove();
    return;
  }
  if (!next) return;
  if (existing) {
    existing.replaceWith(next);
    return;
  }
  const controls = root.querySelector('.bulk-pp-pages-controls');
  if (controls) controls.prepend(next);
}

/**
 * @param {Record<string, { previewedAt?: number, publishedAt?: number }>} platformStatus
 * @param {string[]} helixPaths
 */
function deploymentCountsForPaths(platformStatus, helixPaths) {
  /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */
  const statusMap = {};
  helixPaths.forEach((path) => {
    statusMap[path] = platformStatus[path] || {};
  });
  const pages = helixPaths.map((helixPath) => ({ helixPath }));
  const {
    live, preview, none, previewed, orphanedLive,
  } = countStatusBreakdown(statusMap, pages);
  return {
    live,
    orphanedLive,
    previewed,
    previewOnly: preview,
    none,
    total: helixPaths.length,
  };
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {string[]} helixPaths
 * @param {Record<string, { previewedAt?: number, publishedAt?: number }>} platformStatus
 */
function finishStatusFetch(state) {
  const root = /** @type {HTMLElement | null} */ (state.root);
  if (root) render(root, state);
}

/**
 * @param {ReturnType<typeof createAppState>} state
 */
function finishProgressModal(state) {
  const root = /** @type {HTMLElement | null} */ (state.root);
  closeJobModal(root);
  state.jobTopic = null;
  state.jobAbort = null;
  state.jobStartedAt = null;
  if (root) render(root, state);
}

/**
 * @param {boolean} [isFirstLoad]
 */
function buildContentLoadingPanel(isFirstLoad = false) {
  const loading = el('div', 'bulk-pp-content-loading');
  const inner = el('div', 'bulk-pp-content-loading-inner');
  const spinner = el('div', 'bulk-pp-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  inner.append(
    spinner,
    el('p', 'bulk-pp-content-loading-title', 'Fetching content…'),
    el(
      'p',
      'bulk-pp-content-loading-sub',
      isFirstLoad
        ? 'Loading folders, pages, and deployment status…'
        : 'Updating folders and pages…',
    ),
  );
  loading.append(inner);
  return loading;
}

function buildFirstSessionFetchOverlay() {
  const overlay = el('div', 'bulk-pp-first-session-overlay');
  overlay.id = 'bulk-pp-first-session-overlay';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-label', 'Fetching content');
  const inner = el('div', 'bulk-pp-first-session-overlay-inner');
  const spinner = el('div', 'bulk-pp-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  inner.append(
    spinner,
    el('p', 'bulk-pp-content-loading-title', 'Fetching content…'),
  );
  overlay.append(inner);
  return overlay;
}

function buildPagesStatusSummaryLoading() {
  const strip = el(
    'div',
    'bulk-pp-pages-summary bulk-pp-pages-summary-pending',
  );
  strip.id = 'bulk-pp-pages-summary';
  strip.setAttribute('aria-label', 'Deployment summary loading');
  strip.append(
    el('span', 'bulk-pp-pages-summary-pending-text', 'Fetching status…'),
  );
  return strip;
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function render(root, state) {
  const listWrapBefore = document.getElementById('bulk-pp-page-list-wrap');
  const savedListScroll = listWrapBefore ? listWrapBefore.scrollTop : null;

  const {
    org,
    site,
    ref,
    folderPath,
    error,
    status,
    statusType,
    jobDetail,
    pageFilter,
    statusChecking,
    pageSearch,
    folderSearch,
    contentLoading,
  } = state;
  const siteCtx = { org, site, ref };

  const {
    visible: visiblePages,
    statusMap,
    browseFolder,
  } = getVisiblePages(state);
  const visibleFolders = getVisibleFolders(state);
  const workspaceLocked = isStatusFetchBlocking(state);
  const safeFolder = resolveContentFolderPath(folderPath);
  const searchDraft = String(pageSearch || '').trim();
  const searchTooShort = searchDraft.length > 0 && searchDraft.length < SEARCH_MIN_LEN;
  const folderSearchDraft = String(folderSearch || '').trim();
  const folderSearchTooShort = folderSearchDraft.length > 0 && folderSearchDraft.length < SEARCH_MIN_LEN;

  root.replaceChildren();
  root.classList.add('bulk-pp-shell');
  root.classList.toggle('bulk-pp-modal-open', isProgressModalOpen());
  syncStatusFetchLockUi(root, state);
  syncFirstSessionLockUi(root, state);
  const header = el('header', 'bulk-pp-header');
  const headerInner = el('div', 'bulk-pp-header-inner');
  const headerBrand = el('div', 'bulk-pp-header-brand');
  headerBrand.append(
    el(
      'span',
      'bulk-pp-header-eyebrow',
      'Adobe Experience Manager · Edge Delivery',
    ),
    el('h1', null, APP_TITLE),
    el('p', 'bulk-pp-header-desc', APP_DESCRIPTION),
  );
  const headerMeta = el('div', 'bulk-pp-header-meta');
  const branchBadge = el('span', 'bulk-pp-badge bulk-pp-badge-muted', ref);
  branchBadge.title = 'Branch';
  const repoBadge = el('span', 'bulk-pp-badge bulk-pp-badge-muted', site);
  repoBadge.title = 'Repository';
  const orgBadge = el('span', 'bulk-pp-badge', org);
  orgBadge.title = 'Organization';
  headerMeta.append(branchBadge, repoBadge, orgBadge);
  headerInner.append(headerBrand, headerMeta);
  header.append(headerInner);
  root.append(header);

  const contentPanel = el(
    'section',
    'bulk-pp-panel bulk-pp-panel-content bulk-pp-panel-fill',
  );
  const contentHead = el('div', 'bulk-pp-panel-head');
  const contentHeadMain = el('div', 'bulk-pp-panel-head-main');
  contentHeadMain.append(el('h2', null, 'Site content'));
  contentHead.append(contentHeadMain);
  contentPanel.append(contentHead);
  const contentBody = el('div', 'bulk-pp-panel-body bulk-pp-content-body');

  if (contentLoading) {
    contentBody.append(buildContentLoadingPanel(state.firstSessionLoad));
  } else if (error) {
    if (isDaAccessError(error)) {
      contentBody.append(buildDaAccessErrorPanel(error));
    } else {
      contentBody.append(
        el('p', 'bulk-pp-list-empty bulk-pp-list-empty-error', error),
      );
    }
  } else {
    const workspace = el('div', 'bulk-pp-workspace');
    const contentGrid = el('div', 'bulk-pp-content-grid');

    const folderSection = el(
      'section',
      'bulk-pp-content-section bulk-pp-content-section-folders',
    );
    const folderCountLabel = folderSearchDraft && !folderSearchTooShort
      ? `${visibleFolders.length} of ${state.folders.length}`
      : String(state.folders.length);
    folderSection.append(
      buildSectionHead(
        'Directories',
        folderCountLabel,
        'bulk-pp-folder-count',
        'folders',
      ),
    );
    folderSection.append(
      buildBreadcrumb(
        safeFolder,
        (path) => state.onNavigate(path),
        workspaceLocked,
      ),
    );

    const folderSearchDisabled = workspaceLocked || state.folders.length === 0;
    const { wrap: folderSearchField, input: folderSearchInput } = buildSearchField(
      'bulk-pp-folder-search',
      'Search folder',
      String(folderSearch || ''),
      folderSearchDisabled,
      searchHintText(folderSearch),
    );
    const folderSearchRow = el('div', 'bulk-pp-search-row');
    folderSearchRow.append(folderSearchField);
    folderSection.append(folderSearchRow);

    const folderWrap = el('div', 'bulk-pp-list-wrap bulk-pp-list-wrap-folders');
    const folderList = el('ul', 'bulk-pp-list');
    folderList.id = 'bulk-pp-folder-list';
    if (visibleFolders.length === 0) {
      const folderEmptyMsg = folderSearchDraft
        ? 'No folders match this search.'
        : 'no directory to show';
      folderList.append(el('li', 'bulk-pp-list-empty', folderEmptyMsg));
    } else {
      visibleFolders.forEach((folder) => {
        folderList.append(
          buildFolderRow(
            folder,
            (path) => state.onNavigate(path),
            workspaceLocked,
          ),
        );
      });
    }
    folderWrap.append(folderList);
    folderSection.append(folderWrap);
    contentGrid.append(folderSection);

    bindSearchInput(folderSearchInput, state, 'folder', () => {
      patchFolderSearchResults(root, state, buildFolderRow);
    });

    const pagesSection = el(
      'section',
      'bulk-pp-content-section bulk-pp-content-section-pages',
    );
    if (shouldShowStatusProgressBar(state)) {
      pagesSection.append(buildPagesStatusProgressBar(state));
    }

    const statusTools = el('div', 'bulk-pp-pages-status-tools');
    const { filterField, filterSelect } = buildPagesFilterField(
      state,
      String(pageFilter || 'all'),
      state.contentLoading
        || workspaceLocked
        || isDeploymentStatusPending(state),
    );

    if (state.pages.length > 0 && !isFirstSessionStatusPending(state)) {
      const legendRow = el('div', 'bulk-pp-pages-legend-row');
      legendRow.id = 'bulk-pp-pages-legend-row';
      legendRow.append(buildStatusLegend());
      if (
        (statusChecking || state.statusRevalidating)
        && !isDeploymentStatusPending(state)
      ) {
        const hintText = state.statusRevalidating && !statusChecking
          ? 'Refreshing status…'
          : 'Updating status…';
        legendRow.append(el('span', 'bulk-pp-pages-status-hint', hintText));
      }
      statusTools.append(legendRow);
    }

    pagesSection.append(buildPagesHeader(state, workspaceLocked, statusTools));

    const controls = el('div', 'bulk-pp-pages-controls');

    const toolbarRow = el('div', 'bulk-pp-pages-toolbar-row');
    const pageSearchDisabled = workspaceLocked || state.pages.length === 0;
    const { wrap: searchField, input: searchInput } = buildSearchField(
      'bulk-pp-page-search',
      'Search page',
      String(pageSearch || ''),
      pageSearchDisabled,
      searchHintText(pageSearch),
    );
    searchField.classList.add('bulk-pp-pages-search-field');
    toolbarRow.append(searchField, filterField);

    controls.append(toolbarRow);

    const statusNotice = buildPagesStatusNotice(state);
    if (statusNotice) controls.append(statusNotice);

    pagesSection.append(controls);

    const pageWrap = el(
      'div',
      'bulk-pp-list-wrap bulk-pp-list-wrap-pages bulk-pp-list-wrap-fill',
    );
    pageWrap.id = 'bulk-pp-page-list-wrap';
    if (!isFirstSessionStatusPending(state)) {
      if (state.pages.length > 0) {
        pageWrap.append(buildPageListColumnHeader());
      }
      const pageList = el('ul', 'bulk-pp-list');
      pageList.id = 'bulk-pp-page-list';
      if (state.pages.length === 0) {
        pageList.append(
          el('li', 'bulk-pp-list-empty', 'no pages to show'),
        );
      } else if (visiblePages.length === 0) {
        const emptyMsg = searchDraft
          ? 'No pages match this search.'
          : 'No pages match this filter.';
        pageList.append(el('li', 'bulk-pp-list-empty', emptyMsg));
      } else {
        visiblePages.forEach((page) => {
          pageList.append(
            buildPageRow(
              page,
              statusMap[page.helixPath],
              browseFolder,
              state,
              shouldShowPageStatus(state),
              siteCtx,
              workspaceLocked,
            ),
          );
        });
      }
      pageWrap.append(pageList);
    }
    pagesSection.append(pageWrap);
    contentGrid.append(pagesSection);
    workspace.append(contentGrid);
    contentBody.append(workspace);

    bindDeploymentFilterSelect(filterSelect, root, state);
    bindSearchInput(searchInput, state, 'page', () => {
      patchPageSearchResults(root, state, siteCtx, buildPageRow);
    });
    syncSelectionUI(root, state);
  }
  contentPanel.append(contentBody);
  root.append(contentPanel);

  if (!isFirstSessionStatusPending(state)) {
    root.append(buildSelectionActionBar(state));
  }

  if (
    status
    && !statusChecking
    && statusType === 'error'
    && !isDaAccessError(status)
  ) {
    const statusEl = el('div', `bulk-pp-status bulk-pp-status-${statusType}`);
    statusEl.setAttribute('role', 'alert');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.append(el('strong', null, status));
    if (jobDetail) statusEl.append(el('pre', 'bulk-pp-error-detail', jobDetail));
    root.append(statusEl);
  } else if (
    jobDetail
    && new URLSearchParams(window.location.search).has('debug')
  ) {
    const statusEl = el('div', 'bulk-pp-status bulk-pp-status-info');
    statusEl.append(el('pre', 'bulk-pp-error-detail', jobDetail));
    root.append(statusEl);
  }

  requestAnimationFrame(() => {
    if (savedListScroll != null) {
      const listWrap = document.getElementById('bulk-pp-page-list-wrap');
      if (listWrap) listWrap.scrollTop = savedListScroll;
    }
  });
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {string[]} pathsToCheck
 */
function pathsMatchCurrentPages(state, pathsToCheck) {
  if (state.pages.length !== pathsToCheck.length) return false;
  const current = new Set(state.pages.map((p) => p.helixPath));
  return pathsToCheck.every((path) => current.has(path));
}

/**
 * Show cached status immediately, then refresh from the API without blocking the UI.
 * Picks up preview/publish changes made directly in DA.
 * @param {ReturnType<typeof createAppState>} state
 * @param {Function | null} daFetch
 * @param {string[]} pathsToCheck
 */
async function revalidateCachedStatusInBackground(
  state,
  daFetch,
  pathsToCheck,
) {
  if (!daFetch || pathsToCheck.length === 0) return;

  cancelStatusRevalidate(state);
  const controller = new AbortController();
  state.statusRevalidateAbort = controller;
  state.statusRevalidating = true;
  refreshDeploymentUi(state);

  try {
    const fresh = await fetchPlatformStatusForPaths(
      daFetch,
      state.org,
      state.site,
      state.ref,
      pathsToCheck,
      (partial) => {
        if (!pathsMatchCurrentPages(state, pathsToCheck)) return;
        state.platformStatus = { ...state.platformStatus, ...partial };
        refreshDeploymentUi(state);
      },
      { signal: controller.signal, folderPath: state.folderPath },
    );
    if (
      controller.signal.aborted
      || !pathsMatchCurrentPages(state, pathsToCheck)
    ) return;
    commitPlatformStatus(state, { ...state.platformStatus, ...fresh });
    state.statusCheckFailed = false;
    state.statusError = null;
    const root = /** @type {HTMLElement | null} */ (state.root);
    refreshDeploymentUi(state);
    if (root) render(root, state);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    console.warn('[bulk-pp] background status revalidate failed', err);
  } finally {
    if (state.statusRevalidateAbort === controller) {
      state.statusRevalidateAbort = null;
    }
    state.statusRevalidating = false;
    refreshDeploymentUi(state);
  }
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {Function | null} daFetch
 * @param {string[]} pathsToCheck
 * @param {string} location
 * @param {number} docCount
 * @param {number} folderCount
 * @param {{ background?: boolean, cacheOnly?: boolean, forceRefresh?: boolean }} [options]
 */
function startStatusCheck(
  state,
  daFetch,
  pathsToCheck,
  location,
  docCount,
  folderCount,
  options = {},
) {
  const {
    background = false,
    cacheOnly = false,
    forceRefresh = false,
  } = options;
  let pathsToFetch = pathsToCheck;
  if (!forceRefresh) {
    pathsToFetch = getUncachedHelixPaths(
      state.org,
      state.site,
      state.ref,
      pathsToCheck,
    );
  }
  const cachedCount = pathsToCheck.length - pathsToFetch.length;

  cancelStatusCheck(state, false);
  state.statusCancelled = false;
  state.statusCheckFailed = false;
  state.statusError = null;
  state.statusPanelNote = null;
  state.statusFetchBackground = false;
  state.statusChecking = !cacheOnly && pathsToFetch.length > 0;
  state.statusProgressDone = cachedCount;
  state.statusProgressTotal = pathsToCheck.length;
  state.statusFetchedAt = null;
  state.statusFetchedFromCache = false;
  state.statusFetchStartedAt = !cacheOnly && pathsToFetch.length > 0
    ? Date.now()
    : null;
  state.statusAbort = !cacheOnly ? new AbortController() : null;

  if (pathsToCheck.length === 0) {
    state.statusChecking = false;
    state.statusFetchBackground = false;
    state.statusFetched = false;
    markInitialStatusFetchComplete(state);
    state.status = folderCount === 0 && docCount === 0
      ? `No folders or pages in ${location}.`
      : `Loaded ${docCount} page(s) in ${location}.`;
    state.statusType = 'info';
    render(/** @type {HTMLElement} */ (state.root), state);
    return;
  }

  const root = /** @type {HTMLElement | null} */ (state.root);
  const { hydrated, complete } = hydratePlatformStatusFromCache(
    state,
    pathsToCheck,
  );
  const cachedCheckedAt = getLatestCachedStatusCheckedAt(
    state.org,
    state.site,
    state.ref,
    pathsToCheck,
  );

  if (cacheOnly) {
    state.statusChecking = false;
    state.statusFetchBackground = false;
    state.statusAbort = null;
    state.statusFetchStartedAt = null;
    state.statusProgressDone = Object.keys(state.platformStatus || {}).length;
    state.statusProgressTotal = pathsToCheck.length;
    state.statusFetched = complete;
    state.statusFetchedAt = cachedCheckedAt;
    state.statusFetchedFromCache = Boolean(cachedCheckedAt);
    state.statusType = 'info';
    if (!hydrated) {
      state.statusPanelNote = 'No cached deployment status for this folder yet.';
      state.statusFetchedAt = null;
      state.statusFetchedFromCache = false;
    }
    state.status = null;
    markInitialStatusFetchComplete(state);
    refreshDeploymentUi(state);
    if (root) render(root, state);
    return;
  }

  if (pathsToFetch.length === 0) {
    state.statusChecking = false;
    state.statusFetchBackground = false;
    state.statusFetched = true;
    markInitialStatusFetchComplete(state);
    state.statusAbort = null;
    state.statusFetchStartedAt = null;
    state.statusProgressDone = pathsToCheck.length;
    state.statusProgressTotal = pathsToCheck.length;
    state.status = null;
    state.statusFetchedAt = cachedCheckedAt;
    state.statusFetchedFromCache = Boolean(cachedCheckedAt);
    state.statusType = 'info';
    refreshDeploymentUi(state);
    if (root) render(root, state);
    return;
  }

  state.statusProgressDone = cachedCount;
  state.statusProgressTotal = pathsToCheck.length;

  refreshDeploymentUi(state);

  fetchPlatformStatusForPaths(
    daFetch,
    state.org,
    state.site,
    state.ref,
    pathsToFetch,
    (partial, done) => {
      state.platformStatus = { ...state.platformStatus, ...partial };
      state.statusProgressDone = cachedCount + done;
      state.statusProgressTotal = pathsToCheck.length;
      refreshDeploymentUi(state);
    },
    { signal: state.statusAbort?.signal, folderPath: state.folderPath },
  )
    .then((platformStatus) => {
      if (state.statusAbort?.signal.aborted) return;
      if (forceRefresh) {
        commitPlatformStatus(state, platformStatus, { replacePaths: pathsToCheck });
      } else {
        commitPlatformStatus(state, {
          ...state.platformStatus,
          ...platformStatus,
        });
      }
      state.statusChecking = false;
      state.statusFetchBackground = false;
      state.statusFetched = true;
      markInitialStatusFetchComplete(state);
      state.statusAbort = null;
      state.statusFetchStartedAt = null;
      state.statusProgressDone = pathsToCheck.length;
      state.statusProgressTotal = pathsToCheck.length;
      state.statusFetchedAt = Date.now();
      state.statusFetchedFromCache = false;
      state.status = forceRefresh
        ? 'Fetched the latest deployment status from server.'
        : null;
      state.statusType = 'info';
      refreshDeploymentUi(state);
      finishStatusFetch(state);
    })
    .catch((statusErr) => {
      if (
        statusErr instanceof DOMException
        && statusErr.name === 'AbortError'
      ) {
        state.statusChecking = false;
        state.statusFetchBackground = false;
        state.statusAbort = null;
        state.statusFetchStartedAt = null;
        const rootNode = /** @type {HTMLElement | null} */ (state.root);
        const checked = state.statusProgressDone;
        const total = state.statusProgressTotal;
        if (checked > 0) {
          persistCurrentPlatformStatus(state);
          state.statusFetched = true;
          markInitialStatusFetchComplete(state);
          refreshDeploymentUi(state);
        } else {
          markInitialStatusFetchComplete(state);
        }
        state.statusPanelNote = checked > 0
          ? `Stopped after ${checked} of ${total} pages. Partial results are shown.`
          : 'Status check cancelled.';
        if (rootNode) render(rootNode, state);
        return;
      }
      state.statusChecking = false;
      state.statusFetchBackground = false;
      state.statusAbort = null;
      state.statusFetchStartedAt = null;
      const hadProgress = state.statusProgressDone > 0;
      const rootNode = /** @type {HTMLElement | null} */ (state.root);
      if (hadProgress) {
        persistCurrentPlatformStatus(state);
        state.statusFetched = true;
        state.statusFetchedAt = Date.now();
        state.statusFetchedFromCache = false;
        markInitialStatusFetchComplete(state);
        state.statusCheckFailed = true;
        state.statusError = formatStatusAccessMessage(
          messageFromApiError(statusErr, 'Status check failed.', 'status'),
        );
        state.status = `${state.statusError} Partial results were saved.`;
        state.statusType = 'error';
      } else if (
        hasCompleteCachedStatus(state.org, state.site, state.ref, pathsToCheck)
      ) {
        hydratePlatformStatusFromCache(state, pathsToCheck);
        state.statusFetched = true;
        state.statusFetchedAt = getLatestCachedStatusCheckedAt(
          state.org,
          state.site,
          state.ref,
          pathsToCheck,
        );
        state.statusFetchedFromCache = Boolean(state.statusFetchedAt);
        markInitialStatusFetchComplete(state);
        state.statusCheckFailed = false;
        state.statusError = null;
        state.status = 'Could not refresh deployment status. Showing last saved results.';
        state.statusType = 'info';
      } else {
        state.statusFetched = false;
        markInitialStatusFetchComplete(state);
        state.statusCheckFailed = true;
        state.statusError = formatStatusAccessMessage(
          messageFromApiError(statusErr, 'Status check failed.', 'status'),
        );
        state.status = state.statusError;
        state.statusType = 'error';
      }
      console.warn('[bulk-pp] platform status failed', statusErr);
      if (rootNode) render(rootNode, state);
    });
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {string} location
 * @param {number} docCount
 * @param {number} folderCount
 */
function finishContentLoadWithoutStatus(
  state,
  location,
  docCount,
  folderCount,
) {
  state.firstSessionLoad = false;
  state.statusFetchBackground = false;
  state.statusChecking = false;
  state.statusFetched = false;
  markInitialStatusFetchComplete(state);
  state.statusCheckFailed = false;
  state.statusError = null;
  state.platformStatus = {};
  if (folderCount === 0 && docCount === 0) {
    state.status = `No folders or pages in ${location}.`;
  } else if (state.pageScope === 'tree') {
    state.status = `Loaded ${docCount} page(s) under ${location} (all subdirectories).`;
  } else {
    state.status = `Loaded ${docCount} page(s) and ${folderCount} folder(s) in ${location}.`;
  }
  state.statusType = 'info';
  render(/** @type {HTMLElement} */ (state.root), state);
}

async function main() {
  const app = document.getElementById('app');
  if (!app) return;

  let { context, actions } = await initSdk();
  let hasSdkFetch = typeof actions.daFetch === 'function';
  const inDaAppShell = /\/app\/[^/]+\/[^/]+/.test(window.location.pathname);
  // DA SDK can occasionally arrive a moment late on the first load.
  if (!hasSdkFetch && inDaAppShell) {
    await new Promise((resolve) => {
      setTimeout(resolve, 900);
    });
    const retry = await initSdk();
    if (typeof retry.actions?.daFetch === 'function') {
      context = retry.context;
      actions = retry.actions;
      hasSdkFetch = true;
    }
  }
  const daFetch = hasSdkFetch ? wrapDaFetch(actions.daFetch) : null;
  const ctx = resolveSiteContext(context);

  const state = createAppState(ctx);
  state.root = app;
  resetWorkspace(state);
  const urlParams = new URLSearchParams(window.location.search);
  const urlRef = urlParams.get('ref');
  if (urlRef) state.ref = urlRef;
  const urlPath = urlParams.get('path');
  const urlScope = urlParams.get('scope');
  const persisted = readBrowseLocation(ctx.org, ctx.site, state.ref);
  if (urlPath) {
    state.folderPath = resolveContentFolderPath(normalizeFolderPath(urlPath));
  } else if (persisted?.folderPath) {
    state.folderPath = resolveContentFolderPath(persisted.folderPath);
  }
  if (urlScope === 'tree' || urlScope === 'folder') {
    state.pageScope = urlScope;
  } else if (persisted?.pageScope) {
    state.pageScope = persisted.pageScope;
  }
  syncBrowseLocation(state);

  state.onCancelStatus = () => {
    const checked = state.statusProgressDone;
    const total = state.statusProgressTotal;
    cancelStatusCheck(state, false);
    state.statusChecking = false;
    state.statusFetchBackground = false;
    if (checked > 0) {
      persistCurrentPlatformStatus(state);
      state.statusFetched = true;
      markInitialStatusFetchComplete(state);
      state.statusPanelNote = `Stopped after ${checked} of ${total} pages. Showing partial results.`;
    } else {
      state.statusFetched = false;
      markInitialStatusFetchComplete(state);
      state.statusPanelNote = 'Status check stopped.';
    }
    const root = /** @type {HTMLElement | null} */ (state.root);
    state.statusPanelNote = checked > 0
      ? `Stopped after ${checked} of ${total} pages. Partial results are shown.`
      : 'Status check cancelled.';
    if (root) render(root, state);
  };

  state.onRefreshStatus = () => {
    if (!daFetch || state.contentLoading || state.loading || state.pages.length === 0) {
      return;
    }
    if (state.statusChecking) {
      return;
    }
    const location = displayFolderPath(state.folderPath) || 'site root';
    const helixPaths = state.pages.map((p) => p.helixPath);
    startStatusCheck(
      state,
      daFetch,
      helixPaths,
      location,
      state.pages.length,
      state.folders.length,
      { forceRefresh: true },
    );
    const root = /** @type {HTMLElement | null} */ (state.root);
    if (root) render(root, state);
  };

  state.onCancelJob = () => {
    cancelBulkJob(state, false);
    if (app) syncSelectionUI(app, state);
    const topic = /** @type {JobTopic} */ (state.jobTopic || 'preview');
    const actionLabel = jobActionLabel(topic);
    showJobCancelledModal({
      message: `You stopped tracking this bulk ${actionLabel} operation. If it already started on the server, work may still be in progress. Check the Pages panel or run Fetch Deployment status again.`,
      topic,
      onClose: () => {
        state.status = null;
        state.statusType = 'info';
        finishProgressModal(state);
      },
    });
  };

  state.onNavigate = async (targetPath) => {
    if (state.contentLoading) return;
    closeProgressModal(/** @type {HTMLElement} */ (app));
    resetPagesViewState(state);
    clearPagesStatusDisplay(state);

    state.folderPath = resolveContentFolderPath(targetPath);
    state.pageSearch = '';
    state.folderSearch = '';
    state.pageFilter = 'all';
    syncBrowseLocation(state);
    await state.onFetch(true);
  };

  state.onToggleIncludeSubdirectories = async (enabled) => {
    if (isStatusFetchBlocking(state) || state.contentLoading) return;
    const next = enabled ? 'tree' : 'folder';
    if (state.pageScope === next) return;
    closeProgressModal(/** @type {HTMLElement} */ (app));
    state.pageScope = next;
    clearPagesStatusDisplay(state);
    syncBrowseLocation(state);
    await state.onFetch(true);
  };

  state.onFetch = async (fromFolderNav = false) => {
    if (state.statusChecking) {
      persistCurrentPlatformStatus(state);
      cancelStatusCheck(state, false);
      state.statusChecking = false;
    }

    if (!fromFolderNav) {
      state.pageFilter = 'all';
      state.pageSearch = '';
      state.folderSearch = '';
      state.selected.clear();
    }

    if (!state.org || !state.site) {
      state.error = `Missing org or site in DA context. ${DA_SITE_CONTEXT_MESSAGE}`;
      render(app, state);
      return;
    }

    syncBrowseLocation(state);
    cancelStatusCheck(state, false);
    state.contentLoading = true;
    state.error = null;
    state.statusCancelled = false;
    state.statusFetched = false;
    state.platformStatus = {};
    state.statusCheckFailed = false;
    state.statusError = null;
    state.statusPanelNote = null;
    state.status = 'Fetching content…';
    state.statusType = 'info';
    render(app, state);

    try {
      const isFirstWorkspaceLoad = !state.initialContentLoaded;
      const browseEntries = await listFolderEntries(
        daFetch,
        state.org,
        state.site,
        state.folderPath,
      );
      state.folders = browseEntries.filter((e) => e.kind === 'folder');

      if (state.pageScope === 'tree') {
        const nestedPages = await collectPages(
          daFetch,
          state.org,
          state.site,
          state.folderPath,
          -1,
        );
        state.pages = nestedPages.map((page) => ({
          kind: 'document',
          name: page.name,
          sourcePath: page.sourcePath,
          helixPath: page.helixPath,
        }));
      } else {
        state.pages = browseEntries.filter((e) => e.kind === 'document');
      }

      if (fromFolderNav) {
        const prev = new Set(state.selected);
        state.selected.clear();
        state.pages.forEach((p) => {
          if (prev.has(p.helixPath)) state.selected.add(p.helixPath);
        });
      }
      const docCount = state.pages.length;
      const location = displayFolderPath(state.folderPath) || 'site root';
      state.initialContentLoaded = true;
      const cacheOnlyStatus = false;
      if ((!cacheOnlyStatus || docCount === 0) && !isFirstWorkspaceLoad) {
        state.contentLoading = false;
      }

      if (docCount > 0) {
        const helixPaths = state.pages.map((p) => p.helixPath);
        startStatusCheck(
          state,
          daFetch,
          helixPaths,
          location,
          docCount,
          state.folders.length,
          {
            cacheOnly: cacheOnlyStatus,
            background: false,
          },
        );
        render(app, state);
      } else {
        finishContentLoadWithoutStatus(
          state,
          location,
          docCount,
          state.folders.length,
        );
      }
    } catch (err) {
      state.folders = [];
      state.pages = [];
      state.selected.clear();
      state.contentLoading = false;
      state.error = messageFromApiError(err, 'Failed to load content.', 'list');
      state.status = state.error;
      state.statusType = 'error';
      render(app, state);
    }
  };

  state.onSelectAll = (checked) => {
    selectAllVisible(state, checked);
    const { root } = state;
    if (!root) return;
    if (root.querySelector('#bulk-pp-page-list')) {
      patchPageSearchResults(
        root,
        state,
        { org: state.org, site: state.site, ref: state.ref },
        buildPageRow,
      );
    } else {
      render(app, state);
    }
  };

  state.onSelectionChange = () => {
    const { root } = state;
    if (!root) return;
    syncSelectionUI(root, state);
  };

  state.onRun = async (topic) => {
    const pagePaths = new Set(state.pages.map((p) => p.helixPath));
    const paths = [...state.selected].filter((path) => pagePaths.has(path));
    if (paths.length === 0) return;

    const confirmed = await confirmBulkRun(topic, paths.length);
    if (!confirmed) return;

    applyOperationWorkspaceReset(state);

    const appRoot = /** @type {HTMLElement} */ (app);
    state.loading = true;
    state.jobTopic = topic;
    state.jobDetail = null;
    state.jobAbort = new AbortController();
    state.jobStartedAt = Date.now();
    state.jobProgressProcessed = 0;
    state.jobProgressTotal = paths.length;
    state.status = topic === 'live'
      ? `Starting bulk publish for ${paths.length} page(s)…`
      : `Starting bulk preview for ${paths.length} page(s)…`;
    state.statusType = 'info';
    openJobModal(appRoot, topic, paths.length, () => state.onCancelJob());

    const host = buildSiteHost(state.org, state.site, state.ref);
    const env = topic === 'live' ? 'live' : 'preview';
    const action = topic === 'live' ? 'Bulk publish' : 'Bulk preview';

    try {
      const bulkResp = await startBulkJob(
        daFetch,
        state.org,
        state.site,
        state.ref,
        topic,
        paths,
      );
      if (state.jobAbort?.signal.aborted) return;

      const jobUrl = getJobPollUrl(
        bulkResp,
        state.org,
        state.site,
        state.ref,
        topic,
      );
      if (!jobUrl) {
        const urls = buildUrlsForPaths(
          paths,
          state.org,
          state.site,
          state.ref,
          env,
        );
        state.status = topic === 'live'
          ? `Bulk publish scheduled (${paths.length} paths).`
          : `Bulk preview scheduled (${paths.length} paths).`;
        state.statusType = 'success';
        updateJobModal({
          jobStartedAt: state.jobStartedAt,
          processed: paths.length,
          total: paths.length,
          failed: 0,
          stateLabel: 'complete',
        });
        await refreshPlatformStatusAfterJob(state, daFetch, paths, topic);
        showJobCompleteModal({
          summary: state.status,
          topic,
          urls,
          host,
          onClose: () => finishProgressModal(state),
        });
        return;
      }

      const finalJob = await pollJob(
        daFetch,
        jobUrl,
        (job) => {
          if (state.jobAbort?.signal.aborted) return;
          const progress = job.progress || job.job?.progress;
          if (progress && typeof progress === 'object') {
            const { total, processed, failed } =
              /** @type {{ total?: number, processed?: number, failed?: number }} */ (
                progress
              );
            const proc = Number(processed ?? 0);
            const tot = Number(total ?? paths.length);
            state.jobProgressProcessed = proc;
            state.jobProgressTotal = tot || paths.length;
            updateJobModal({
              jobStartedAt: state.jobStartedAt,
              processed: proc,
              total: tot || paths.length,
              failed: Number(failed ?? 0),
              stateLabel: String(job.state || job.job?.state || 'running'),
            });
          }
        },
        state.jobAbort?.signal,
      );

      if (state.jobAbort?.signal.aborted) return;

      const outcome = resolveJobOutcome(finalJob);
      state.status = `${action} ${outcome.message}`;
      state.statusType = outcome.statusType;

      let urls = [];
      if (outcome.statusType === 'success') {
        urls = buildUrlsForPaths(paths, state.org, state.site, state.ref, env);
        await refreshPlatformStatusAfterJob(state, daFetch, paths, topic);
      }

      state.jobDetail = outcome.statusType === 'error'
        || new URLSearchParams(window.location.search).has('debug')
        ? JSON.stringify(finalJob, null, 2)
        : null;

      if (outcome.statusType === 'error') {
        showJobErrorModal({
          message: state.status,
          topic,
          hint: permissionErrorHint(0, state.status),
          onClose: () => finishProgressModal(state),
        });
      } else {
        showJobCompleteModal({
          summary: state.status,
          topic,
          urls,
          host,
          onClose: () => finishProgressModal(state),
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      presentJobError(state, topic, err, topic);
    } finally {
      state.loading = false;
      state.jobAbort = null;
      state.jobStartedAt = null;
    }
  };

  state.onRunDestructive = async (action) => {
    const pageByPath = new Map(state.pages.map((p) => [p.helixPath, p]));
    const paths = getSelectedHelixPaths(state);
    if (paths.length === 0) return;

    const ok = await confirmDestructiveAction(action, paths.length);
    if (!ok) return;

    applyOperationWorkspaceReset(state);

    const appRoot = /** @type {HTMLElement} */ (app);
    const topic = /** @type {'unpreview'|'unpublish'|'delete'} */ (action);
    state.loading = true;
    state.jobTopic = topic;
    state.jobDetail = null;
    state.jobAbort = new AbortController();
    state.jobStartedAt = Date.now();
    state.jobProgressProcessed = 0;
    state.jobProgressTotal = paths.length;
    state.statusType = 'info';
    state.status = destructiveStartMessage(action, paths.length);
    openJobModal(appRoot, topic, paths.length, () => state.onCancelJob());

    /** @type {string[]} */
    const notes = [];
    let statusType = 'success';

    try {
      if (action === 'unpreview' || action === 'delete') {
        try {
          const outcome = await runRemovePartitionJob(
            state,
            daFetch,
            'preview',
            paths,
            action === 'delete' ? 'Step 1 of 3 · Unpreview' : 'Unpreview',
          );
          notes.push(`Preview removal ${outcome.message}`);
          if (outcome.statusType === 'error') statusType = 'error';
          else if (outcome.statusType === 'info' && statusType === 'success') statusType = 'info';
        } catch (phaseErr) {
          if (
            phaseErr instanceof DOMException
            && phaseErr.name === 'AbortError'
          ) return;
          notes.push(
            `Preview removal failed: ${messageFromApiError(phaseErr, 'Preview removal failed.', 'unpreview')}`,
          );
          statusType = 'error';
          console.warn('[bulk-pp] unpreview phase failed', phaseErr);
        }
        if (
          action === 'delete'
          && statusType !== 'error'
          && !state.jobAbort?.signal.aborted
        ) {
          await refreshPlatformStatusAfterJob(
            state,
            daFetch,
            paths,
            'unpreview',
          );
        }
      }

      if (state.jobAbort?.signal.aborted) return;

      if (action === 'unpublish' || action === 'delete') {
        try {
          const outcome = await runRemovePartitionJob(
            state,
            daFetch,
            'live',
            paths,
            action === 'delete' ? 'Step 2 of 3 · Unpublish' : 'Unpublish',
          );
          notes.push(`Unpublish ${outcome.message}`);
          if (outcome.statusType === 'error') statusType = 'error';
          else if (outcome.statusType === 'info' && statusType === 'success') statusType = 'info';
        } catch (phaseErr) {
          if (
            phaseErr instanceof DOMException
            && phaseErr.name === 'AbortError'
          ) return;
          notes.push(
            `Unpublish failed: ${messageFromApiError(phaseErr, 'Unpublish failed.', 'unpublish')}`,
          );
          statusType = 'error';
          console.warn('[bulk-pp] unpublish phase failed', phaseErr);
        }
        if (
          action === 'delete'
          && statusType !== 'error'
          && !state.jobAbort?.signal.aborted
        ) {
          await refreshPlatformStatusAfterJob(
            state,
            daFetch,
            paths,
            'unpublish',
          );
        }
      }

      if (state.jobAbort?.signal.aborted) return;

      if (action === 'delete') {
        const pages = paths.map((path) => pageByPath.get(path)).filter(Boolean);
        const daResult = await deleteDaDocumentsSequential(
          daFetch,
          state.org,
          state.site,
          pages,
          ({ processed, total, failed }) => {
            if (state.jobAbort?.signal.aborted) return;
            setSequentialProgress(
              state,
              paths,
              'Step 3 of 3 · Delete from DA',
              processed,
              failed,
              total,
            );
          },
          state.jobAbort?.signal,
        );

        if (daResult.deleted.length > 0) {
          removePagesFromState(state, daResult.deleted);
          notes.push(
            `Deleted ${daResult.deleted.length} document${daResult.deleted.length === 1 ? '' : 's'} from DA`,
          );
        }
        if (daResult.failed > 0) {
          statusType = daResult.deleted.length > 0 ? 'info' : 'error';
          const sample = daResult.errors
            .slice(0, 3)
            .map((e) => `${e.helixPath}: ${e.message}`)
            .join('; ');
          notes.push(
            `${daResult.failed} delete${daResult.failed === 1 ? '' : 's'} failed${sample ? ` (${sample})` : ''}`,
          );
        }
      }

      if (state.jobAbort?.signal.aborted) return;

      if (statusType !== 'error') {
        await refreshPlatformStatusAfterJob(state, daFetch, paths, action);
      }

      const summary = notes.filter(Boolean).join('. ') || 'Operation finished.';
      state.status = summary;
      state.statusType = statusType;

      updateJobModal({
        jobStartedAt: state.jobStartedAt,
        processed: paths.length,
        total: paths.length,
        failed: 0,
        stateLabel: 'complete',
      });

      if (statusType === 'error') {
        showJobErrorModal({
          message: summary,
          topic,
          hint: permissionErrorHint(0, summary),
          onClose: () => finishProgressModal(state),
        });
      } else {
        showJobCompleteModal({
          summary,
          topic,
          onClose: () => finishProgressModal(state),
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      presentJobError(state, topic, err, action);
    } finally {
      state.loading = false;
      state.jobAbort = null;
      state.jobStartedAt = null;
    }
  };

  if (!daFetch) {
    state.error = DA_LOGIN_REQUIRED_MESSAGE;
    state.status = null;
    state.statusType = 'info';
    render(app, state);
    return;
  }

  if (!ctx.org || !ctx.site) {
    state.error = DA_SITE_CONTEXT_MESSAGE;
    state.status = null;
    state.statusType = 'info';
    render(app, state);
    return;
  }

  state.contentLoading = true;
  state.status = 'Fetching content…';
  state.statusType = 'info';
  render(app, state);
  await state.onFetch(false);
}

function showBootError(err) {
  const app = document.getElementById('app');
  if (!app) return;
  const message = err instanceof Error ? err.message : String(err);
  app.replaceChildren();
  const panel = el('div', 'bulk-pp-boot-error');
  panel.append(
    el('h1', null, `${APP_TITLE} failed to start`),
    el('p', null, message),
    el(
      'p',
      'bulk-pp-boot-error-hint',
      'Hard refresh (Cmd+Shift+R). If this persists, check the browser console for the failing module.',
    ),
  );
  app.append(panel);
}

main().catch(showBootError);
