import {
  collectPages,
  deleteDaDocumentsSequential,
  fetchPlatformStatusForPaths,
  isHardcodeIndexTest,
  wrapDaFetch,
  messageFromApiError,
  getJobPollUrl,
  listFolderEntries,
  pollJob,
  resolveJobOutcome,
  runBulkRemoveJob,
  startBulkJob,
} from './lib/api.js';
import {
  displayFolderPath,
  formatPageListLabel,
  normalizeFolderPath,
  resolveContentFolderPath,
} from './lib/paths.js';
import {
  buildDaEditUrl,
  buildSiteHost,
  buildUrlsForPaths,
} from './lib/urls.js';
import {
  countStatusBreakdown,
  formatStatusDate,
  getPageStatus,
  PAGE_FILTERS,
  statusLabel,
} from './lib/page-history.js';
import {
  confirmDestructiveAction,
  confirmOpenUrlsInNewTabs,
  confirmPublishToLive,
  confirmTreeScopeFetch,
} from './lib/modal.js';
import {
  copyTextToClipboard,
  openUrlsInNewTabsQuiet,
  runButtonAction,
  shouldWarnPopupBlock,
} from './lib/ui-utils.js';
import {
  closeJobModal,
  closeStatusFetchModal,
  isJobModalOpen,
  isProgressModalOpen,
  isStatusFetchModalOpen,
  openJobModal,
  openStatusFetchModal,
  showJobCancelledModal,
  showJobCompleteModal,
  showJobErrorModal,
  showStatusFetchCompleteModal,
  showStatusFetchCancelledModal,
  showStatusFetchErrorModal,
  updateJobModal,
  updateStatusFetchModal,
} from './lib/progress-modal.js';
import { formatStatusFetchEta } from './lib/status-estimate.js';
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
  createAppState,
  formatSelectionPillText,
  getActiveSelectionCount,
  getSelectedHelixPaths,
  getVisiblePages,
  getVisibleFolders,
  isStatusLoaded,
  resetWorkspace,
  SEARCH_MIN_LEN,
  selectAllVisible,
} from './lib/state.js';
import { el } from './lib/dom.js';

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
  previewed: '#c9940a',
  published: '#2d8a4e',
};

const SDK_URL = 'https://da.live/nx/utils/sdk.js';
const SDK_TIMEOUT_MS = 8000;

const APP_TITLE = 'Content Deployment Hub';
const APP_DESCRIPTION = 'Browse pages, check deployment status, and run bulk preview, publish, and removal operations.';
const APP_FEATURES = [
  'Deployment status',
  'Bulk preview & publish',
  'Unpreview & unpublish',
  'Delete from DA',
  'Open DA & URLs',
];

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
    if (!org) org = appMatch[1];
    if (!site) site = appMatch[2];
  }
  return { org, site, ref };
}

function syncUrlPath(ref, folderPath) {
  const params = new URLSearchParams(window.location.search);
  if (ref && ref !== 'main') params.set('ref', ref);
  else params.delete('ref');
  const normalized = normalizeFolderPath(folderPath);
  if (normalized) params.set('path', normalized);
  else params.delete('path');
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', url);
}

function createPanel(title, extraClass = '') {
  const panel = el('section', `bulk-pp-panel ${extraClass}`.trim());
  const head = el('div', 'bulk-pp-panel-head');
  head.append(el('h2', null, title));
  const body = el('div', 'bulk-pp-panel-body');
  panel.append(head, body);
  return { panel, body };
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
  const icon = el('span', `bulk-pp-section-icon bulk-pp-section-icon-${variant}`);
  icon.setAttribute('aria-hidden', 'true');
  titleWrap.append(icon, el('h3', 'bulk-pp-section-title', title));
  const countEl = el('span', 'bulk-pp-section-count', String(count));
  if (countId) countEl.id = countId;
  head.append(titleWrap, countEl);
  return head;
}

/**
 * @param {Record<string, { previewedAt?: number, publishedAt?: number }>} platformStatus
 * @param {{ helixPath: string }[]} pages
 */
function buildDeploymentStatsBar(platformStatus, pages) {
  const map = /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */ ({});
  pages.forEach((p) => {
    map[p.helixPath] = platformStatus[p.helixPath] || {};
  });
  const { live, preview, none } = countStatusBreakdown(map, pages);
  const bar = el('div', 'bulk-pp-deployment-stats');
  bar.id = 'bulk-pp-deployment-stats';
  bar.setAttribute('aria-label', 'Deployment summary');
  [
    ['live', 'Published', live, 'bulk-pp-stat-live'],
    ['preview', 'Preview only', preview, 'bulk-pp-stat-preview'],
    ['none', 'neither previewed nor published', none, 'bulk-pp-stat-none'],
  ].forEach(([, label, value, mod]) => {
    const card = el('div', `bulk-pp-stat-card ${mod}`);
    card.append(
      el('span', 'bulk-pp-stat-value', String(value)),
      el('span', 'bulk-pp-stat-label', label),
    );
    bar.append(card);
  });
  const total = el('div', 'bulk-pp-stat-card bulk-pp-stat-total');
  total.append(
    el('span', 'bulk-pp-stat-value', String(pages.length)),
    el('span', 'bulk-pp-stat-label', 'Pages in view'),
  );
  bar.append(total);
  return bar;
}

