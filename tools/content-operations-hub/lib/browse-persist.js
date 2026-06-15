import { normalizeFolderPath } from './paths.js';

const STORAGE_KEY = 'bulk-pp-browse-location-v1';
const CACHE_VERSION = 1;

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 */
function buildSiteKey(org, site, ref) {
  return `${org}|${site}|${ref}`;
}

/**
 * @returns {{ v: number, sites: Record<string, { folderPath: string, pageScope: 'folder'|'tree' }> }}
 */
function readStore() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { v: CACHE_VERSION, sites: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== CACHE_VERSION) {
      return { v: CACHE_VERSION, sites: {} };
    }
    if (!parsed.sites || typeof parsed.sites !== 'object') {
      return { v: CACHE_VERSION, sites: {} };
    }
    return /** @type {{ v: number, sites: Record<string, { folderPath: string, pageScope: 'folder'|'tree' }> }} */ (parsed);
  } catch {
    return { v: CACHE_VERSION, sites: {} };
  }
}

/**
 * @param {{ v: number, sites: Record<string, { folderPath: string, pageScope: 'folder'|'tree' }> }} store
 */
function writeStore(store) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch (err) {
    console.warn('[bulk-pp] browse location persist failed', err);
    return false;
  }
}

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @returns {{ folderPath: string, pageScope: 'folder'|'tree' } | null}
 */
export function readBrowseLocation(org, site, ref) {
  const store = readStore();
  const entry = store.sites[buildSiteKey(org, site, ref)];
  if (!entry || typeof entry !== 'object') return null;
  const folderPath = normalizeFolderPath(String(entry.folderPath || ''));
  const pageScope = entry.pageScope === 'tree' ? 'tree' : 'folder';
  return { folderPath, pageScope };
}

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string} folderPath
 * @param {'folder'|'tree'} pageScope
 */
export function writeBrowseLocation(org, site, ref, folderPath, pageScope) {
  const store = readStore();
  const siteKey = buildSiteKey(org, site, ref);
  const normalized = normalizeFolderPath(folderPath);
  const scope = pageScope === 'tree' ? 'tree' : 'folder';
  if (!normalized && scope === 'folder') {
    delete store.sites[siteKey];
  } else {
    store.sites[siteKey] = { folderPath: normalized, pageScope: scope };
  }
  writeStore(store);
}
