import { formatRuntimeStatusEta, formatStatusFetchEta } from './status-estimate.js';
import { el } from './dom.js';

/** @typedef {'status' | 'job'} ProgressModalKind */
/** @typedef {'preview'|'live'|'unpreview'|'unpublish'|'delete'} JobTopic */

const DEPLOYMENT_NONE_LABEL = 'neither previewed nor published';

/**
 * @param {ProgressModalKind} kind
 */
function modalIds(kind) {
  const base = kind === 'status' ? 'bulk-pp-status-modal' : 'bulk-pp-job-modal';
  return {
    title: `${base}-title`,
    cancel: `${base}-cancel`,
    body: `${base}-body`,
    fill: `${base}-progress-fill`,
    label: `${base}-progress-label`,
    eta: `${base}-progress-eta`,
  };
}

/** @type {{ kind: ProgressModalKind, backdrop: HTMLElement, panel: HTMLElement, ids: ReturnType<typeof modalIds> } | null} */
let modalRef = null;

/**
 * @param {HTMLElement | null} appRoot
 */
function setAppModalOpen(appRoot) {
  if (appRoot) appRoot.classList.add('bulk-pp-modal-open');
}

/**
 * @param {HTMLElement | null} appRoot
 */
function clearAppModalOpen(appRoot) {
  if (appRoot) appRoot.classList.remove('bulk-pp-modal-open');
}

/**
 * @returns {boolean}
 */
export function isProgressModalOpen() {
  return Boolean(modalRef);
}

/**
 * @returns {boolean}
 */
export function isStatusFetchModalOpen() {
  return modalRef?.kind === 'status';
}

/**
 * @returns {boolean}
 */
export function isJobModalOpen() {
  return modalRef?.kind === 'job';
}

/**
 * @param {HTMLElement | null} [appRoot]
 */
export function closeProgressModal(appRoot = null) {
  if (modalRef?.backdrop?.isConnected) {
    modalRef.backdrop.remove();
  }
  modalRef = null;
  clearAppModalOpen(appRoot);
}

/** @param {HTMLElement | null} [appRoot] */
export const closeStatusFetchModal = closeProgressModal;

/** @param {HTMLElement | null} [appRoot] */
export const closeJobModal = closeProgressModal;

/**
 * @param {HTMLElement | null} appRoot
 * @param {ProgressModalKind} kind
 * @param {{ title: string, intro: string, onCancel: () => void, cancelLabel?: string }} opts
 */
function openProgressModal(appRoot, kind, opts) {
  closeProgressModal(appRoot);
  const ids = modalIds(kind);

  const backdrop = el('div', 'bulk-pp-modal-backdrop bulk-pp-status-modal-backdrop');
  backdrop.setAttribute('role', 'presentation');

  const dialog = el('div', 'bulk-pp-modal bulk-pp-status-modal');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', ids.title);

  const head = el('div', 'bulk-pp-status-modal-head');
  const titleEl = el('h2', 'bulk-pp-status-modal-title', opts.title);
  titleEl.id = ids.title;
  head.append(titleEl);

  const cancelLabel = opts.cancelLabel || 'Stop';
  const cancelBtn = el('button', 'bulk-pp-modal-btn bulk-pp-modal-btn-stop bulk-pp-status-modal-cancel', cancelLabel);
  cancelBtn.type = 'button';
  cancelBtn.id = ids.cancel;
  cancelBtn.title = kind === 'job'
    ? 'Stop tracking this job (server work may continue)'
    : 'Stop the status check (requests already sent may still complete)';
  cancelBtn.addEventListener('click', opts.onCancel);
  head.append(cancelBtn);

  const body = el('div', 'bulk-pp-status-modal-body');
  body.id = ids.body;
  body.append(el('p', 'bulk-pp-status-modal-intro', opts.intro));

  const track = el('div', 'bulk-pp-progress-track');
  const fill = el('div', 'bulk-pp-progress-fill');
  fill.id = ids.fill;
  fill.style.width = '0%';
  track.append(fill);

  body.append(track);
  const labelEl = el('p', 'bulk-pp-progress-label', 'Starting…');
  labelEl.id = ids.label;
  body.append(labelEl);
  const etaEl = el('p', 'bulk-pp-progress-eta', '');
  etaEl.id = ids.eta;
  body.append(etaEl);

  dialog.append(head, body);
  backdrop.append(dialog);
  document.body.append(backdrop);
  modalRef = { kind, backdrop, panel: body, ids };
  setAppModalOpen(appRoot);
}

