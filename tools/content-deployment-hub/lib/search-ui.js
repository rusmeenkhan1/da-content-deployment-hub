import {
  formatSelectionPillText,
  getActiveSelectionCount,
  getVisibleFolders,
  getVisiblePages,
  isStatusLoaded,
  SEARCH_MIN_LEN,
} from './state.js';
import { el } from './dom.js';

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
function syncPageRowDaLinks(root, state) {
  const multi = getActiveSelectionCount(state) > 1;
  const locked = state.statusChecking;
  root.querySelectorAll('.bulk-pp-btn-open-da').forEach((el) => {
    if (!(el instanceof HTMLAnchorElement)) return;
    const href = el.dataset.href || '';
    if (locked || multi) {
      el.classList.add('bulk-pp-btn-open-da-disabled');
      el.setAttribute('aria-disabled', 'true');
      el.removeAttribute('href');
      el.title = multi
        ? 'Use “Open DA URL for selected” in the toolbar when multiple pages are selected'
        : 'Unavailable while status is loading';
    } else {
      el.classList.remove('bulk-pp-btn-open-da-disabled');
      el.removeAttribute('aria-disabled');
      if (href) el.href = href;
      el.title = 'Open this page in Document Authoring';
    }
  });
}

function syncOpenSelectedActionButtons(root, state) {
  const count = getActiveSelectionCount(state);
  const disabled = count === 0
    || state.statusChecking
    || state.loading
    || state.contentLoading;
  const group = root.querySelector('#bulk-pp-open-selected-group');
  if (group instanceof HTMLElement) group.hidden = count === 0;

  const countHint = count === 1 ? '1 page' : `${count} pages`;
  const daBtn = root.querySelector('#bulk-pp-open-selected-da');
  const previewBtn = root.querySelector('#bulk-pp-open-selected-preview');
  const liveBtn = root.querySelector('#bulk-pp-open-selected-live');
  if (daBtn instanceof HTMLButtonElement) {
    daBtn.disabled = disabled;
    daBtn.title = `Open Document Authoring for ${countHint}`;
  }
  if (previewBtn instanceof HTMLButtonElement) {
    previewBtn.disabled = disabled;
    previewBtn.title = `Open .aem.page preview URL for ${countHint}`;
  }
  if (liveBtn instanceof HTMLButtonElement) {
    liveBtn.disabled = disabled;
    liveBtn.title = `Open .aem.live publish URL for ${countHint}`;
  }

  const runDisabled = state.loading
    || state.contentLoading
    || state.statusChecking
    || count === 0;
  const bulkPreviewBtn = root.querySelector('#bulk-pp-preview-btn');
  const bulkPublishBtn = root.querySelector('#bulk-pp-publish-btn');
  if (bulkPreviewBtn instanceof HTMLButtonElement) {
    bulkPreviewBtn.disabled = runDisabled;
    bulkPreviewBtn.title = count === 0
      ? 'Select pages to preview'
      : `Bulk preview ${count} selected page${count === 1 ? '' : 's'}`;
  }
  if (bulkPublishBtn instanceof HTMLButtonElement) {
    bulkPublishBtn.disabled = runDisabled;
    bulkPublishBtn.title = count === 0
      ? 'Select pages to publish'
      : `Publish ${count} selected page${count === 1 ? '' : 's'} to production`;
  }

  const destructiveDisabled = runDisabled;
  const unpreviewBtn = root.querySelector('#bulk-pp-unpreview-btn');
  const unpublishBtn = root.querySelector('#bulk-pp-unpublish-btn');
  const deleteBtn = root.querySelector('#bulk-pp-delete-btn');
  if (unpreviewBtn instanceof HTMLButtonElement) {
    unpreviewBtn.disabled = destructiveDisabled;
    unpreviewBtn.title = count === 0
      ? 'Select pages to remove from preview'
      : `Remove preview for ${count} selected page${count === 1 ? '' : 's'}`;
  }
  if (unpublishBtn instanceof HTMLButtonElement) {
    unpublishBtn.disabled = destructiveDisabled;
    unpublishBtn.title = count === 0
      ? 'Select pages to unpublish from live'
      : `Unpublish ${count} selected page${count === 1 ? '' : 's'} from production`;
  }
  if (deleteBtn instanceof HTMLButtonElement) {
    deleteBtn.disabled = destructiveDisabled;
    deleteBtn.title = count === 0
      ? 'Select pages to delete from Document Authoring'
      : `Unpreview, unpublish, and delete ${count} selected page${count === 1 ? '' : 's'} from DA`;
  }

  syncPageRowDaLinks(root, state);
}

/**
 * @param {string} id
 * @param {string} label
 * @param {string} value
 * @param {boolean} disabled
 * @param {string | null} hintText
 */
