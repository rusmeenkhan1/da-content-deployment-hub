const DA_ADMIN = 'https://admin.da.live';
const HLX_ADMIN = 'https://admin.hlx.page';

export { DA_ADMIN, HLX_ADMIN };

/**
 * Undo accidental URI encoding in paths (e.g. who-we-are%2Four-stories%2Fpage).
 * @param {string} path
 * @returns {string}
 */
export function decodeHelixPath(path) {
  if (!path) return path;
  let p = String(path);
  try {
    for (let i = 0; i < 3; i += 1) {
      const next = decodeURIComponent(p);
      if (next === p) break;
      p = next;
    }
  } catch {
    // keep original
  }
  return p;
}

/** Helix bulk path → AEM web path (strip /index folder homepage suffix). */
export function helixToWebPath(helixPath) {
  const decoded = decodeHelixPath(helixPath);
  const norm = !decoded || decoded === '/' ? '/' : (
    decoded.startsWith('/') ? decoded : `/${decoded}`
  );
  if (norm === '/index' || norm.endsWith('/index')) {
    const parent = norm === '/index' ? '' : norm.slice(0, -'/index'.length);
    return parent || '/';
  }
  return norm;
}

/**
 * Normalize a DA source folder path (no leading/trailing slashes).
 * @param {string} path
 * @returns {string}
 */
export function normalizeFolderPath(path) {
  if (!path || path === '/') return '';
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Folder path for the UI input (empty = site root).
 * @param {string} path internal normalized path
 * @returns {string}
 */
export function displayFolderPath(path) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return '';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/**
 * DA may pass the app route (tools/content-operations-hub) as context.path — not content.
 * @param {string} path
 * @returns {boolean}
 */
export function isAppRoutePath(path) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return false;
  if (normalized === 'tools' || normalized.startsWith('tools/')) return true;
  return normalized.includes('content-operations-hub') && normalized.startsWith('tools');
}

/**
 * Resolve folder path for content listing (never the tool's own /tools/... route).
 * @param  {...string} candidates
 * @returns {string}
 */
export function resolveContentFolderPath(...candidates) {
  const found = candidates.find((p) => p != null && String(p).trim() !== '');
  if (!found) return '';
  const normalized = normalizeFolderPath(String(found));
  if (isAppRoutePath(normalized)) return '';
  return normalized;
}

/**
 * Join folder segments.
 * @param  {...string} parts
 * @returns {string}
 */
export function joinPath(...parts) {
  return parts
    .map((p) => normalizeFolderPath(p))
    .filter(Boolean)
    .join('/');
}

/**
 * @param {{ name: string, 'content-type'?: string, ext?: string }} item
 * @returns {boolean}
 */
/**
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
export function getContentType(item) {
  return String(item.contentType || item['content-type'] || '').toLowerCase();
}

export function isFolderEntry(item) {
  if (item.isFolder || item.folder) return true;
  const name = String(item.name || '');
  const path = String(item.path || '');
  if (name.endsWith('/') || path.endsWith('/')) return true;
  const type = getContentType(item);
  if (type === 'application/folder' || type.includes('folder')) return true;
  const entryType = String(item.type || item.kind || '').toLowerCase();
  if (entryType === 'folder' || entryType === 'directory' || entryType === 'dir') return true;
  if (item.isdir === true || item.isDirectory === true) return true;
  return false;
}

/**
 * DA page documents often use these names without a file extension (index, footer, …).
 * Section folders (library, who-we-are, science) use other names — do not treat as pages.
 */
/** Page documents in DA Browse (index, nav, footer, …). */
export const KNOWN_PAGE_DOC_NAMES = new Set([
  'index',
  'nav',
  'footer',
  'header',
  '404',
  'sitemap',
  'robots',
]);

/** Site config / data files in DA Browse (not bulk-published as pages). */
export const KNOWN_DATA_DOC_NAMES = new Set([
  'metadata',
  'placeholders',
  'redirects',
  'config',
]);

/**
 * Config or data file (metadata, placeholders, redirects, JSON, …).
 * @param {Record<string, unknown>} item
 * @returns {boolean}
 */