/**
 * @param {ReturnType<typeof modalIds>} ids
 * @param {number} done
 * @param {number} total
 */
function setProgressBar(ids, done, total) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const fill = document.getElementById(ids.fill);
  if (fill instanceof HTMLElement) fill.style.width = `${pct}%`;
  return pct;
}

function hideHeaderCancel() {
  if (!modalRef) return;
  const cancelBtn = document.getElementById(modalRef.ids.cancel);
  if (cancelBtn) cancelBtn.hidden = true;
}

/**
 * @param {string} text
 */
function setHeadTitle(text) {
  if (!modalRef) return;
  const title = modalRef.backdrop.querySelector('.bulk-pp-status-modal-title');
  if (title) title.textContent = text;
}

/**
 * @param {HTMLElement | null} appRoot
 * @param {{ statusProgressTotal: number }} state
 * @param {() => void} onCancel
 */
export function openStatusFetchModal(appRoot, state, onCancel) {
  const etaText = formatStatusFetchEta(state.statusProgressTotal);
  const base = 'Checking preview and publish status from AEM. Use Stop to end the check — requests already sent may still complete.';
  const intro = etaText
    ? `${base} Estimated time: ${etaText}.`
    : base;
  openProgressModal(appRoot, 'status', {
    title: 'Fetching deployment status',
    intro,
    cancelLabel: 'Cancel Fetching',
    onCancel,
  });
}

/**
 * @param {JobTopic} topic
 * @param {number} pageCount
 */
function jobTitle(topic, pageCount) {
  const noun = pageCount === 1 ? '1 page' : `${pageCount} pages`;
  if (topic === 'live') return `Publishing ${noun} to production`;
  if (topic === 'unpreview') return `Removing preview for ${noun}`;
  if (topic === 'unpublish') return `Unpublishing ${noun} from production`;
  if (topic === 'delete') return `Deleting ${noun} from Document Authoring`;
  return `Running bulk preview on ${noun}`;
}

/**
 * @param {JobTopic} topic
 * @param {number} pageCount
 */
function jobIntro(topic, pageCount) {
  const noun = pageCount === 1 ? 'page' : 'pages';
  if (topic === 'live') {
    return `Publishing ${pageCount} ${noun} to the live site (.aem.live). Use Stop if you need to close this dialog — work already started on the server will continue.`;
  }
  if (topic === 'unpreview') {
    return `Removing preview for ${pageCount} ${noun} from .aem.page. Use Stop to close this dialog — removals already started on the server will continue.`;
  }
  if (topic === 'unpublish') {
    return `Removing ${pageCount} ${noun} from the live site (.aem.live). Use Stop to close this dialog — unpublish work already started will continue.`;
  }
  if (topic === 'delete') {
    return `Permanently deleting ${pageCount} ${noun}: unpreview, unpublish, then remove source files from DA. Use Stop to close this dialog — steps already started will continue.`;
  }
  return `Creating preview deployments for ${pageCount} ${noun} (.aem.page). Use Stop if you need to close this dialog — work already started on the server will continue.`;
}

/**
 * @param {JobTopic} topic
 */
function jobStopLabel(topic) {
  if (topic === 'delete') return 'Cancel delete';
  if (topic === 'unpreview') return 'Cancel unpreview';
  if (topic === 'unpublish') return 'Cancel unpublish';
  return 'Cancel job';
}

/**
 * @param {HTMLElement | null} appRoot
 * @param {JobTopic} topic
 * @param {number} pageCount
 * @param {() => void} onCancel
 */