function buildBreadcrumb(folderPath, onNavigate, locked = false) {
  const nav = el('nav', 'bulk-pp-breadcrumb');
  nav.setAttribute('aria-label', 'Folder path');
  const rootBtn = el('button', 'bulk-pp-breadcrumb-segment', 'Back to root');
  rootBtn.type = 'button';
  rootBtn.disabled = locked;
  if (!locked) rootBtn.addEventListener('click', () => onNavigate(''));
  nav.append(rootBtn);
  const segments = normalizeFolderPath(folderPath).split('/').filter(Boolean);
  segments.forEach((segment, index) => {
    nav.append(el('span', 'bulk-pp-breadcrumb-sep', '›'));
    const path = segments.slice(0, index + 1).join('/');
    if (index === segments.length - 1) {
      nav.append(el('span', 'bulk-pp-breadcrumb-current', segment));
    } else {
      const btn = el('button', 'bulk-pp-breadcrumb-segment', segment);
      btn.type = 'button';
      btn.disabled = locked;
      if (!locked) btn.addEventListener('click', () => onNavigate(path));
      nav.append(btn);
    }
  });
  return nav;
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
    link.title = 'Unavailable while status is loading';
    link.setAttribute('aria-disabled', 'true');
  } else {
    link.title = `Open ${folder.name}`;
    link.setAttribute('aria-label', `Open folder ${folder.name}`);
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

function buildStatusDot(status) {
  const dot = el('span', `bulk-pp-status-dot bulk-pp-status-dot-${status}`);
  dot.setAttribute('aria-label', statusLabel(status));
  dot.title = statusLabel(status);
  return dot;
}

function buildStatusDotPending() {
  const dot = el('span', 'bulk-pp-status-dot bulk-pp-status-dot-pending');
  dot.setAttribute('aria-label', 'Status loading');
  return dot;
}

function buildPageRow(page, entry, browseFolder, state, showStatus, siteCtx, interactionsLocked = false) {
  const li = el('li', 'bulk-pp-list-item bulk-pp-list-item-document');
  const cb = document.createElement('input');
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
  const { title, subtitle } = formatPageListLabel(page.helixPath, page.name, browseFolder);
  const labelWrap = el('div', 'bulk-pp-item-main');
  const label = document.createElement('label');
  label.htmlFor = cb.id;
  label.className = 'bulk-pp-item-label';
  label.textContent = title;
  labelWrap.append(label);
  if (subtitle) labelWrap.append(el('span', 'bulk-pp-item-subtitle', subtitle));

  if (showStatus) {
    const dateParts = [];
    if (entry?.previewedAt) dateParts.push(`Preview ${formatStatusDate(entry.previewedAt)}`);
    if (entry?.publishedAt) dateParts.push(`Published ${formatStatusDate(entry.publishedAt)}`);
    if (dateParts.length) labelWrap.append(el('span', 'bulk-pp-item-dates', dateParts.join(' · ')));
  }

  const rowActions = el('div', 'bulk-pp-row-actions');
  const daUrl = buildDaEditUrl(siteCtx.org, siteCtx.site, page.helixPath, page.sourcePath, siteCtx.ref);
  const multiSelected = getActiveSelectionCount(state) > 1;
  const daDisabled = interactionsLocked || multiSelected;
  const daLink = document.createElement('a');
  daLink.className = 'bulk-pp-btn bulk-pp-btn-open-da';
  daLink.dataset.href = daUrl;
  if (daDisabled) {
    daLink.classList.add('bulk-pp-btn-open-da-disabled');
    daLink.setAttribute('aria-disabled', 'true');
    daLink.title = multiSelected
      ? 'Use “Open DA URL for selected” in the toolbar when multiple pages are selected'
      : 'Unavailable while status is loading';
    daLink.textContent = 'DA';
    daLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  } else {
    daLink.href = daUrl;
    daLink.target = '_top';
    daLink.rel = 'noopener noreferrer';
    daLink.textContent = 'DA';
    daLink.title = 'Open this page in Document Authoring';
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
  rowActions.append(showStatus ? buildStatusDot(getPageStatus(entry)) : buildStatusDotPending());
  li.append(cb, icon, labelWrap, rowActions);
  return li;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {'preview'|'live'} env
 * @returns {string[]}
 */
function collectDeployedHelixPaths(state, env) {
  return state.pages
    .map((p) => p.helixPath)
    .filter((helixPath) => {
      const entry = state.platformStatus[helixPath];
      if (env === 'live') return Boolean(entry?.publishedAt);
      return Boolean(entry?.previewedAt);
    });
}

/**
 * @param {string[]} urls
 * @param {ReturnType<typeof createAppState>} [state]
 */
async function openUrlsInNewTabs(urls, state = null) {
  if (urls.length === 0) return;
  const ok = await confirmOpenUrlsInNewTabs(urls.length);
  if (!ok) return;
  const result = openUrlsInNewTabsQuiet(urls);
  if (shouldWarnPopupBlock(result) && state) {
    state.status = 'Your browser blocked new tabs. Allow pop-ups for this site, or use Copy URLs on the Urls tab.';
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
 * Open-in-browser actions for the current selection.
 * @param {HTMLElement} group
 * @param {ReturnType<typeof createAppState>} state
 */
function appendOpenSelectedActionButtons(group, state) {
  const count = getActiveSelectionCount(state);
  group.id = 'bulk-pp-open-selected-group';
  group.hidden = count === 0;

  const countHint = count === 1 ? '1 page' : `${count} pages`;
  const actionDisabled = count === 0 || state.statusChecking || state.loading || state.contentLoading;

  const daBtn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-action-outline-neutral',
    'Open DA URL for selected',
  );
  daBtn.type = 'button';
  daBtn.id = 'bulk-pp-open-selected-da';
  daBtn.title = `Open Document Authoring for ${countHint}`;
  daBtn.disabled = actionDisabled;
  daBtn.addEventListener('click', () => {
    void openSelectedDa(state);
  });

  const previewBtn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-action-outline-preview',
    'Open preview URL for selected',
  );
  previewBtn.type = 'button';
  previewBtn.id = 'bulk-pp-open-selected-preview';
  previewBtn.title = `Open .aem.page preview URL for ${countHint}`;
  previewBtn.disabled = actionDisabled;
  previewBtn.addEventListener('click', () => {
    void openSelectedUrls(state, 'preview');
  });

  const liveBtn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-action-outline-publish',
    'Open publish URL for selected',
  );
  liveBtn.type = 'button';
  liveBtn.id = 'bulk-pp-open-selected-live';
  liveBtn.title = `Open .aem.live publish URL for ${countHint}`;
  liveBtn.disabled = actionDisabled;
  liveBtn.addEventListener('click', () => {
    void openSelectedUrls(state, 'live');
  });

  group.append(daBtn, previewBtn, liveBtn);
}

/**
 * @param {HTMLElement} group
 * @param {ReturnType<typeof createAppState>} state
 */
function appendRunSelectedButtons(group, state) {
  const count = getActiveSelectionCount(state);
  const runDisabled = state.loading
    || state.contentLoading
    || state.statusChecking
    || isJobModalOpen()
    || count === 0;

  const previewBtn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-action-preview',
    'Preview selected',
  );
  previewBtn.type = 'button';
  previewBtn.id = 'bulk-pp-preview-btn';
  previewBtn.title = count === 0
    ? 'Select pages to preview'
    : `Bulk preview ${count} selected page${count === 1 ? '' : 's'}`;
  previewBtn.disabled = runDisabled;
  previewBtn.addEventListener('click', () => state.onRun('preview'));

  const publishBtn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-action-publish',
    'Publish selected',
  );
  publishBtn.type = 'button';
  publishBtn.id = 'bulk-pp-publish-btn';
  publishBtn.title = count === 0
    ? 'Select pages to publish'
    : `Publish ${count} selected page${count === 1 ? '' : 's'} to production`;
  publishBtn.disabled = runDisabled;
  publishBtn.addEventListener('click', () => state.onRun('live'));

  group.append(previewBtn, publishBtn);
}