export function isDataDocument(item) {
  if (isFolderEntry(item)) return false;

  const name = getEntryName(item);
  if (!name) return false;

  if (KNOWN_DATA_DOC_NAMES.has(name.toLowerCase())) return true;

  const ext = String(item.ext || '').toLowerCase();
  if (ext === 'json' || ext === 'yaml' || ext === 'yml') return true;

  const contentType = getContentType(item);
  if (contentType === 'application/json' || contentType.endsWith('+json')) return true;

  const entryType = String(item.type || item.kind || '').toLowerCase();
  if (entryType === 'data' || entryType === 'spreadsheet' || entryType === 'config') return true;

  return false;
}

/**
 * Extensionless listing entry that is a content section folder, not a root page doc.
 * @param {Record<string, unknown>} item
 * @returns {boolean}
 */
export function isSectionFolder(item) {
  if (isFolderEntry(item)) return true;
  if (isDataDocument(item)) return false;
  if (isPageDocument(item)) return false;

  const name = getEntryName(item);
  if (!name) return false;

  const ext = String(item.ext || '').toLowerCase();
  if (ext) return false;
  if (KNOWN_PAGE_DOC_NAMES.has(name.toLowerCase())) return false;
  if (KNOWN_DATA_DOC_NAMES.has(name.toLowerCase())) return false;

  const contentType = getContentType(item);
  if (contentType === 'text/html') return false;

  return true;
}

/**
 * @typedef {'folder' | 'document' | 'data'} EntryKind
 */

/**
 * Classify a DA list item the same way as DA Browse (folder / page / config).
 * @param {Record<string, unknown>} item
 * @returns {EntryKind | null}
 */
export function classifyEntry(item) {
  if (isFolderEntry(item) || isSectionFolder(item)) return 'folder';
  if (isDataDocument(item)) return 'data';
  if (isPageDocument(item)) return 'document';
  return null;
}

/** MIME types that are never bulk preview/publish pages */
const NON_PAGE_CONTENT_TYPES = [
  'application/json',
  'application/pdf',
  'application/folder',
];

/**
 * File extensions that are not HTML pages in DA.
 */
const NON_PAGE_EXTENSIONS = new Set([
  'json', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'mp4', 'webp', 'ico',
]);

/**
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
export function getEntryName(item) {
  const name = String(item.name || '').replace(/\/$/, '');
  if (name) return name;
  const path = String(item.path || '');
  if (!path) return '';
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

/**
 * DA lists pages as documents (e.g. index, nav, footer) — not always *.html names.
 * @param {Record<string, unknown>} item
 * @returns {boolean}
 */
export function isPageDocument(item) {
  if (isFolderEntry(item)) return false;
  if (isDataDocument(item)) return false;

  const name = getEntryName(item);
  if (!name) return false;

  const contentType = getContentType(item);
  const ext = String(item.ext || '').toLowerCase();

  if (contentType === 'text/html') return true;
  if (ext === 'html') return true;
  if (name.endsWith('.html')) return true;
  if (item.type === 'document' || item.kind === 'document') return true;

  if (ext && NON_PAGE_EXTENSIONS.has(ext)) return false;
  if (NON_PAGE_CONTENT_TYPES.some((t) => contentType === t || contentType.startsWith(`${t};`))) {
    return false;
  }
  if (contentType.startsWith('image/') || contentType.startsWith('video/')) return false;
  if (name.endsWith('.json') || ext === 'json') return false;

  // Extensionless DA page docs (index, nav, footer) — not section folders (library, science, …)
  if (!ext && !contentType) {
    return KNOWN_PAGE_DOC_NAMES.has(name.toLowerCase());
  }
  if (!ext && contentType) {
    return contentType === 'text/html' && !contentType.includes('folder');
  }

  return false;
}

/**
 * DA source path (e.g. drafts/foo/page.html) → Helix bulk path (/drafts/foo/page).
 * @param {string} folderPath
 * @param {string} fileName
 * @returns {string}
 */
export function toHelixPath(folderPath, fileName) {
  const base = joinPath(folderPath, fileName.replace(/\.html$/i, ''));
  return base ? `/${base}` : '/';
}

