import { formatRuntimeStatusEta } from './status-estimate.js';
import { confirmOpenUrlsInNewTabs } from './modal.js';
import { copyTextToClipboard, openUrlsInNewTabsQuiet, runButtonAction } from './ui-utils.js';
import { el } from './dom.js';

/** @typedef {'job'} ProgressModalKind */
/** @typedef {'preview'|'live'|'unpreview'|'unpublish'|'delete'} JobTopic */

/**
 * @param {ProgressModalKind} kind
 */
function modalIds(kind) {
  const base = kind === 'job' ? 'bulk-pp-job-modal' : 'bulk-pp-status-modal';
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

  const dialog = el('div', 'bulk-pp-modal bulk-pp-status-modal bulk-pp-status-modal-progress');
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
  cancelBtn.title = 'Stop tracking this job (server work may continue)';
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
  modalRef = {
    kind, backdrop, panel: body, ids,
  };
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
  if (cancelBtn instanceof HTMLElement) {
    cancelBtn.hidden = true;
    cancelBtn.style.display = 'none';
  }
}

/**
 * @param {string} text
 */
function setHeadTitle(text) {
  if (!modalRef) return;
  const title = modalRef.backdrop.querySelector('.bulk-pp-modal-title')
    || modalRef.backdrop.querySelector('.bulk-pp-status-modal-title');
  if (title) title.textContent = text;
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
 * @param {string[]} urls
 * @param {string} host
 */
function buildJobUrlResults(urls, host) {
  const section = el('div', 'bulk-pp-modal-url-results');
  if (host) section.append(el('p', 'bulk-pp-modal-url-host', host));

  const count = urls.length;
  const actions = el('div', 'bulk-pp-modal-url-actions');
  const copyBtn = el('button', 'bulk-pp-modal-btn bulk-pp-modal-btn-ghost', 'Copy URLs');
  copyBtn.type = 'button';
  copyBtn.title = `Copy ${count} URL${count === 1 ? '' : 's'} to clipboard`;
  copyBtn.addEventListener('click', () => {
    runButtonAction(copyBtn, 'Copied', 'Copy failed', 'Copy URLs', async () => {
      await copyTextToClipboard(urls.join('\n'));
    });
  });
  const openBtn = el(
    'button',
    'bulk-pp-modal-btn bulk-pp-modal-btn-confirm',
    `Open all (${count})`,
  );
  openBtn.type = 'button';
  openBtn.title = `Open ${count} URL${count === 1 ? '' : 's'} in separate browser tabs`;
  openBtn.addEventListener('click', () => {
    Promise.resolve(confirmOpenUrlsInNewTabs(count)).then((ok) => {
      if (!ok) return;
      openUrlsInNewTabsQuiet(urls);
    }).catch(() => {});
  });
  const lhsBtn = el(
    'button',
    'bulk-pp-modal-btn bulk-pp-modal-btn-insight',
    `Check LHS for all (${count})`,
  );
  lhsBtn.type = 'button';
  lhsBtn.title = `Run Lighthouse checks for ${count} URL${count === 1 ? '' : 's'}`;
  lhsBtn.addEventListener('click', () => {
    const handleCheckLhs = async () => {
      const psUrls = urls.map((url) => {
        const encoded = encodeURIComponent(url);
        return `https://pagespeed.web.dev/analysis?url=${encoded}`;
      });
      openUrlsInNewTabsQuiet(psUrls);
    };
    Promise.resolve(confirmOpenUrlsInNewTabs(count)).then((ok) => {
      if (ok) {
        handleCheckLhs();
      }
    }).catch(() => {});
  });
  actions.append(copyBtn, openBtn, lhsBtn);
  section.append(actions);

  const listWrap = el('div', 'bulk-pp-modal-url-list-wrap');
  const list = el('ul', 'bulk-pp-modal-url-list');
  urls.forEach((url) => {
    const li = el('li');
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = url;
    li.append(link);
    list.append(li);
  });
  listWrap.append(list);
  section.append(listWrap);
  return section;
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
 *   urls?: string[],
 *   host?: string,
 *   onClose: () => void,
 * }} opts
 */
export function showJobCompleteModal(opts) {
  if (!modalRef || modalRef.kind !== 'job') return;
  const {
    summary, topic, urls = [], host = '', onClose,
  } = opts;
  const completeTitle = jobCompleteTitle(topic);
  const destructive = topic === 'unpreview' || topic === 'unpublish' || topic === 'delete';
  const hasUrls = !destructive && urls.length > 0;
  const dialog = modalRef.backdrop.querySelector('.bulk-pp-status-modal');
  if (dialog instanceof HTMLElement) {
    dialog.classList.toggle('bulk-pp-status-modal-with-urls', hasUrls);
  }
  const body = [
    el('p', 'bulk-pp-status-modal-success-icon', '✓'),
    el('h3', 'bulk-pp-status-modal-complete-title', completeTitle),
    el('p', 'bulk-pp-status-modal-summary', summary),
  ];
  if (hasUrls) {
    body.push(buildJobUrlResults(urls, host));
    body.push(el(
      'p',
      'bulk-pp-status-modal-hint',
      'Copy URLs or open them in new tabs, then close to continue browsing.',
    ));
  } else {
    body.push(el('p', 'bulk-pp-status-modal-hint', 'Close to continue browsing.'));
  }
  body.push(actionRow([closeActionBtn(onClose)]));
  replacePanel(modalRef.panel, body);
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
 * @param {{ message: string, topic: JobTopic, onClose: () => void, hint?: string }} opts
 */
export function showJobErrorModal(opts) {
  if (!modalRef || modalRef.kind !== 'job') return;
  const {
    message, topic, onClose, hint = '',
  } = opts;
  const body = [
    el('h3', 'bulk-pp-status-modal-complete-title bulk-pp-status-modal-error-title', jobErrorTitle(topic)),
    el('p', 'bulk-pp-status-modal-summary bulk-pp-status-modal-error', message),
  ];
  if (hint) {
    body.push(el('p', 'bulk-pp-status-modal-hint bulk-pp-status-modal-error-hint', hint));
  }
  body.push(actionRow([closeActionBtn(onClose)]));
  replacePanel(modalRef.panel, body);
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