export function buildSearchField(id, label, value, disabled, hintText) {
  const wrap = el('div', 'bulk-pp-search-field');
  const labelEl = el('label', 'bulk-pp-search-label', label);
  labelEl.htmlFor = id;
  const inputWrap = el('div', 'bulk-pp-search-input-wrap');
  const input = document.createElement('input');
  input.type = 'search';
  input.id = id;
  input.className = 'bulk-pp-search-input';
  input.placeholder = `Search by name (${SEARCH_MIN_LEN}+ characters)`;
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
  wrap.append(labelEl, inputWrap, hint);
  return { wrap, input, hint };
}

/**
 * @param {string} draft
 */
export function searchHintText(draft) {
  const q = String(draft || '').trim();
  if (q.length > 0 && q.length < SEARCH_MIN_LEN) {
    return `Type ${SEARCH_MIN_LEN - q.length} more character${q.length === SEARCH_MIN_LEN - 1 ? '' : 's'} to filter`;
  }
  if (q.length >= SEARCH_MIN_LEN) {
    return `Filtering by “${q}”`;
  }
  return null;
}

/**
 * Keeps checkboxes, selection pill, toolbar, and action buttons in sync with state.
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
export function syncSelectionUI(root, state) {
  const { visible: visiblePages } = getVisiblePages(state);
  const activeCount = getActiveSelectionCount(state);
  const listBusy = visiblePages.length === 0 || state.statusChecking;

  const pill = root.querySelector('#bulk-pp-selection-pill');
  if (pill) pill.textContent = formatSelectionPillText(state);

  root.querySelectorAll('.bulk-pp-page-cb').forEach((cb) => {
    if (!(cb instanceof HTMLInputElement)) return;
    const path = cb.dataset.path || cb.value;
    cb.checked = state.selected.has(path);
  });

  const selectAllBtn = root.querySelector('#bulk-pp-select-all');
  const selectNoneBtn = root.querySelector('#bulk-pp-select-none');
  if (selectAllBtn instanceof HTMLButtonElement) selectAllBtn.disabled = listBusy;
  if (selectNoneBtn instanceof HTMLButtonElement) {
    selectNoneBtn.disabled = listBusy || activeCount === 0;
  }

  syncOpenSelectedActionButtons(root, state);
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {(folder: { name: string, folderPath: string }, onNavigate: (p: string) => void, locked: boolean) => HTMLElement} buildFolderRow
 */
export function patchFolderSearchResults(root, state, buildFolderRow) {
  const visibleFolders = getVisibleFolders(state);
  const draft = String(state.folderSearch || '').trim();
  const tooShort = draft.length > 0 && draft.length < SEARCH_MIN_LEN;

  const count = root.querySelector('#bulk-pp-folder-count');
  if (count) {
    count.textContent = draft && !tooShort
      ? `${visibleFolders.length} of ${state.folders.length}`
      : String(state.folders.length);
  }

  const hint = root.querySelector('#bulk-pp-folder-search-hint');
  const hintMsg = searchHintText(state.folderSearch);
  if (hint) {
    hint.hidden = !hintMsg;
    if (hintMsg) hint.textContent = hintMsg;
  }

  const list = root.querySelector('#bulk-pp-folder-list');
  if (!list) return;
  list.replaceChildren();
  if (visibleFolders.length === 0) {
    const emptyMsg = tooShort
      ? `Type at least ${SEARCH_MIN_LEN} characters to search.`
      : draft
        ? 'No folders match this search.'
        : 'No folders in this location.';
    list.append(el('li', 'bulk-pp-list-empty', emptyMsg));
  } else {
    visibleFolders.forEach((folder) => {
      list.append(buildFolderRow(
        folder,
        (path) => state.onNavigate(path),
        state.statusChecking,
      ));
    });
  }
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
  const tooShort = draft.length > 0 && draft.length < SEARCH_MIN_LEN;

  const count = root.querySelector('#bulk-pp-page-count');
  if (count) {
    count.textContent = draft && !tooShort
      ? `${visiblePages.length} of ${state.pages.length}`
      : String(state.pages.length);
  }

  const hint = root.querySelector('#bulk-pp-page-search-hint');
  const hintMsg = searchHintText(state.pageSearch);
  if (hint) {
    hint.hidden = !hintMsg;
    if (hintMsg) hint.textContent = hintMsg;
  }

  const list = root.querySelector('#bulk-pp-page-list');
  if (!list) return;
  list.replaceChildren();
  if (state.pages.length === 0) {
    list.append(el('li', 'bulk-pp-list-empty', 'No pages in this scope.'));
  } else if (visiblePages.length === 0) {
    const emptyMsg = tooShort
      ? `Type at least ${SEARCH_MIN_LEN} characters to search.`
      : draft
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
        isStatusLoaded(state),
        siteCtx,
        state.statusChecking,
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
  input.addEventListener('input', () => {
    if (kind === 'folder') state.folderSearch = input.value;
    else state.pageSearch = input.value;
    patchFn();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      if (kind === 'folder') state.folderSearch = '';
      else state.pageSearch = '';
      patchFn();
    }
  });
}
