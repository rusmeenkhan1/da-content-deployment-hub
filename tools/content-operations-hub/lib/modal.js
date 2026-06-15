import { el } from './dom.js';

/**
 * @param {{
 *   title: string,
 *   body: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   variant?: 'warning' | 'default',
 *   confirmDanger?: boolean,
 * }} opts
 * @returns {Promise<boolean>}
 */
export function showConfirmModal(opts) {
  const {
    title,
    body,
    confirmLabel = 'Continue',
    cancelLabel = 'Cancel',
    variant = 'default',
    confirmDanger = false,
  } = opts;

  return new Promise((resolve) => {
    const backdrop = el('div', 'bulk-pp-modal-backdrop');
    backdrop.setAttribute('role', 'presentation');

    const dialog = el('div', `bulk-pp-modal bulk-pp-modal-${variant}`);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'bulk-pp-modal-title');

    const head = el('div', 'bulk-pp-modal-head');
    if (variant === 'warning') {
      head.append(el('span', 'bulk-pp-modal-icon', '!'));
    }
    const titleWrap = el('div', 'bulk-pp-modal-title-wrap');
    titleWrap.append(el('h2', 'bulk-pp-modal-title', title));
    head.append(titleWrap);
    head.id = 'bulk-pp-modal-title';

    const content = el('p', 'bulk-pp-modal-body', body);

    const actions = el('div', 'bulk-pp-modal-actions');
    const cancelBtn = el('button', 'bulk-pp-modal-btn bulk-pp-modal-btn-cancel', cancelLabel);
    const confirmBtn = el(
      'button',
      confirmDanger
        ? 'bulk-pp-modal-btn bulk-pp-modal-btn-danger'
        : 'bulk-pp-modal-btn bulk-pp-modal-btn-confirm',
      confirmLabel,
    );
    cancelBtn.type = 'button';
    confirmBtn.type = 'button';
    actions.append(cancelBtn, confirmBtn);

    dialog.append(head, content, actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const close = (result) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
    document.addEventListener('keydown', onKey);
    confirmBtn.focus();
  });
}

/**
 * @typedef {{ scope: 'folder'|'tree', withStatus: boolean }} FolderLoadChoice
 */

/**
 * Ask how to open a folder before loading its pages.
 * @param {string} folderLabel
 * @returns {Promise<FolderLoadChoice | null>}
 */