/**
 * DA edit path: same as the page URL path (no /index suffix).
 * e.g. /who-we-are/brand-partnerships → who-we-are/brand-partnerships, /index → index
 * @param {string} helixPath
 * @param {string} [sourcePath]
 * @returns {string}
 */
/**
 * Path segment for DA Source DELETE (files need extension; folder pages omit /index).
 * @param {string} sourcePath
 * @param {string} [helixPath]
 * @returns {string}
 */
export function sourcePathToDaDeletePath(sourcePath, helixPath = '') {
  const raw = normalizeFolderPath(String(sourcePath || '').replace(/\.html$/i, ''));
  const helix = normalizeFolderPath(String(helixPath || '').replace(/^\//, ''));

  if (raw.endsWith('/index') && raw !== 'index') {
    return raw.slice(0, -'/index'.length);
  }
  if (helix.endsWith('/index') && helix !== 'index') {
    const folder = helix.slice(0, -'/index'.length);
    if (!raw || raw === helix || raw.endsWith('/index')) return folder;
  }
  if (raw === 'index' && (!helix || helix === 'index')) {
    return 'index.html';
  }

  const original = normalizeFolderPath(sourcePath);
  if (/\.[a-z0-9]+$/i.test(original)) return original;
  return raw ? `${raw}.html` : 'index.html';
}

export function helixPathToDaDocumentPath(helixPath, sourcePath) {
  const web = helixToWebPath(helixPath);
  if (web && web !== '/') {
    return normalizeFolderPath(web.replace(/^\//, '').replace(/\.html$/i, '')) || 'index';
  }
  if (web === '/') return 'index';

  const fromSource = normalizeFolderPath(String(sourcePath || '').replace(/\.html$/i, ''));
  if (fromSource.endsWith('/index') && fromSource !== 'index') {
    return fromSource.slice(0, -'/index'.length) || 'index';
  }
  return fromSource || 'index';
}

/**
 * Helix path without leading slash (e.g. ab/bc/page3).
 * @param {string} helixPath
 * @returns {string}
 */
export function helixPathToListKey(helixPath) {
  const raw = helixPath.startsWith('/') ? helixPath.slice(1) : helixPath;
  return normalizeFolderPath(raw) || 'index';
}

/**
 * Label for the page list: path relative to the folder you are browsing.
 * Root: page1, ab/page4. Inside ab/: page4, bc/page3.
 * @param {string} helixPath
 * @param {string} browseFolder normalized DA folder (empty = site root)
 * @returns {string}
 */
export function pageListRelativePath(helixPath, browseFolder) {
  const full = helixPathToListKey(helixPath);
  const base = normalizeFolderPath(browseFolder);
  if (!base) return full;
  if (full === base) return lastSegment(full) || full;
  if (full.startsWith(`${base}/`)) return full.slice(base.length + 1);
  return full;
}

/**
 * Path depth under the folder being browsed (0 = page in this folder, 1 = one subfolder, …).
 * @param {string} relativePath from pageListRelativePath
 */
export function pageListDepth(relativePath) {
  const rel = String(relativePath || '');
  if (!rel) return 0;
  return (rel.match(/\//g) || []).length;
}

/**
 * @param {string} path
 */
function lastSegment(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * @param {{ helixPath: string }[]} pages
 * @param {string} browseFolder
 * @returns {{ helixPath: string }[]}
 */
export function sortPagesByListPath(pages, browseFolder) {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return [...pages].sort((a, b) => {
    const relA = pageListRelativePath(a.helixPath, browseFolder);
    const relB = pageListRelativePath(b.helixPath, browseFolder);
    const depthA = pageListDepth(relA);
    const depthB = pageListDepth(relB);
    if (depthA !== depthB) return depthA - depthB;
    return collator.compare(relA, relB);
  });
}

/**
 * @param {string} helixPath
 * @param {string} name
 * @param {string} [browseFolder]
 * @returns {{ title: string, subtitle: string | null }}
 */
export function formatPageListLabel(helixPath, _name, browseFolder = '') {
  return { title: pageListRelativePath(helixPath, browseFolder), subtitle: null };
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
export function dedupePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}