/**
 * @param {HTMLElement} group
 * @param {ReturnType<typeof createAppState>} state
 */
function appendDestructiveButtons(group, state) {
  const count = getActiveSelectionCount(state);
  const disabled = state.loading
    || state.contentLoading
    || state.statusChecking
    || isJobModalOpen()
    || count === 0;

  const unpreviewBtn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-action-outline-danger',
    'Unpreview selected',
  );
  unpreviewBtn.type = 'button';
  unpreviewBtn.id = 'bulk-pp-unpreview-btn';
  unpreviewBtn.title = count === 0
    ? 'Select pages to remove from preview'
    : `Remove preview for ${count} selected page${count === 1 ? '' : 's'}`;
  unpreviewBtn.disabled = disabled;
  unpreviewBtn.addEventListener('click', () => state.onRunDestructive('unpreview'));

  const unpublishBtn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-action-outline-danger',
    'Unpublish selected',
  );
  unpublishBtn.type = 'button';
  unpublishBtn.id = 'bulk-pp-unpublish-btn';
  unpublishBtn.title = count === 0
    ? 'Select pages to unpublish from live'
    : `Unpublish ${count} selected page${count === 1 ? '' : 's'} from production`;
  unpublishBtn.disabled = disabled;
  unpublishBtn.addEventListener('click', () => state.onRunDestructive('unpublish'));

  const deleteBtn = el(
    'button',
    'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-action-delete',
    'Delete selected from DA',
  );
  deleteBtn.type = 'button';
  deleteBtn.id = 'bulk-pp-delete-btn';
  deleteBtn.title = count === 0
    ? 'Select pages to delete from Document Authoring'
    : `Unpreview, unpublish, and delete ${count} selected page${count === 1 ? '' : 's'} from DA`;
  deleteBtn.disabled = disabled;
  deleteBtn.addEventListener('click', () => state.onRunDestructive('delete'));

  group.append(unpreviewBtn, unpublishBtn, deleteBtn);
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
function setSequentialProgress(state, paths, phaseLabel, processed, failed, total = paths.length) {
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
async function runRemovePartitionJob(state, daFetch, partition, paths, phaseLabel) {
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
 * @param {ReturnType<typeof createAppState>} state
 * @param {{ visiblePages: { helixPath: string }[], statusChecking: boolean }} opts
 */
function buildPageToolbar(state, { visiblePages, statusChecking }) {
  const toolbar = el('div', 'bulk-pp-toolbar');
  const main = el('div', 'bulk-pp-toolbar-main');

  const selectionGroup = el('div', 'bulk-pp-toolbar-group');
  selectionGroup.setAttribute('aria-label', 'Selection');
  const selectAllBtn = el('button', 'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-secondary', 'Select all');
  const selectNoneBtn = el('button', 'bulk-pp-btn bulk-pp-btn-toolbar bulk-pp-btn-secondary', 'Clear');
  selectAllBtn.type = 'button';
  selectNoneBtn.type = 'button';
  selectAllBtn.id = 'bulk-pp-select-all';
  selectNoneBtn.id = 'bulk-pp-select-none';
  selectAllBtn.disabled = visiblePages.length === 0 || statusChecking;
  selectNoneBtn.disabled = visiblePages.length === 0
    || statusChecking
    || getActiveSelectionCount(state) === 0;
  selectAllBtn.addEventListener('click', () => state.onSelectAll(true));
  selectNoneBtn.addEventListener('click', () => state.onSelectAll(false));
  selectionGroup.append(selectAllBtn, selectNoneBtn);

  const publishGroup = el('div', 'bulk-pp-toolbar-group bulk-pp-toolbar-group-publish');
  publishGroup.setAttribute('aria-label', 'Deploy selected');
  appendRunSelectedButtons(publishGroup, state);

  const destructiveGroup = el('div', 'bulk-pp-toolbar-group bulk-pp-toolbar-group-destructive');
  destructiveGroup.setAttribute('aria-label', 'Remove selected');
  appendDestructiveButtons(destructiveGroup, state);

  const openGroup = el('div', 'bulk-pp-toolbar-group bulk-pp-toolbar-group-open');
  openGroup.setAttribute('aria-label', 'Open selected');
  appendOpenSelectedActionButtons(openGroup, state);

  main.append(selectionGroup, publishGroup, destructiveGroup, openGroup);
  toolbar.append(
    main,
    el('span', 'bulk-pp-selection-pill', formatSelectionPillText(state)),
  );
  toolbar.querySelector('.bulk-pp-selection-pill').id = 'bulk-pp-selection-pill';
  return toolbar;
}

function buildStatusLegend() {
  const legend = el('div', 'bulk-pp-status-legend');
  legend.setAttribute('aria-label', 'Status key');
  [
    ['untouched', 'Not previewed'],
    ['previewed', 'Preview only'],
    ['published', 'Published'],
  ].forEach(([key, text]) => {
    const item = el('span', 'bulk-pp-legend-item');
    const dot = el('span', 'bulk-pp-legend-dot');
    dot.style.background = STATUS_COLOR[/** @type {keyof STATUS_COLOR} */ (key)];
    item.append(dot, document.createTextNode(text));
    legend.append(item);
  });
  return legend;
}

/**
 * Uncheck "Load preview & publish status on Fetch" after a status run finishes.
 * @param {ReturnType<typeof createAppState>} state
 */
function resetFetchStatusOption(state) {
  state.fetchStatus = false;
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {'status'|'job'} kind
 */
function finishProgressModal(state, kind) {
  const root = /** @type {HTMLElement | null} */ (state.root);
  if (kind === 'job') {
    closeJobModal(root);
    state.jobTopic = null;
    state.jobAbort = null;
    state.jobStartedAt = null;
  } else {
    closeStatusFetchModal(root);
    resetFetchStatusOption(state);
  }
  if (root) render(root, state);
}

/**
 * @param {HTMLElement} container
 * @param {string} title
 * @param {string} host
 * @param {string[]} urls
 * @param {ReturnType<typeof createAppState>} state
 */
function appendUrlSection(container, title, host, urls, state) {
  const section = el('div', 'bulk-pp-url-section');
  const head = el('div', 'bulk-pp-url-section-head');
  const titleEl = el('h3', 'bulk-pp-url-section-title', title);
  head.append(titleEl);
  if (urls.length > 0) {
    const count = urls.length;
    const actions = el('div', 'bulk-pp-url-section-actions');
    const copyBtn = el(
      'button',
      'bulk-pp-btn bulk-pp-btn-ghost bulk-pp-btn-copy-urls',
      'Copy URLs',
    );
    copyBtn.type = 'button';
    copyBtn.title = `Copy ${count} URL${count === 1 ? '' : 's'} to clipboard`;
    copyBtn.addEventListener('click', () => {
      runButtonAction(copyBtn, 'Copied', 'Copy failed', 'Copy URLs', async () => {
        await copyTextToClipboard(urls.join('\n'));
      });
    });
    const openAllBtn = el(
      'button',
      'bulk-pp-btn bulk-pp-btn-open-urls bulk-pp-btn-open-all-urls',
      `Open all URLs (${count})`,
    );
    openAllBtn.type = 'button';
    openAllBtn.title = `Open ${count} URL${count === 1 ? '' : 's'} in separate browser tabs`;
    openAllBtn.addEventListener('click', () => {
      openUrlsInNewTabs(urls, state).catch(() => {});
    });
    actions.append(copyBtn, openAllBtn);
    head.append(actions);
  }
  section.append(head);
  section.append(el('p', 'bulk-pp-url-host', host));
  const listWrap = el('div', 'bulk-pp-list-wrap');
  const list = el('ul', 'bulk-pp-url-list');
  if (urls.length === 0) {
    list.append(el('li', 'bulk-pp-list-empty', 'No URLs for this operation.'));
  } else {
    urls.forEach((url) => {
      const li = el('li');
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = url;
      li.append(link);
      list.append(li);
    });
  }
  listWrap.append(list);
  section.append(listWrap);
  container.append(section);
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createAppState>} state
 */
function render(root, state) {
  const listWrapBefore = document.getElementById('bulk-pp-page-list-wrap');
  const savedListScroll = listWrapBefore ? listWrapBefore.scrollTop : null;
  const savedWindowY = window.scrollY;

  const {
    org, site, ref, folderPath, loading, error, status, statusType, jobDetail,
    activeTab, pageScope, pageFilter, statusCheckFailed, statusError,
    statusChecking, pageSearch, folderSearch, contentLoading, lastOperation,
    fetchStatus, statusFetched,
  } = state;

  const { visible: visiblePages, statusMap, browseFolder } = getVisiblePages(state);
  const visibleFolders = getVisibleFolders(state);
  const busy = loading || contentLoading || statusChecking;
  const searchDraft = String(pageSearch || '').trim();
  const searchTooShort = searchDraft.length > 0 && searchDraft.length < SEARCH_MIN_LEN;
  const folderSearchDraft = String(folderSearch || '').trim();
  const folderSearchTooShort = folderSearchDraft.length > 0
    && folderSearchDraft.length < SEARCH_MIN_LEN;

  root.replaceChildren();
  root.classList.toggle('bulk-pp-modal-open', isProgressModalOpen());

  const header = el('header', 'bulk-pp-header');
  const headerInner = el('div', 'bulk-pp-header-inner');
  const headerBrand = el('div', 'bulk-pp-header-brand');
  headerBrand.append(
    el('span', 'bulk-pp-header-eyebrow', 'Adobe Experience Manager · Edge Delivery'),
    el('h1', null, APP_TITLE),
    el('p', 'bulk-pp-header-desc', APP_DESCRIPTION),
  );
  const featureList = el('ul', 'bulk-pp-header-features');
  featureList.setAttribute('aria-label', 'Capabilities');
  APP_FEATURES.forEach((label) => {
    featureList.append(el('li', 'bulk-pp-header-feature', label));
  });
  headerBrand.append(featureList);
  const headerMeta = el('div', 'bulk-pp-header-meta');
  headerMeta.append(
    el('span', 'bulk-pp-badge', org),
    el('span', 'bulk-pp-badge bulk-pp-badge-muted', site),
    el('span', 'bulk-pp-badge bulk-pp-badge-muted', ref),
  );
  headerInner.append(headerBrand, headerMeta);
  header.append(headerInner);
  root.append(header);

  const { panel: browse, body: browseBody } = createPanel('Workspace');
  const row = el('div', 'bulk-pp-row');
  const pathField = el('div', 'bulk-pp-field');
  pathField.append(el('label', null, 'Jump to path'));
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.placeholder = '/who-we-are or leave empty for site root';
  const safeFolder = resolveContentFolderPath(folderPath);
  pathInput.value = displayFolderPath(safeFolder);
  pathInput.autocomplete = 'off';
  pathInput.id = 'bulk-pp-path';
  pathInput.disabled = busy;
  pathField.append(pathInput);
  row.append(pathField);

  const depthField = el('div', 'bulk-pp-field bulk-pp-field-narrow');
  depthField.append(el('label', null, 'Pages to show'));
  const depthSelect = document.createElement('select');
  depthSelect.id = 'bulk-pp-depth';
  depthSelect.disabled = busy;
  [['folder', 'This folder'], ['tree', 'All subfolders']].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === pageScope) opt.selected = true;
    depthSelect.append(opt);
  });
  depthField.append(depthSelect);
  row.append(depthField);

  const fetchBtn = el('button', 'bulk-pp-btn bulk-pp-btn-primary', contentLoading ? 'Fetching…' : 'Fetch');
  fetchBtn.type = 'button';
  fetchBtn.id = 'bulk-pp-fetch-btn';
  fetchBtn.disabled = busy;
  row.append(fetchBtn);
  browseBody.append(row);

  const statusCard = el('div', 'bulk-pp-status-fetch-option');
  const statusOptLabel = document.createElement('label');
  statusOptLabel.className = 'bulk-pp-status-fetch-label';
  const statusOptCb = document.createElement('input');
  statusOptCb.type = 'checkbox';
  statusOptCb.id = 'bulk-pp-fetch-status';
  statusOptCb.checked = Boolean(fetchStatus);
  statusOptCb.disabled = busy;
  const statusCopy = el('span', 'bulk-pp-status-fetch-copy');
  statusCopy.append(
    el('span', 'bulk-pp-status-fetch-title', 'Load preview & publish status on Fetch'),
    el(
      'span',
      'bulk-pp-status-fetch-hint',
      'Select checkbox to fetch Deployment status of pages',
    ),
  );
  statusOptLabel.append(statusOptCb, statusCopy);
  statusCard.append(statusOptLabel);
  browseBody.append(statusCard);
  root.append(browse);

  const contentPanel = el('section', 'bulk-pp-panel bulk-pp-panel-content');
  const contentHead = el('div', 'bulk-pp-panel-head');
  contentHead.append(el('h2', null, 'Site content'));
  contentPanel.append(contentHead);
  const tabBar = el('div', 'bulk-pp-tabs');
  const pagesTabBtn = el('button', 'bulk-pp-tab', 'Browse');
  const urlsTabBtn = el('button', 'bulk-pp-tab', 'Urls');
  pagesTabBtn.type = 'button';
  urlsTabBtn.type = 'button';
  if (activeTab === 'pages') pagesTabBtn.classList.add('bulk-pp-tab-active');
  else urlsTabBtn.classList.add('bulk-pp-tab-active');
  tabBar.append(pagesTabBtn, urlsTabBtn);
  contentPanel.append(tabBar);

  const pagesPane = el('div', 'bulk-pp-tab-pane');
  if (activeTab === 'pages') pagesPane.classList.add('bulk-pp-tab-pane-active');

  if (contentLoading && activeTab === 'pages') {
    pagesPane.append(el('p', 'bulk-pp-list-empty', 'Fetching content…'));
  } else if (error && activeTab === 'pages') {
    pagesPane.append(el('p', 'bulk-pp-list-empty bulk-pp-list-empty-error', error));
  } else if (state.pages.length === 0 && state.folders.length === 0 && !statusChecking) {
    pagesPane.append(el(
      'p',
      'bulk-pp-list-empty',
      'No folders or pages in this location.',
    ));
  } else {
    const workspace = el('div', 'bulk-pp-workspace');
    const contentGrid = el('div', 'bulk-pp-content-grid');
    const inSubfolder = Boolean(normalizeFolderPath(safeFolder));
    const showFolderSection = state.folders.length > 0 || inSubfolder;

    if (showFolderSection) {
      const folderSection = el('section', 'bulk-pp-content-section bulk-pp-content-section-folders');
      const folderCountLabel = folderSearchDraft && !folderSearchTooShort
        ? `${visibleFolders.length} of ${state.folders.length}`
        : String(state.folders.length);
      folderSection.append(buildSectionHead('Folders', folderCountLabel, 'bulk-pp-folder-count', 'folders'));

      if (inSubfolder) {
        folderSection.append(buildBreadcrumb(
          safeFolder,
          (path) => state.onNavigate(path),
          statusChecking,
        ));
      }

      const { wrap: folderSearchField, input: folderSearchInput } = buildSearchField(
        'bulk-pp-folder-search',
        'Find a folder',
        String(folderSearch || ''),
        statusChecking,
        searchHintText(folderSearch),
      );
      const folderSearchRow = el('div', 'bulk-pp-search-row');
      folderSearchRow.append(folderSearchField);
      folderSection.append(folderSearchRow);

      const folderWrap = el('div', 'bulk-pp-list-wrap bulk-pp-list-wrap-folders');
      const folderList = el('ul', 'bulk-pp-list');
      folderList.id = 'bulk-pp-folder-list';
      if (visibleFolders.length === 0) {
        const folderEmptyMsg = folderSearchTooShort
          ? `Type at least ${SEARCH_MIN_LEN} characters to search.`
          : folderSearchDraft
            ? 'No folders match this search.'
            : 'No folders in this location.';
        folderList.append(el('li', 'bulk-pp-list-empty', folderEmptyMsg));
      } else {
        visibleFolders.forEach((folder) => {
          folderList.append(buildFolderRow(
            folder,
            (path) => state.onNavigate(path),
            statusChecking,
          ));
        });
      }
      folderWrap.append(folderList);
      folderSection.append(folderWrap);
      contentGrid.append(folderSection);

      bindSearchInput(folderSearchInput, state, 'folder', () => {
        patchFolderSearchResults(root, state, buildFolderRow);
      });
    }

    const pagesSection = el('section', 'bulk-pp-content-section bulk-pp-content-section-pages');
    const pageCountLabel = searchDraft && !searchTooShort
      ? `${visiblePages.length} of ${state.pages.length}`
      : String(state.pages.length);
    pagesSection.append(buildSectionHead('Pages', pageCountLabel, 'bulk-pp-page-count', 'pages'));

    if (statusCheckFailed && !isStatusFetchModalOpen()) {
      pagesSection.append(el(
        'p',
        'bulk-pp-status-note bulk-pp-status-note-error',
        statusError || 'Could not load deployment status from AEM.',
      ));
    } else if (state.pages.length > 0 && statusFetched) {
      pagesSection.append(buildDeploymentStatsBar(state.platformStatus, state.pages));
    } else if (state.pages.length > 0) {
      const statusRow = el('div', 'bulk-pp-status-row');
      const etaHint = formatStatusFetchEta(state.pages.length);
      statusRow.append(el(
        'p',
        'bulk-pp-status-note bulk-pp-status-note-muted',
        etaHint
          ? `Preview/publish status not loaded. Fetch usually takes ${etaHint} for ${state.pages.length} pages.`
          : 'Preview/publish status not loaded. Fetch Deployment status to see dots and filters.',
      ));
      const checkStatusBtn = el(
        'button',
        'bulk-pp-btn bulk-pp-btn-fetch-deployment',
        'Fetch Deployment status',
      );
      checkStatusBtn.type = 'button';
      checkStatusBtn.id = 'bulk-pp-check-status';
      checkStatusBtn.disabled = contentLoading || statusChecking;
      checkStatusBtn.addEventListener('click', () => state.onCheckStatus());
      statusRow.append(checkStatusBtn);
      pagesSection.append(statusRow);
    }

    const controls = el('div', 'bulk-pp-pages-controls');
    const filterRow = el('div', 'bulk-pp-pages-filter-row');
    const filterField = el('div', 'bulk-pp-field bulk-pp-field-filter');
    filterField.append(el('label', null, 'Filter pages'));
    const filterSelect = document.createElement('select');
    filterSelect.id = 'bulk-pp-page-filter';
    const filtersLocked = statusChecking || !statusFetched;
    filterSelect.disabled = filtersLocked;
    PAGE_FILTERS.forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === (pageFilter || 'all')) opt.selected = true;
      if (filtersLocked && value !== 'all') {
        opt.disabled = true;
        opt.textContent = `${label} (requires status)`;
      }
      filterSelect.append(opt);
    });
    filterField.append(filterSelect);
    filterRow.append(
      filterField,
      buildStatusLegend(),
      el(
        'p',
        'bulk-pp-pages-filter-note',
        filtersLocked
          ? 'Fetch Deployment status to unlock filters'
          : 'Folder scope only · resets on navigation',
      ),
    );
    controls.append(filterRow);

    const { wrap: searchField, input: searchInput } = buildSearchField(
      'bulk-pp-page-search',
      'Find a page',
      String(pageSearch || ''),
      statusChecking,
      searchHintText(pageSearch),
    );
    const searchRow = el('div', 'bulk-pp-pages-search-row');
    searchRow.append(searchField);
    controls.append(searchRow);
    pagesSection.append(controls);

    pagesSection.append(buildPageToolbar(state, { visiblePages, statusChecking }));

    const pageWrap = el('div', 'bulk-pp-list-wrap');
    pageWrap.id = 'bulk-pp-page-list-wrap';
    const pageList = el('ul', 'bulk-pp-list');
    pageList.id = 'bulk-pp-page-list';
    if (state.pages.length === 0) {
      pageList.append(el('li', 'bulk-pp-list-empty', 'No pages in this scope.'));
    } else if (visiblePages.length === 0) {
      const emptyMsg = searchTooShort
        ? `Type at least ${SEARCH_MIN_LEN} characters to search.`
        : searchDraft
          ? 'No pages match this search.'
          : 'No pages match this filter.';
      pageList.append(el('li', 'bulk-pp-list-empty', emptyMsg));
    } else {
      visiblePages.forEach((page) => {
        pageList.append(buildPageRow(
          page,
          statusMap[page.helixPath],
          browseFolder,
          state,
          isStatusLoaded(state),
          { org, site, ref },
          statusChecking,
        ));
      });
    }
    pageWrap.append(pageList);
    pagesSection.append(pageWrap);
    contentGrid.append(pagesSection);
    workspace.append(contentGrid);
    pagesPane.append(workspace);

    filterSelect.addEventListener('change', () => {
      state.pageFilter = filterSelect.value;
      patchPageSearchResults(root, state, { org, site, ref }, buildPageRow);
    });
    bindSearchInput(searchInput, state, 'page', () => {
      patchPageSearchResults(root, state, { org, site, ref }, buildPageRow);
    });
    syncSelectionUI(root, state);
  }
  contentPanel.append(pagesPane);

  const urlsPane = el('div', 'bulk-pp-tab-pane');
  if (activeTab === 'urls') urlsPane.classList.add('bulk-pp-tab-pane-active');
  if (lastOperation) {
    appendUrlSection(urlsPane, lastOperation.title, lastOperation.host, lastOperation.urls, state);
    urlsPane.append(el(
      'p',
      'bulk-pp-url-operation-note',
      `${lastOperation.paths.length} page(s) · completed ${new Date(lastOperation.completedAt).toLocaleString()}`,
    ));
  } else {
    urlsPane.append(el(
      'p',
      'bulk-pp-list-empty',
      'Run Preview or Publish on selected pages to see URLs from that operation here.',
    ));
  }
  contentPanel.append(urlsPane);
  root.append(contentPanel);

  if (status && !statusChecking && statusType === 'error') {
    const statusEl = el('div', `bulk-pp-status bulk-pp-status-${statusType}`);
    statusEl.setAttribute('role', 'alert');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.append(el('strong', null, status));
    if (jobDetail) statusEl.append(el('pre', 'bulk-pp-error-detail', jobDetail));
    root.append(statusEl);
  } else if (jobDetail && new URLSearchParams(window.location.search).has('debug')) {
    const statusEl = el('div', 'bulk-pp-status bulk-pp-status-info');
    statusEl.append(el('pre', 'bulk-pp-error-detail', jobDetail));
    root.append(statusEl);
  }

  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') state.onFetch(false);
  });
  pathInput.addEventListener('change', () => {
    state.folderPath = normalizeFolderPath(pathInput.value.trim());
  });
  statusOptCb.addEventListener('change', () => {
    state.fetchStatus = statusOptCb.checked;
  });
  fetchBtn.addEventListener('click', () => state.onFetch(false));
  pagesTabBtn.addEventListener('click', () => state.onTab('pages'));
  urlsTabBtn.addEventListener('click', () => state.onTab('urls'));

  requestAnimationFrame(() => {
    if (savedListScroll != null) {
      const listWrap = document.getElementById('bulk-pp-page-list-wrap');
      if (listWrap) listWrap.scrollTop = savedListScroll;
    }
    if (savedWindowY > 0) window.scrollTo(0, savedWindowY);
  });
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {Function | null} daFetch
 * @param {string[]} pathsToCheck
 * @param {string} location
 * @param {number} docCount
 * @param {number} folderCount
 */
