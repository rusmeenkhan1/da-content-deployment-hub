import { listFolderEntries } from './api.js';
import { el } from './dom.js';
import { normalizeFolderPath } from './paths.js';
import {
  filterFoldersBySearch,
  SEARCH_MIN_LEN,
} from './state.js';

/** @typedef {{ kind: 'folder', name: string, folderPath: string }} FolderEntry */

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
export function ensureFolderTreeState(state) {
  if (!state.folderTreeCache) state.folderTreeCache = {};
  if (!state.expandedFolders) state.expandedFolders = new Set(['']);
  if (!state.folderTreeLoading) state.folderTreeLoading = new Set();
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {string} parentPath
 * @param {FolderEntry[]} folders
 */
export function seedFolderTreeCache(state, parentPath, folders) {
  ensureFolderTreeState(state);
  const key = normalizeFolderPath(parentPath);
  state.folderTreeCache[key] = folders.map((folder) => ({
    kind: 'folder',
    name: folder.name,
    folderPath: normalizeFolderPath(folder.folderPath),
  }));
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {string} folderPath
 */
export function expandFolderAncestors(state, folderPath) {
  ensureFolderTreeState(state);
  state.expandedFolders.add('');
  const normalized = normalizeFolderPath(folderPath);
  if (!normalized) return;
  const parts = normalized.split('/');
  let path = '';
  parts.forEach((part) => {
    path = path ? `${path}/${part}` : part;
    state.expandedFolders.add(path);
  });
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
export function flattenCachedFolders(state) {
  ensureFolderTreeState(state);
  const seen = new Map();
  Object.values(state.folderTreeCache).forEach((folders) => {
    folders.forEach((folder) => {
      if (!seen.has(folder.folderPath)) seen.set(folder.folderPath, folder);
    });
  });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
export function countCachedFolders(state) {
  return flattenCachedFolders(state).length;
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
export function isFolderSearchActive(state) {
  const q = String(state.folderSearch || '').trim();
  return q.length >= SEARCH_MIN_LEN;
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
export function getFolderSearchResults(state) {
  return filterFoldersBySearch(
    flattenCachedFolders(state),
    state.folderSearch,
    SEARCH_MIN_LEN,
  );
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 */
export function getFolderCountLabel(state) {
  if (isFolderSearchActive(state)) {
    const matches = getFolderSearchResults(state);
    const total = countCachedFolders(state);
    return `${matches.length} of ${total}`;
  }
  const cached = countCachedFolders(state);
  if (cached > 0) return String(cached);
  return String(state.folders.length);
}

/**
 * Load each ancestor level so the tree can render down to folderPath.
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {Function | null} daFetch
 * @param {string} folderPath
 */
export async function hydrateFolderTreeToPath(state, daFetch, folderPath) {
  ensureFolderTreeState(state);
  expandFolderAncestors(state, folderPath);
  if (!daFetch) return;

  const normalized = normalizeFolderPath(folderPath);
  const segments = normalized ? normalized.split('/') : [];
  let current = '';

  for (let i = 0; i <= segments.length; i += 1) {
    const key = current;
    if (!state.folderTreeCache[key]) {
      // Sequential loads required — each level depends on the parent path.
      // eslint-disable-next-line no-await-in-loop
      const entries = await listFolderEntries(
        daFetch,
        state.org,
        state.site,
        key,
      );
      state.folderTreeCache[key] = entries.filter((entry) => entry.kind === 'folder');
    }
    if (i >= segments.length) break;
    current = current ? `${current}/${segments[i]}` : segments[i];
  }
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {Function | null} daFetch
 * @param {string} folderPath
 */
export async function loadFolderTreeChildren(state, daFetch, folderPath) {
  ensureFolderTreeState(state);
  const key = normalizeFolderPath(folderPath);
  if (state.folderTreeCache[key]) return state.folderTreeCache[key];
  if (!daFetch) return [];

  state.folderTreeLoading.add(key);
  try {
    const entries = await listFolderEntries(
      daFetch,
      state.org,
      state.site,
      key,
    );
    const folders = entries.filter((entry) => entry.kind === 'folder');
    state.folderTreeCache[key] = folders;
    return folders;
  } finally {
    state.folderTreeLoading.delete(key);
  }
}

/**
 * @param {string} folderPath
 * @param {string} label
 * @param {number} depth
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {(path: string) => void} onNavigate
 * @param {boolean} locked
 */
function buildFolderTreeRootRow(
  folderPath,
  label,
  depth,
  state,
  onNavigate,
  locked,
) {
  const normalized = normalizeFolderPath(folderPath);
  const selected = normalizeFolderPath(state.folderPath) === normalized;
  const expanded = state.expandedFolders.has(normalized);
  const loading = state.folderTreeLoading.has(normalized);
  const children = state.folderTreeCache[normalized] || [];
  const hasLoadedChildren = Object.prototype.hasOwnProperty.call(
    state.folderTreeCache,
    normalized,
  );
  const canExpand = !hasLoadedChildren || children.length > 0;

  const row = el('div', 'bulk-pp-folder-tree-row');
  row.classList.toggle('bulk-pp-folder-tree-row-selected', selected);
  row.style.setProperty('--pp-tree-depth', String(depth));

  if (canExpand) {
    const toggle = el('button', 'bulk-pp-folder-tree-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', expanded ? `Collapse ${label}` : `Expand ${label}`);
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.disabled = locked || loading;
    toggle.classList.toggle('bulk-pp-folder-tree-toggle-expanded', expanded);
    toggle.classList.toggle('bulk-pp-folder-tree-toggle-loading', loading);
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (locked || loading) return;
      if (typeof state.onExpandFolder === 'function') {
        state.onExpandFolder(normalized, !expanded);
      }
    });
    row.append(toggle);
  } else {
    row.append(el('span', 'bulk-pp-folder-tree-toggle-spacer'));
  }

  const icon = el('span', 'bulk-pp-item-icon bulk-pp-icon-folder');
  icon.setAttribute('aria-hidden', 'true');
  row.append(icon);

  const link = el('button', 'bulk-pp-folder-tree-label', label);
  link.type = 'button';
  link.disabled = locked;
  if (locked) {
    link.setAttribute('aria-disabled', 'true');
  } else {
    link.title = normalized ? `Open ${label}` : 'Open site root';
  }
  link.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (locked) return;
    onNavigate(normalized);
  });
  row.append(link);

  return row;
}

/**
 * @param {FolderEntry} folder
 * @param {number} depth
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {(path: string) => void} onNavigate
 * @param {boolean} locked
 */
function buildFolderTreeNode(folder, depth, state, onNavigate, locked) {
  const normalized = normalizeFolderPath(folder.folderPath);
  const node = el('li', 'bulk-pp-folder-tree-node');
  node.dataset.path = normalized;
  node.append(buildFolderTreeRootRow(
    normalized,
    folder.name,
    depth,
    state,
    onNavigate,
    locked,
  ));

  const expanded = state.expandedFolders.has(normalized);
  const children = state.folderTreeCache[normalized];
  if (expanded && children && children.length > 0) {
    const childList = el('ul', 'bulk-pp-folder-tree-children');
    children.forEach((child) => {
      childList.append(buildFolderTreeNode(child, depth + 1, state, onNavigate, locked));
    });
    node.append(childList);
  } else if (expanded && children && children.length === 0) {
    const emptyChild = el('ul', 'bulk-pp-folder-tree-children bulk-pp-folder-tree-children-empty');
    emptyChild.append(el('li', 'bulk-pp-folder-tree-empty-note', 'No subfolders'));
    node.append(emptyChild);
  }

  return node;
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {(path: string) => void} onNavigate
 * @param {boolean} locked
 */
function buildFolderSearchList(state, onNavigate, locked) {
  const wrap = el('div', 'bulk-pp-folder-tree-search');
  wrap.id = 'bulk-pp-folder-tree';
  const list = el('ul', 'bulk-pp-folder-tree-flat');
  const matches = getFolderSearchResults(state);

  if (matches.length === 0) {
    list.append(el('li', 'bulk-pp-list-empty', 'No folders match this search.'));
  } else {
    matches.forEach((folder) => {
      const li = el('li', 'bulk-pp-folder-tree-flat-item');
      const icon = el('span', 'bulk-pp-item-icon bulk-pp-icon-folder');
      icon.setAttribute('aria-hidden', 'true');
      const link = el('button', 'bulk-pp-folder-tree-label', folder.name);
      link.type = 'button';
      link.disabled = locked;
      link.title = folder.folderPath || 'Site root';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (locked) return;
        onNavigate(folder.folderPath);
      });
      const pathHint = el('span', 'bulk-pp-folder-tree-flat-path', folder.folderPath || '/');
      li.append(icon, link, pathHint);
      list.append(li);
    });
  }

  wrap.append(list);
  return wrap;
}

/**
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {(path: string) => void} onNavigate
 * @param {boolean} locked
 */
export function buildFolderTree(state, onNavigate, locked) {
  ensureFolderTreeState(state);

  if (isFolderSearchActive(state)) {
    return buildFolderSearchList(state, onNavigate, locked);
  }

  const tree = el('ul', 'bulk-pp-folder-tree');
  tree.id = 'bulk-pp-folder-tree';
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Site directories');

  const rootNode = el('li', 'bulk-pp-folder-tree-node bulk-pp-folder-tree-node-root');
  rootNode.dataset.path = '';
  rootNode.append(buildFolderTreeRootRow(
    '',
    'Site root',
    0,
    state,
    onNavigate,
    locked,
  ));

  const rootExpanded = state.expandedFolders.has('');
  const rootChildren = state.folderTreeCache[''] || [];
  if (rootExpanded && rootChildren.length > 0) {
    const childList = el('ul', 'bulk-pp-folder-tree-children');
    childList.setAttribute('role', 'group');
    rootChildren.forEach((folder) => {
      childList.append(buildFolderTreeNode(folder, 1, state, onNavigate, locked));
    });
    rootNode.append(childList);
  } else if (rootExpanded && rootChildren.length === 0 && Object.prototype.hasOwnProperty.call(state.folderTreeCache, '')) {
    const emptyChild = el('ul', 'bulk-pp-folder-tree-children bulk-pp-folder-tree-children-empty');
    emptyChild.append(el('li', 'bulk-pp-folder-tree-empty-note', 'No subfolders'));
    rootNode.append(emptyChild);
  }

  tree.append(rootNode);
  return tree;
}

/**
 * @param {HTMLElement} host
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {(path: string) => void} onNavigate
 * @param {boolean} locked
 */
export function renderFolderTree(host, state, onNavigate, locked) {
  host.replaceChildren(buildFolderTree(state, onNavigate, locked));
}

/**
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import('./state.js').createAppState>} state
 * @param {(path: string) => void} onNavigate
 * @param {boolean} locked
 */
export function patchFolderTree(root, state, onNavigate, locked) {
  const count = root.querySelector('#bulk-pp-folder-count');
  if (count) count.textContent = getFolderCountLabel(state);

  const host = root.querySelector('#bulk-pp-folder-tree-host');
  if (host) renderFolderTree(host, state, onNavigate, locked);
}