export function promptFolderLoadMode(folderLabel) {
  const location = folderLabel || 'Site root';
  return new Promise((resolve) => {
    /** @type {'folder'|'tree'} */
    let selectedScope = 'folder';

    const backdrop = el('div', 'bulk-pp-modal-backdrop');
    backdrop.setAttribute('role', 'presentation');

    const dialog = el('div', 'bulk-pp-modal bulk-pp-modal-choice');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'bulk-pp-modal-title');

    const head = el('div', 'bulk-pp-modal-choice-head');
    const titleBlock = el('div', 'bulk-pp-modal-choice-title-block');
    titleBlock.append(
      el('h2', 'bulk-pp-modal-title', 'Open folder'),
      el('p', 'bulk-pp-modal-choice-path', location),
    );
    const closeBtn = el('button', 'bulk-pp-modal-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '<span aria-hidden="true">&times;</span>';
    head.append(titleBlock, closeBtn);
    head.id = 'bulk-pp-modal-title';

    const content = el('div', 'bulk-pp-modal-body-wrap');

    const scopeSegment = el('div', 'bulk-pp-modal-scope-segment');
    scopeSegment.setAttribute('role', 'radiogroup');
    scopeSegment.setAttribute('aria-label', 'Page scope');

    /** @type {HTMLButtonElement[]} */
    const segmentButtons = [];

    /**
     * @param {'folder'|'tree'} value
     * @param {string} label
     */
    const makeSegmentButton = (value, label) => {
      const btn = el('button', 'bulk-pp-modal-scope-segment-btn', label);
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', value === 'folder' ? 'true' : 'false');
      if (value === 'folder') btn.classList.add('bulk-pp-modal-scope-segment-btn-active');
      btn.addEventListener('click', () => {
        selectedScope = value;
        updateScopeUi();
      });
      segmentButtons.push(btn);
      return btn;
    };

    scopeSegment.append(
      makeSegmentButton('folder', 'This folder'),
      makeSegmentButton('tree', 'All subdirectories'),
    );

    const scopeHint = el(
      'p',
      'bulk-pp-modal-scope-hint-line',
      'Includes nested folders — may take longer.',
    );
    scopeHint.hidden = true;

    content.append(scopeSegment, scopeHint);

    const actions = el('div', 'bulk-pp-modal-choice-actions');

    /**
     * @param {string} title
     * @param {boolean} withStatus
     */
    const makeActionButton = (title, withStatus) => {
      const btn = el(
        'button',
        `bulk-pp-modal-choice-btn ${withStatus
          ? 'bulk-pp-modal-choice-btn-primary'
          : 'bulk-pp-modal-choice-btn-secondary'}`,
      );
      btn.type = 'button';
      btn.append(
        el('span', 'bulk-pp-modal-choice-btn-title', title),
        el('span', 'bulk-pp-modal-choice-btn-scope', 'This folder only'),
      );
      return btn;
    };

    const listBtn = makeActionButton('List pages', false);
    const listWithStatusBtn = makeActionButton('List pages with deployment status', true);
    actions.append(listBtn, listWithStatusBtn);

    dialog.append(head, content, actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const syncScopeSegment = () => {
      segmentButtons.forEach((btn, index) => {
        const value = index === 0 ? 'folder' : 'tree';
        const active = selectedScope === value;
        btn.classList.toggle('bulk-pp-modal-scope-segment-btn-active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    };

    const updateScopeUi = () => {
      const scopeText = selectedScope === 'tree'
        ? 'Including all subfolders'
        : 'This folder only';
      scopeHint.hidden = selectedScope !== 'tree';
      actions.querySelectorAll('.bulk-pp-modal-choice-btn-scope').forEach((node) => {
        node.textContent = scopeText;
      });
      syncScopeSegment();
    };

    const close = (result) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };

    closeBtn.addEventListener('click', () => close(null));
    listBtn.addEventListener('click', () => close({ scope: selectedScope, withStatus: false }));
    listWithStatusBtn.addEventListener('click', () => close({ scope: selectedScope, withStatus: true }));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
    document.addEventListener('keydown', onKey);
    updateScopeUi();
    listBtn.focus();
  });
}

/**
 * @param {number} pageCount
 * @param {'folder'|'tree'} scope
 * @param {string} [etaHint]
 * @returns {Promise<boolean>}
 */
export function confirmCheckDeploymentStatus(pageCount, scope, etaHint = '') {
  const scopeLabel = scope === 'tree' ? 'all subdirectories' : 'this directory';
  let body = `This will check preview and publish status for ${pageCount} page${pageCount === 1 ? '' : 's'} in ${scopeLabel}. Each page requires a request to AEM.`;
  if (etaHint) body += ` Estimated time: ${etaHint}.`;
  body += ' You can cancel the check at any time.';
  return showConfirmModal({
    title: 'Load deployment status?',
    body,
    confirmLabel: 'Load status',
    cancelLabel: 'Cancel',
    variant: 'warning',
  });
}

/**
 * @returns {Promise<boolean>}
 */
export function confirmTreeScopeFetch() {
  return showConfirmModal({
    title: 'Load status for all subfolders?',
    body: 'You chose to load preview/publish status for every page under this folder. On large sites that can take several minutes. You can cancel the status check at any time.',
    confirmLabel: 'Continue',
    cancelLabel: 'Cancel',
    variant: 'warning',
  });
}

/**
 * @param {number} count
 * @returns {Promise<boolean>}
 */
export function confirmOpenUrlsInNewTabs(count) {
  const tabLabel = count === 1 ? '1 tab' : `${count} tabs`;
  let scaleNote = '';
  if (count >= 20) scaleNote = ' Large lists often trigger popup blockers or slow the browser.';
  else if (count >= 5) scaleNote = ' Some browsers may block or limit how many tabs open at once.';
  return showConfirmModal({
    title: 'Open URLs in new tabs?',
    body: `This will try to open ${count} URL${count === 1 ? '' : 's'} (${tabLabel}).${scaleNote} Continue only if you intend to review that many pages.`,
    confirmLabel: `Open ${tabLabel}`,
    cancelLabel: 'Cancel',
    variant: 'warning',
  });
}

/**
 * @param {number} count
 * @returns {Promise<boolean>}
 */
export function confirmPreviewSelected(count) {
  return showConfirmModal({
    title: 'Preview selected pages?',
    body: `You are about to preview ${count} selected page${count === 1 ? '' : 's'}.`,
    confirmLabel: 'Preview selected',
    cancelLabel: 'Cancel',
    variant: 'warning',
  });
}

/**
 * @param {number} count
 * @returns {Promise<boolean>}
 */
export function confirmPublishToLive(count) {
  return showConfirmModal({
    title: 'Publish to production?',
    body: `You are about to publish ${count} selected page${count === 1 ? '' : 's'}.`,
    confirmLabel: 'Publish to production',
    cancelLabel: 'Cancel',
    variant: 'warning',
  });
}

/**
 * Confirm before starting a bulk preview or publish job.
 * @param {'preview'|'live'} topic
 * @param {number} count
 * @returns {Promise<boolean>}
 */
export function confirmBulkRun(topic, count) {
  if (topic === 'live') return confirmPublishToLive(count);
  return confirmPreviewSelected(count);
}

/** @typedef {'unpreview' | 'unpublish' | 'delete'} DestructiveAction */

const DESTRUCTIVE_COPY = {
  unpreview: {
    keyword: 'unpreview',
    title: 'Remove preview for selected pages?',
    body: (count) => `You are about to remove preview for ${count} page${count === 1 ? '' : 's'}. Preview URLs on .aem.page will stop working until you preview again.`,
    proceedLabel: 'Continue to confirmation',
    finalTitle: 'Remove preview permanently?',
    finalBody: 'This cannot be undone. Preview copies will be deleted from AEM.',
    confirmLabel: 'Yes, remove preview',
  },
  unpublish: {
    keyword: 'unpublish',
    title: 'Unpublish selected pages from production?',
    body: (count) => `You are about to unpublish ${count} page${count === 1 ? '' : 's'} from the live site (.aem.live). Live URLs will stop working until you publish again.`,
    proceedLabel: 'Continue to confirmation',
    finalTitle: 'Unpublish from production permanently?',
    finalBody: 'This cannot be undone. Live copies will be removed from AEM.',
    confirmLabel: 'Yes, unpublish',
  },
  delete: {
    keyword: 'delete',
    title: 'Delete selected pages from Document Authoring?',
    body: (count) => `You are about to permanently delete ${count} page${count === 1 ? '' : 's'} from DA. This runs unpreview, unpublish, then deletes the source document${count === 1 ? '' : 's'}.`,
    proceedLabel: 'Continue to confirmation',
    finalTitle: 'Delete from DA permanently?',
    finalBody: 'This cannot be undone. Source files will be removed from Document Authoring and preview/live deployments will be cleared.',
    confirmLabel: 'Yes, delete permanently',
  },
};

/**
 * @param {{
 *   title: string,
 *   body: string,
 *   keyword: string,
 *   proceedLabel?: string,
 * }} opts
 * @returns {Promise<boolean>}
 */
function showKeywordConfirmModal(opts) {
  const {
    title,
    body,
    keyword,
    proceedLabel = 'Continue',
  } = opts;

  return new Promise((resolve) => {
    const backdrop = el('div', 'bulk-pp-modal-backdrop');
    backdrop.setAttribute('role', 'presentation');

    const dialog = el('div', 'bulk-pp-modal bulk-pp-modal-warning bulk-pp-modal-destructive');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'bulk-pp-modal-title');

    const head = el('div', 'bulk-pp-modal-head');
    head.append(el('span', 'bulk-pp-modal-icon bulk-pp-modal-icon-danger', '!'));
    const titleWrap = el('div', 'bulk-pp-modal-title-wrap');
    titleWrap.append(el('h2', 'bulk-pp-modal-title', title));
    head.append(titleWrap);
    head.id = 'bulk-pp-modal-title';

    const content = el('div', 'bulk-pp-modal-body-wrap');
    content.append(el('p', 'bulk-pp-modal-body', body));

    const field = el('div', 'bulk-pp-modal-keyword-field');
    const label = el('label', 'bulk-pp-modal-keyword-label', `Type ${keyword} to continue`);
    label.htmlFor = 'bulk-pp-modal-keyword-input';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'bulk-pp-modal-keyword-input';
    input.className = 'bulk-pp-modal-keyword-input';
    input.placeholder = keyword;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-required', 'true');
    field.append(label, input);
    content.append(field);

    const hint = el(
      'p',
      'bulk-pp-modal-keyword-hint',
      'This is a destructive action. You will be asked to confirm once more before anything runs.',
    );
    content.append(hint);

    const actions = el('div', 'bulk-pp-modal-actions');
    const cancelBtn = el('button', 'bulk-pp-modal-btn bulk-pp-modal-btn-cancel', 'Cancel');
    const proceedBtn = el('button', 'bulk-pp-modal-btn bulk-pp-modal-btn-danger', proceedLabel);
    cancelBtn.type = 'button';
    proceedBtn.type = 'button';
    proceedBtn.disabled = true;
    actions.append(cancelBtn, proceedBtn);

    dialog.append(head, content, actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const close = (result) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && !proceedBtn.disabled) close(true);
    };

    const syncProceed = () => {
      proceedBtn.disabled = input.value.trim().toLowerCase() !== keyword.toLowerCase();
    };

    input.addEventListener('input', syncProceed);
    cancelBtn.addEventListener('click', () => close(false));
    proceedBtn.addEventListener('click', () => {
      if (!proceedBtn.disabled) close(true);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
    document.addEventListener('keydown', onKey);
    input.focus();
  });
}

/**
 * Two-step confirmation: type keyword, then final irreversible warning.
 * @param {DestructiveAction} action
 * @param {number} count
 * @returns {Promise<boolean>}
 */
export async function confirmDestructiveAction(action, count) {
  const copy = DESTRUCTIVE_COPY[action];
  const typed = await showKeywordConfirmModal({
    title: copy.title,
    body: copy.body(count),
    keyword: copy.keyword,
    proceedLabel: copy.proceedLabel,
  });
  if (!typed) return false;

  return showConfirmModal({
    title: copy.finalTitle,
    body: `${copy.finalBody} This action cannot be undone.`,
    confirmLabel: copy.confirmLabel,
    cancelLabel: 'Go back',
    variant: 'warning',
    confirmDanger: true,
  });
}