function startStatusCheck(state, daFetch, pathsToCheck, location, docCount, folderCount) {
  cancelStatusCheck(state, false);
  state.statusCancelled = false;
  state.statusCheckFailed = false;
  state.statusError = null;
  state.statusChecking = pathsToCheck.length > 0;
  state.statusProgressDone = 0;
  state.statusProgressTotal = pathsToCheck.length;
  state.statusFetchStartedAt = pathsToCheck.length > 0 ? Date.now() : null;
  state.statusAbort = new AbortController();

  if (pathsToCheck.length === 0) {
    state.statusChecking = false;
    state.statusFetched = false;
    resetFetchStatusOption(state);
    state.status = folderCount === 0 && docCount === 0
      ? `No folders or pages in ${location}.`
      : `Loaded ${docCount} page(s) in ${location}.`;
    state.statusType = 'info';
    render(/** @type {HTMLElement} */ (state.root), state);
    return;
  }

  const appRoot = /** @type {HTMLElement | null} */ (state.root);
  openStatusFetchModal(appRoot, state, () => state.onCancelStatus());
  render(appRoot, state);

  fetchPlatformStatusForPaths(
    daFetch,
    state.org,
    state.site,
    state.ref,
    pathsToCheck,
    (partial, done, total) => {
      state.platformStatus = { ...partial };
      state.statusProgressDone = done;
      state.statusProgressTotal = total;
      updateStatusFetchModal(state);
    },
    { signal: state.statusAbort.signal },
  ).then((platformStatus) => {
    if (state.statusAbort?.signal.aborted) return;
    state.platformStatus = platformStatus;
    state.statusChecking = false;
    state.statusFetched = true;
    state.statusAbort = null;
    state.statusFetchStartedAt = null;
    state.statusProgressDone = pathsToCheck.length;
    state.statusProgressTotal = pathsToCheck.length;
    const statusMap = /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */ ({});
    state.pages.forEach((p) => {
      statusMap[p.helixPath] = platformStatus[p.helixPath] || {};
    });
    const { live, preview, none } = countStatusBreakdown(statusMap, state.pages);
    resetFetchStatusOption(state);
    state.status = null;
    state.statusType = 'success';
    showStatusFetchCompleteModal({
      live,
      previewOnly: preview,
      none,
      total: state.pages.length,
      onClose: () => finishProgressModal(state, 'status'),
    });
  }).catch((statusErr) => {
    if (statusErr instanceof DOMException && statusErr.name === 'AbortError') {
      state.statusAbort = null;
      state.statusFetchStartedAt = null;
      resetFetchStatusOption(state);
      return;
    }
    state.statusChecking = false;
    state.statusFetched = false;
    state.statusAbort = null;
    state.statusFetchStartedAt = null;
    state.statusCheckFailed = true;
    resetFetchStatusOption(state);
    state.statusError = messageFromApiError(statusErr, 'Status check failed');
    console.warn('[bulk-pp] platform status failed', statusErr);
    showStatusFetchErrorModal({
      message: state.statusError,
      onClose: () => finishProgressModal(state, 'status'),
    });
  });
}

