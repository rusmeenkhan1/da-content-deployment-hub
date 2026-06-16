import {
  getActiveSelectionCount,
  getVisiblePages,
  isStatusFetchBlocking,
  shouldShowPageStatus,
  SEARCH_MIN_LEN,
} from './state.js';
import { isJobModalOpen } from './progress-modal.js';
import { el } from './dom.js';
import { patchFolderTree } from './folder-tree.js';

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
function syncPageRowDaLinks(root, state) {
  const multi = getActiveSelectionCount(state) > 1;
  const locked = isStatusFetchBlocking(state);
  root.querySelectorAll('.bulk-pp-btn-open-da').forEach((linkEl) => {
    if (!(linkEl instanceof HTMLAnchorElement)) return;
    const href = linkEl.dataset.href || '';
    if (locked || multi) {
      linkEl.classList.add('bulk-pp-btn-open-da-disabled');
      linkEl.setAttribute('aria-disabled', 'true');
      linkEl.removeAttribute('href');
      linkEl.title = multi
        ? 'Use More → Open in DA when multiple pages are selected'
        : 'Unavailable while status is loading';
    } else {
      linkEl.classList.remove('bulk-pp-btn-open-da-disabled');
      linkEl.removeAttribute('aria-disabled');
      if (href) linkEl.href = href;
      linkEl.title = 'Open this page in DA';
    }
  });
}

function syncSelectionActionBar(root, state) {
  const count = getActiveSelectionCount(state);
  const blocked = count === 0
    || isStatusFetchBlocking(state)
    || state.loading
    || state.contentLoading
    || isJobModalOpen();

  const bar = root.querySelector('#bulk-pp-selection-bar');
  if (bar instanceof HTMLElement) {
    bar.hidden = count === 0;
  }
  const countEl = root.querySelector('#bulk-pp-selection-count');
  if (countEl) countEl.textContent = count === 1 ? '1 page selected' : `${count} pages selected`;

  const clearBtn = root.querySelector('#bulk-pp-selection-clear');
  if (clearBtn instanceof HTMLButtonElement) {
    clearBtn.disabled = count === 0;
  }

  const shareTip = root.querySelector('#bulk-pp-selection-share-tooltip');
  const shareBtn = root.querySelector('#bulk-pp-selection-share');
  const shareLabel = count === 1
    ? 'Copy preview URL to clipboard'
    : `Copy ${count} preview URLs to clipboard`;
  if (shareTip) shareTip.textContent = shareLabel;
  if (shareBtn instanceof HTMLButtonElement) {
    shareBtn.setAttribute('aria-label', shareLabel);
  }

  root.querySelectorAll('.bulk-pp-selection-strip-btn, .bulk-pp-selection-more-item').forEach((btnEl) => {
    if (btnEl instanceof HTMLButtonElement) btnEl.disabled = blocked;
  });

  syncPageRowDaLinks(root, state);
}

/**
 * @param {string} id
 * @param {string} label
 * @param {string} value
 * @param {boolean} disabled
 * @param {string | null} hintText
 */
export function buildSearchField(id, placeholder, value, disabled, hintText) {
  const wrap = el('div', 'bulk-pp-search-field');
  const inputWrap = el('div', 'bulk-pp-search-input-wrap');
  const input = document.createElement('input');
  input.type = 'search';
  input.id = id;
  input.className = 'bulk-pp-search-input';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.enterKeyHint = 'search';
  input.value = value;
  input.disabled = disabled;
  inputWrap.append(input);
  const hint = el('span', 'bulk-pp-search-hint');
  hint.id = `${id}-hint`;
  if (!hintText) hint.hidden = true;
  else hint.textContent = hintText;
  wrap.append(inputWrap, hint);
  return { wrap, input, hint };
}

/**
 * @param {string} draft
 */
export function searchHintText(draft) {
  const q = String(draft || '').trim();
  if (q.length >= SEARCH_MIN_LEN) {
    return `Filtering by “${q}”`;
  }
  if (q.length > 0) {
    return `Type at least ${SEARCH_MIN_LEN} characters to search`;
  }
  return null;
}

/**
 * @param {HTMLElement | null} hint
 * @param {string | null} message
 */
function syncSearchHint(hint, message) {
  if (!hint) return;
  if (message) {
    hint.textContent = message;
    hint.hidden = false;
  } else {
    hint.textContent = '';
    hint.hidden = true;
  }
}