export function openJobModal(appRoot, topic, pageCount, onCancel) {
  openProgressModal(appRoot, 'job', {
    title: jobTitle(topic, pageCount),
    intro: jobIntro(topic, pageCount),
    cancelLabel: jobStopLabel(topic),
    onCancel,
  });
}

/**
 * @param {{
 *   statusFetchStartedAt: number | null,
 *   statusProgressDone: number,
 *   statusProgressTotal: number,
 * }} state
 */
export function updateStatusFetchModal(state) {
  if (!modalRef || modalRef.kind !== 'status') return;
  const { ids } = modalRef;
  const pct = setProgressBar(ids, state.statusProgressDone, state.statusProgressTotal);
  const label = document.getElementById(ids.label);
  if (label) {
    label.textContent = `${state.statusProgressDone} of ${state.statusProgressTotal} pages checked (${pct}%)`;
  }
  const etaEl = document.getElementById(ids.eta);
  if (etaEl) {
    const runtime = formatRuntimeStatusEta(
      state.statusFetchStartedAt,
      state.statusProgressDone,
      state.statusProgressTotal,
    );
    const fallback = formatStatusFetchEta(state.statusProgressTotal);
    etaEl.textContent = runtime || (fallback ? `Estimated time: ${fallback}` : '');
  }
}

/**
 * @param {{
 *   jobStartedAt: number | null,
 *   processed: number,
 *   total: number,
 *   failed: number,
 *   stateLabel?: string,
 *   phaseLabel?: string,
 * }} opts
 */
export function updateJobModal(opts) {
  if (!modalRef || modalRef.kind !== 'job') return;
  const {
    jobStartedAt,
    processed,
    total,
    failed,
    stateLabel = 'running',
    phaseLabel = '',
  } = opts;
  const { ids } = modalRef;
  const pct = setProgressBar(ids, processed, total);
  const label = document.getElementById(ids.label);
  if (label) {
    const failNote = failed > 0 ? ` · ${failed} failed` : '';
    const phasePrefix = phaseLabel ? `${phaseLabel} · ` : '';
    label.textContent = total > 0
      ? `${phasePrefix}${processed} of ${total} pages processed (${pct}%)${failNote} · ${stateLabel}`
      : `${phasePrefix}Job ${stateLabel}…`;
  }
  const etaEl = document.getElementById(ids.eta);
  if (etaEl) {
    etaEl.textContent = formatRuntimeStatusEta(jobStartedAt, processed, total) || '';
  }
}

/**
 * @param {HTMLElement} panel
 * @param {HTMLElement[]} nodes
 */
function replacePanel(panel, nodes) {
  panel.replaceChildren();
  nodes.forEach((node) => panel.append(node));
}

/**
 * @param {string} label
 * @param {() => void | Promise<void>} onClick
 * @param {boolean} [disabled]
 * @param {string} [title]
 * @param {string} [extraClass]
 */
function confirmActionBtn(label, onClick, disabled = false, title = '', extraClass = '') {
  const classes = ['bulk-pp-modal-btn', 'bulk-pp-modal-btn-confirm', extraClass].filter(Boolean).join(' ');
  const btn = el('button', classes, label);
  btn.type = 'button';
  btn.disabled = disabled;
  if (title) btn.title = title;
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    Promise.resolve(onClick()).catch(() => {});
  });
  return btn;
}

/**
 * @param {() => void} onClose
 */
function closeActionBtn(onClose) {
  const btn = el('button', 'bulk-pp-modal-btn bulk-pp-modal-btn-cancel', 'Close');
  btn.type = 'button';
  btn.addEventListener('click', onClose);
  return btn;
}

/**
 * @param {HTMLElement[]} buttons
 */
function actionRow(buttons) {
  const row = el('div', 'bulk-pp-status-modal-actions');
  buttons.forEach((btn) => row.append(btn));
  return row;
}

/**
 * @param {{ live: number, previewOnly: number, none: number, total: number }} counts
 */