/**
 * @param {ReturnType<typeof createAppState>} state
 * @param {string} location
 * @param {number} docCount
 * @param {number} folderCount
 */
function finishContentLoadWithoutStatus(state, location, docCount, folderCount) {
  state.statusChecking = false;
  state.statusFetched = false;
  state.statusCheckFailed = false;
  state.statusError = null;
  state.platformStatus = {};
  if (folderCount === 0 && docCount === 0) {
    state.status = `No folders or pages in ${location}.`;
  } else if (state.pageScope === 'tree') {
    state.status = `Loaded ${docCount} page(s) under ${location}. `
      + 'Use Fetch Deployment status for preview/publish dots.';
  } else {
    state.status = `Loaded ${docCount} page(s) and ${folderCount} folder(s) in ${location}. `
      + 'Use Fetch Deployment status for preview/publish dots.';
  }
  state.statusType = 'info';
  render(/** @type {HTMLElement} */ (state.root), state);
}

async function main() {
  const app = document.getElementById('app');
  if (!app) return;

  const { context, actions } = await initSdk();
  const hasSdkFetch = typeof actions.daFetch === 'function';
  const daFetch = hasSdkFetch ? wrapDaFetch(actions.daFetch) : null;
  const ctx = resolveSiteContext(context);

  const state = createAppState(ctx);
  state.root = app;
  resetWorkspace(state);
  const urlParams = new URLSearchParams(window.location.search);
  const urlRef = urlParams.get('ref');
  if (urlRef) state.ref = urlRef;
  const urlPath = urlParams.get('path');
  if (urlPath) state.folderPath = resolveContentFolderPath(normalizeFolderPath(urlPath));
  syncUrlPath(state.ref, state.folderPath);

  state.onTab = (tab) => {
    state.activeTab = tab;
    render(app, state);
  };

  state.onCancelStatus = () => {
    const checked = state.statusProgressDone;
    const total = state.statusProgressTotal;
    cancelStatusCheck(state, false);
    resetFetchStatusOption(state);
    if (app) syncSelectionUI(app, state);
    const partialNote = checked > 0
      ? `Status results for ${checked} of ${total} pages are kept in the list. `
      : '';
    showStatusFetchCancelledModal({
      message: `${partialNote}Stopping the check does not undo requests already sent to AEM. You can run Fetch Deployment status again anytime.`,
      onClose: () => finishProgressModal(state, 'status'),
    });
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
        finishProgressModal(state, 'job');
      },
    });
  };

  state.onCheckStatus = () => {
    if (state.statusChecking || state.contentLoading || state.pages.length === 0) return;
    state.fetchStatus = true;
    const location = displayFolderPath(state.folderPath) || 'site root';
    startStatusCheck(
      state,
      daFetch,
      state.pages.map((p) => p.helixPath),
      location,
      state.pages.length,
      state.folders.length,
    );
  };

  state.onNavigate = async (targetPath) => {
    cancelStatusCheck(state, false);
    state.folderPath = resolveContentFolderPath(targetPath);
    state.pageSearch = '';
    state.folderSearch = '';
    state.pageFilter = 'all';
    syncUrlPath(state.ref, state.folderPath);
    await state.onFetch(true);
  };

  state.onFetch = async (fromFolderNav = false) => {
    if (state.statusChecking) return;

    if (!fromFolderNav) {
      const pathInput = document.getElementById('bulk-pp-path');
      const depthSelect = document.getElementById('bulk-pp-depth');
      const statusOptEl = document.getElementById('bulk-pp-fetch-status');
      const rawPath = pathInput instanceof HTMLInputElement ? pathInput.value : '';
      state.folderPath = resolveContentFolderPath(normalizeFolderPath(rawPath));
      if (depthSelect instanceof HTMLSelectElement) {
        state.pageScope = depthSelect.value === 'tree' ? 'tree' : 'folder';
      }
      if (statusOptEl instanceof HTMLInputElement) {
        state.fetchStatus = statusOptEl.checked;
      }
      state.pageFilter = 'all';
    }

    if (state.pageScope === 'tree' && state.fetchStatus && !fromFolderNav) {
      const ok = await confirmTreeScopeFetch();
      if (!ok) return;
    }

    if (!state.org || !state.site) {
      state.error = 'Missing org or site in DA context. Open this app from Document Authoring.';
      render(app, state);
      return;
    }

    syncUrlPath(state.ref, state.folderPath);
    cancelStatusCheck(state, false);
    state.contentLoading = true;
    state.error = null;
    state.statusCancelled = false;
    state.statusFetched = false;
    state.platformStatus = {};
    state.statusCheckFailed = false;
    state.statusError = null;
    if (!fromFolderNav) {
      state.pageSearch = '';
      state.folderSearch = '';
      state.selected.clear();
    }
    state.status = 'Fetching content…';
    state.statusType = 'info';
    render(app, state);

    try {
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
      state.contentLoading = false;

      if (state.fetchStatus) {
        if (isHardcodeIndexTest()) {
          state.status = 'hardcodeIndex test mode — index only.';
          state.statusType = 'info';
          resetFetchStatusOption(state);
        } else if (state.pageScope === 'tree') {
          state.status = `${docCount} page(s) under ${location} · checking status…`;
          state.statusType = 'success';
        } else {
          state.status = `${docCount} page(s) and ${state.folders.length} folder(s) in ${location} · checking status…`;
          state.statusType = 'success';
        }
        startStatusCheck(
          state,
          daFetch,
          state.pages.map((p) => p.helixPath),
          location,
          docCount,
          state.folders.length,
        );
      } else {
        if (state.pageFilter !== 'all') state.pageFilter = 'all';
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
      state.error = messageFromApiError(err, 'Failed to load content.');
      state.status = state.error;
      state.statusType = 'error';
      render(app, state);
    }
  };

  state.onSelectAll = (checked) => {
    selectAllVisible(state, checked);
    const root = state.root;
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
    const root = state.root;
    if (!root) return;
    syncSelectionUI(root, state);
  };

  state.onRun = async (topic) => {
    const pagePaths = new Set(state.pages.map((p) => p.helixPath));
    const paths = [...state.selected].filter((path) => pagePaths.has(path));
    if (paths.length === 0) return;

    if (topic === 'live') {
      const ok = await confirmPublishToLive(paths.length);
      if (!ok) return;
    }

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
    render(app, state);

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

      const jobUrl = getJobPollUrl(bulkResp, state.org, state.site, state.ref, topic);
      if (!jobUrl) {
        const urls = buildUrlsForPaths(paths, state.org, state.site, state.ref, env);
        state.lastOperation = {
          topic,
          paths,
          urls,
          host,
          title: topic === 'live' ? 'Published (.aem.live)' : 'Preview (.aem.page)',
          completedAt: Date.now(),
        };
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
        showJobCompleteModal({
          summary: state.status,
          topic,
          urlCount: urls.length,
          onViewUrls: () => {
            state.activeTab = 'urls';
            finishProgressModal(state, 'job');
          },
          onClose: () => finishProgressModal(state, 'job'),
        });
        return;
      }

      const finalJob = await pollJob(daFetch, jobUrl, (job) => {
        if (state.jobAbort?.signal.aborted) return;
        const progress = job.progress || job.job?.progress;
        if (progress && typeof progress === 'object') {
          const { total, processed, failed } = /** @type {{ total?: number, processed?: number, failed?: number }} */ (progress);
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
      }, state.jobAbort?.signal);

      if (state.jobAbort?.signal.aborted) return;

      const outcome = resolveJobOutcome(finalJob);
      state.status = `${action} ${outcome.message}`;
      state.statusType = outcome.statusType;

      let urlCount = 0;
      if (outcome.statusType === 'success') {
        const urls = buildUrlsForPaths(paths, state.org, state.site, state.ref, env);
        urlCount = urls.length;
        state.lastOperation = {
          topic,
          paths,
          urls,
          host,
          title: topic === 'live' ? 'Published (.aem.live)' : 'Preview (.aem.page)',
          completedAt: Date.now(),
        };
        try {
          const refreshed = await fetchPlatformStatusForPaths(
            daFetch,
            state.org,
            state.site,
            state.ref,
            paths,
          );
          state.platformStatus = { ...state.platformStatus, ...refreshed };
        } catch (refreshErr) {
          console.warn('[bulk-pp] status refresh after job failed', refreshErr);
        }
      }

      state.jobDetail = outcome.statusType === 'error'
        || new URLSearchParams(window.location.search).has('debug')
        ? JSON.stringify(finalJob, null, 2)
        : null;

      if (outcome.statusType === 'error') {
        showJobErrorModal({
          message: state.status,
          topic,
          onClose: () => finishProgressModal(state, 'job'),
        });
      } else {
        showJobCompleteModal({
          summary: state.status,
          topic,
          urlCount,
          onViewUrls: () => {
            state.activeTab = 'urls';
            finishProgressModal(state, 'job');
          },
          onClose: () => finishProgressModal(state, 'job'),
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = messageFromApiError(err);
      state.status = msg;
      state.statusType = 'error';
      if (err && typeof err === 'object' && 'data' in err && err.data) {
        state.jobDetail = JSON.stringify(err.data, null, 2);
      }
      showJobErrorModal({
        message: msg,
        topic,
        onClose: () => finishProgressModal(state, 'job'),
      });
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
    render(app, state);

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
          if (phaseErr instanceof DOMException && phaseErr.name === 'AbortError') return;
          notes.push(`Preview removal failed: ${messageFromApiError(phaseErr)}`);
          statusType = 'error';
          console.warn('[bulk-pp] unpreview phase failed', phaseErr);
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
          if (phaseErr instanceof DOMException && phaseErr.name === 'AbortError') return;
          notes.push(`Unpublish failed: ${messageFromApiError(phaseErr)}`);
          statusType = 'error';
          console.warn('[bulk-pp] unpublish phase failed', phaseErr);
        }
      }

      if (state.jobAbort?.signal.aborted) return;

      if (action === 'delete') {
        const pages = paths
          .map((path) => pageByPath.get(path))
          .filter(Boolean);
        const daResult = await deleteDaDocumentsSequential(
          daFetch,
          state.org,
          state.site,
          pages,
          ({ processed, total, failed }) => {
            if (state.jobAbort?.signal.aborted) return;
            setSequentialProgress(state, paths, 'Step 3 of 3 · Delete from DA', processed, failed, total);
          },
          state.jobAbort?.signal,
        );

        if (daResult.deleted.length > 0) {
          removePagesFromState(state, daResult.deleted);
          notes.push(`Deleted ${daResult.deleted.length} document${daResult.deleted.length === 1 ? '' : 's'} from DA`);
        }
        if (daResult.failed > 0) {
          statusType = daResult.deleted.length > 0 ? 'info' : 'error';
          const sample = daResult.errors.slice(0, 3).map((e) => `${e.helixPath}: ${e.message}`).join('; ');
          notes.push(`${daResult.failed} delete${daResult.failed === 1 ? '' : 's'} failed${sample ? ` (${sample})` : ''}`);
        }
      }

      if (state.jobAbort?.signal.aborted) return;

      try {
        const refreshed = await fetchPlatformStatusForPaths(
          daFetch,
          state.org,
          state.site,
          state.ref,
          paths,
        );
        state.platformStatus = { ...state.platformStatus, ...refreshed };
      } catch (refreshErr) {
        console.warn('[bulk-pp] status refresh after destructive job failed', refreshErr);
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
          onClose: () => finishProgressModal(state, 'job'),
        });
      } else {
        showJobCompleteModal({
          summary,
          topic,
          urlCount: 0,
          onViewUrls: () => finishProgressModal(state, 'job'),
          onClose: () => finishProgressModal(state, 'job'),
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = messageFromApiError(err);
      state.status = msg;
      state.statusType = 'error';
      showJobErrorModal({
        message: msg,
        topic,
        onClose: () => finishProgressModal(state, 'job'),
      });
    } finally {
      state.loading = false;
      state.jobAbort = null;
      state.jobStartedAt = null;
    }
  };

  if (!daFetch) {
    state.error = `Open ${APP_TITLE} from Document Authoring (https://da.live → Apps).`;
    state.statusType = 'error';
    render(app, state);
    return;
  }

  if (!ctx.org || !ctx.site) {
    state.error = 'Missing org or site from DA context. Open this tool from Document Authoring.';
    state.statusType = 'error';
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
    el('p', 'bulk-pp-boot-error-hint', 'Hard refresh (Cmd+Shift+R). If this persists, check the browser console for the failing module.'),
  );
  app.append(panel);
}

main().catch(showBootError);