/**
 * Keeps checkboxes, selection pill, toolbar, and action buttons in sync with state.
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
export function syncSelectionUI(root, state) {
  const { visible: visiblePages } = getVisiblePages(state);
  const activeCount = getActiveSelectionCount(state);

  root.querySelectorAll('.bulk-pp-page-cb').forEach((cb) => {
    if (!(cb instanceof HTMLInputElement)) return;
    const path = cb.dataset.path || cb.value;
    cb.checked = state.selected.has(path);
  });

  const colheadCb = root.querySelector('#bulk-pp-select-all-colhead');
  if (colheadCb instanceof HTMLInputElement) {
    colheadCb.checked = visiblePages.length > 0 && activeCount === visiblePages.length;
    colheadCb.indeterminate = activeCount > 0 && activeCount < visiblePages.length;
  }

  syncSelectionActionBar(root, state);
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
export function patchFolderSearchResults(root, state) {
  patchFolderTree(
    root,
    state,
    (path) => state.onNavigate(path),
    isStatusFetchBlocking(state),
  );

  syncSearchHint(
    root.querySelector('#bulk-pp-folder-search-hint'),
    searchHintText(state.folderSearch),
  );
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {number} [visibleCount]
 */
export function pagesLocationMetaText(state, visibleCount) {
  const total = state.pages.length;
  if (total === 0) {
    return state.pageScope === 'tree'
      ? 'No pages in this folder or subfolders.'
      : 'No pages in this folder.';
  }
  const scopeSuffix = state.pageScope === 'tree'
    ? ' in this folder and subfolders'
    : ' in this folder';
  const draft = String(state.pageSearch || '').trim();
  const filtered = visibleCount != null && visibleCount !== total;
  const filterActive = state.pageFilter && state.pageFilter !== 'all';
  if (filtered || filterActive) {
    const noun = visibleCount === 1 ? 'page' : 'pages';
    if (draft.length >= SEARCH_MIN_LEN) {
      return `Showing ${visibleCount} of ${total} ${noun} matching search${scopeSuffix}`;
    }
    return `Showing ${visibleCount} of ${total} ${noun}${scopeSuffix}`;
  }
  const noun = total === 1 ? 'page' : 'pages';
  return `${total} ${noun}${scopeSuffix}`;
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {{ org: string, site: string, ref: string }} siteCtx
 * @param {Function} buildPageRow
 */
export function patchPageSearchResults(root, state, siteCtx, buildPageRow) {
  const { visible: visiblePages, statusMap, browseFolder } = getVisiblePages(state);
  const draft = String(state.pageSearch || '').trim();

  const count = root.querySelector('#bulk-pp-page-count');
  if (count) {
    count.textContent = pagesLocationMetaText(state, visiblePages.length);
  }

  syncSearchHint(
    root.querySelector('#bulk-pp-page-search-hint'),
    searchHintText(state.pageSearch),
  );

  const list = root.querySelector('#bulk-pp-page-list');
  if (!list) return;
  list.replaceChildren();
  if (state.pages.length === 0) {
    list.append(el('li', 'bulk-pp-list-empty', 'No pages in this location.'));
  } else if (visiblePages.length === 0) {
    const emptyMsg = draft
      ? 'No pages match this search.'
      : 'No pages match this filter.';
    list.append(el('li', 'bulk-pp-list-empty', emptyMsg));
  } else {
    visiblePages.forEach((page) => {
      list.append(buildPageRow(
        page,
        statusMap[page.helixPath],
        browseFolder,
        state,
        shouldShowPageStatus(state),
        siteCtx,
        isStatusFetchBlocking(state),
      ));
    });
  }

  syncSelectionUI(root, state);
}

/**
 * @param {HTMLInputElement} input
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {'folder'|'page'} kind
 * @param {() => void} patchFn
 */
export function bindSearchInput(input, state, kind, patchFn) {
  const syncFromInput = () => {
    const { value } = input;
    if (kind === 'folder') state.folderSearch = value;
    else state.pageSearch = value;
    patchFn();
  };

  input.addEventListener('input', syncFromInput);
  // Native clear (×) on type=search often fires `search`, not `input`.
  input.addEventListener('search', syncFromInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      if (kind === 'folder') state.folderSearch = '';
      else state.pageSearch = '';
      patchFn();
    }
  });
}