function buildDeploymentBreakdownSummary(counts) {
  const { live, previewOnly, none, total } = counts;
  const wrap = el('div', 'bulk-pp-status-modal-breakdown');
  wrap.append(el(
    'p',
    'bulk-pp-status-modal-breakdown-lead',
    'Deployment status for pages in this view',
  ));

  const stats = el('div', 'bulk-pp-status-modal-stats');
  /**
   * @param {number} value
   * @param {string} label
   * @param {string} mod
   */
  const statItem = (value, label, mod) => {
    const item = el('div', `bulk-pp-status-modal-stat ${mod}`);
    item.append(
      el('span', 'bulk-pp-status-modal-stat-value', String(value)),
      el('span', 'bulk-pp-status-modal-stat-label', label),
    );
    return item;
  };

  stats.append(
    statItem(live, 'Published (live)', 'bulk-pp-status-modal-stat-live'),
    statItem(previewOnly, 'Preview only', 'bulk-pp-status-modal-stat-preview'),
    statItem(none, DEPLOYMENT_NONE_LABEL, 'bulk-pp-status-modal-stat-none'),
    statItem(total, 'Total in view', 'bulk-pp-status-modal-stat-total'),
  );
  wrap.append(stats);
  return wrap;
}

/**
 * @param {{
 *   live: number,
 *   previewOnly: number,
 *   none: number,
 *   total: number,
 *   onClose: () => void,
 * }} opts
 */
export function showStatusFetchCompleteModal(opts) {
  if (!modalRef || modalRef.kind !== 'status') return;
  const { live, previewOnly, none, total, onClose } = opts;
  const { panel } = modalRef;
  panel.classList.add('bulk-pp-status-modal-complete-body');
  replacePanel(panel, [
    el('p', 'bulk-pp-status-modal-success-icon', '✓'),
    el('h3', 'bulk-pp-status-modal-complete-title', 'Status check complete'),
    buildDeploymentBreakdownSummary({ live, previewOnly, none, total }),
    el(
      'p',
      'bulk-pp-status-modal-hint',
      'Use filters and the status key in the Pages panel to review results. Close to continue browsing.',
    ),
    actionRow([closeActionBtn(onClose)]),
  ]);
  setHeadTitle('Deployment status ready');
  hideHeaderCancel();
}

/**
 * @param {{ message: string, onClose: () => void }} opts
 */
export function showStatusFetchCancelledModal(opts) {
  if (!modalRef || modalRef.kind !== 'status') return;
  const { message, onClose } = opts;
  replacePanel(modalRef.panel, [
    el('h3', 'bulk-pp-status-modal-complete-title bulk-pp-status-modal-stopped-title', 'Status check stopped'),
    el('p', 'bulk-pp-status-modal-summary', message),
    actionRow([closeActionBtn(onClose)]),
  ]);
  setHeadTitle('Check stopped');
  hideHeaderCancel();
}

/**
 * @param {{ message: string, onClose: () => void }} opts
 */
export function showStatusFetchErrorModal(opts) {
  if (!modalRef || modalRef.kind !== 'status') return;
  const { message, onClose } = opts;
  replacePanel(modalRef.panel, [
    el('h3', 'bulk-pp-status-modal-complete-title bulk-pp-status-modal-error-title', 'Status check failed'),
    el('p', 'bulk-pp-status-modal-summary bulk-pp-status-modal-error', message),
    actionRow([closeActionBtn(onClose)]),
  ]);
  setHeadTitle('Could not load status');
  hideHeaderCancel();
}

/**
 * @param {JobTopic} topic
 */
function jobCompleteTitle(topic) {
  if (topic === 'live') return 'Publish complete';
  if (topic === 'unpreview') return 'Preview removed';
  if (topic === 'unpublish') return 'Unpublished from live';
  if (topic === 'delete') return 'Delete complete';
  return 'Preview complete';
}

/**
 * @param {JobTopic} topic
 */
function jobHeadCompleteTitle(topic) {
  if (topic === 'live') return 'Publish finished';
  if (topic === 'unpreview') return 'Unpreview finished';
  if (topic === 'unpublish') return 'Unpublish finished';
  if (topic === 'delete') return 'Delete finished';
  return 'Preview finished';
}

/**
 * @param {{
 *   summary: string,
 *   topic: JobTopic,
 *   urlCount?: number,
 *   onViewUrls: () => void,
 *   onClose: () => void,
 * }} opts
 */
export function showJobCompleteModal(opts) {
  if (!modalRef || modalRef.kind !== 'job') return;
  const { summary, topic, urlCount = 0, onViewUrls, onClose } = opts;
  const completeTitle = jobCompleteTitle(topic);
  const destructive = topic === 'unpreview' || topic === 'unpublish' || topic === 'delete';
  const actions = destructive
    ? [closeActionBtn(onClose)]
    : [
      confirmActionBtn('View URLs', onViewUrls, urlCount === 0, 'No URLs available for this operation'),
      closeActionBtn(onClose),
    ];
  replacePanel(modalRef.panel, [
    el('p', 'bulk-pp-status-modal-success-icon', destructive ? '✓' : '✓'),
    el('h3', 'bulk-pp-status-modal-complete-title', completeTitle),
    el('p', 'bulk-pp-status-modal-summary', summary),
    destructive
      ? el('p', 'bulk-pp-status-modal-hint', 'Close to continue browsing.')
      : el(
        'p',
        'bulk-pp-status-modal-hint',
        urlCount > 0
          ? 'View generated URLs on the Urls tab, or close to continue browsing.'
          : 'Close to continue browsing.',
      ),
    actionRow(actions),
  ]);
  setHeadTitle(jobHeadCompleteTitle(topic));
  hideHeaderCancel();
}

/**
 * @param {JobTopic} topic
 */
function jobErrorTitle(topic) {
  if (topic === 'live') return 'Publish failed';
  if (topic === 'unpreview') return 'Unpreview failed';
  if (topic === 'unpublish') return 'Unpublish failed';
  if (topic === 'delete') return 'Delete failed';
  return 'Preview failed';
}

/**
 * @param {JobTopic} topic
 */
function jobHeadErrorTitle(topic) {
  if (topic === 'live') return 'Could not publish';
  if (topic === 'unpreview') return 'Could not remove preview';
  if (topic === 'unpublish') return 'Could not unpublish';
  if (topic === 'delete') return 'Could not delete';
  return 'Could not preview';
}

/**
 * @param {{ message: string, topic: JobTopic, onClose: () => void }} opts
 */
export function showJobErrorModal(opts) {
  if (!modalRef || modalRef.kind !== 'job') return;
  const { message, topic, onClose } = opts;
  replacePanel(modalRef.panel, [
    el('h3', 'bulk-pp-status-modal-complete-title bulk-pp-status-modal-error-title', jobErrorTitle(topic)),
    el('p', 'bulk-pp-status-modal-summary bulk-pp-status-modal-error', message),
    actionRow([closeActionBtn(onClose)]),
  ]);
  setHeadTitle(jobHeadErrorTitle(topic));
  hideHeaderCancel();
}

/**
 * @param {{ message: string, topic: JobTopic, onClose: () => void }} opts
 */
export function showJobCancelledModal(opts) {
  if (!modalRef || modalRef.kind !== 'job') return;
  const { message, topic, onClose } = opts;
  replacePanel(modalRef.panel, [
    el('h3', 'bulk-pp-status-modal-complete-title bulk-pp-status-modal-stopped-title', 'Job stopped on screen'),
    el('p', 'bulk-pp-status-modal-summary', message),
    actionRow([closeActionBtn(onClose)]),
  ]);
  const headTitle = topic === 'delete'
    ? 'Delete tracking stopped'
    : topic === 'unpublish'
      ? 'Unpublish tracking stopped'
      : topic === 'unpreview'
        ? 'Unpreview tracking stopped'
        : topic === 'live'
          ? 'Publish tracking stopped'
          : 'Preview tracking stopped';
  setHeadTitle(headTitle);
  hideHeaderCancel();
}
