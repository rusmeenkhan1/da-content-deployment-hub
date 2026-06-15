/** @typedef {{ previewedAt?: number, publishedAt?: number, checkedAt: number }} CachedStatusEntry */

const STORAGE_KEY = 'bulk-pp-deployment-status-v1';
const CACHE_VERSION = 1;
/** @type {number} */
const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** @type {number} */
const MAX_PATHS_PER_SITE = 8000;

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 */
function buildSiteKey(org, site, ref) {
  return `${org}|${site}|${ref}`;
}

/**
 * @returns {{ v: number, sites: Record<string, Record<string, CachedStatusEntry>> }}
 */
function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { v: CACHE_VERSION, sites: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== CACHE_VERSION) {
      return { v: CACHE_VERSION, sites: {} };
    }
    if (!parsed.sites || typeof parsed.sites !== 'object') {
      return { v: CACHE_VERSION, sites: {} };
    }
    return /** @type {{ v: number, sites: Record<string, Record<string, CachedStatusEntry>> }} */ (parsed);
  } catch {
    return { v: CACHE_VERSION, sites: {} };
  }
}

/**
 * @param {{ v: number, sites: Record<string, Record<string, CachedStatusEntry>> }} store
 */
function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch (err) {
    console.warn('[bulk-pp] deployment status cache write failed', err);
    return false;
  }
}

/**
 * @param {Record<string, CachedStatusEntry>} siteCache
 */
function pruneSiteCache(siteCache) {
  const now = Date.now();
  Object.keys(siteCache).forEach((path) => {
    const entry = siteCache[path];
    if (!entry || typeof entry.checkedAt !== 'number' || now - entry.checkedAt > MAX_ENTRY_AGE_MS) {
      delete siteCache[path];
    }
  });

  const paths = Object.keys(siteCache);
  if (paths.length <= MAX_PATHS_PER_SITE) return;

  paths.sort((a, b) => (siteCache[a]?.checkedAt || 0) - (siteCache[b]?.checkedAt || 0));
  const removeCount = paths.length - MAX_PATHS_PER_SITE;
  for (let i = 0; i < removeCount; i += 1) {
    delete siteCache[paths[i]];
  }
}

/**
 * @param {{ previewedAt?: number, publishedAt?: number }} entry
 * @param {number} checkedAt
 * @returns {CachedStatusEntry}
 */
function toCachedEntry(entry, checkedAt) {
  /** @type {CachedStatusEntry} */
  const cached = { checkedAt };
  if (typeof entry.previewedAt === 'number' && entry.previewedAt > 0) {
    cached.previewedAt = entry.previewedAt;
  }
  if (typeof entry.publishedAt === 'number' && entry.publishedAt > 0) {
    cached.publishedAt = entry.publishedAt;
  }
  return cached;
}

/**
 * @param {CachedStatusEntry | undefined} entry
 */
function isFreshEntry(entry) {
  if (!entry || typeof entry.checkedAt !== 'number') return false;
  return Date.now() - entry.checkedAt <= MAX_ENTRY_AGE_MS;
}

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @returns {Record<string, CachedStatusEntry>}
 */
function getSiteCache(org, site, ref) {
  const store = readStore();
  return store.sites[buildSiteKey(org, site, ref)] || {};
}

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string[]} helixPaths
 * @returns {Record<string, { previewedAt?: number, publishedAt?: number }>}
 */
export function readCachedPlatformStatus(org, site, ref, helixPaths) {
  const siteCache = getSiteCache(org, site, ref);
  /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */
  const result = {};
  helixPaths.forEach((path) => {
    const entry = siteCache[path];
    if (!isFreshEntry(entry)) return;
    /** @type {{ previewedAt?: number, publishedAt?: number }} */
    const row = {};
    if (entry.previewedAt) row.previewedAt = entry.previewedAt;
    if (entry.publishedAt) row.publishedAt = entry.publishedAt;
    result[path] = row;
  });
  return result;
}

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string[]} helixPaths
 */
export function hasCompleteCachedStatus(org, site, ref, helixPaths) {
  if (helixPaths.length === 0) return false;
  const siteCache = getSiteCache(org, site, ref);
  return helixPaths.every((path) => isFreshEntry(siteCache[path]));
}

/**
 * Helix paths with no fresh cached deployment status.
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string[]} helixPaths
 * @returns {string[]}
 */
export function getUncachedHelixPaths(org, site, ref, helixPaths) {
  if (helixPaths.length === 0) return [];
  const siteCache = getSiteCache(org, site, ref);
  return helixPaths.filter((path) => !isFreshEntry(siteCache[path]));
}

/**
 * Most recent checkedAt across fresh cached entries for the given paths.
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string[]} helixPaths
 * @returns {number | null}
 */
export function getLatestCachedStatusCheckedAt(org, site, ref, helixPaths) {
  if (helixPaths.length === 0) return null;
  const siteCache = getSiteCache(org, site, ref);
  let maxCheckedAt = 0;
  helixPaths.forEach((path) => {
    const entry = siteCache[path];
    if (!isFreshEntry(entry)) return;
    maxCheckedAt = Math.max(maxCheckedAt, entry.checkedAt || 0);
  });
  return maxCheckedAt > 0 ? maxCheckedAt : null;
}

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {Record<string, { previewedAt?: number, publishedAt?: number }>} platformStatus
 */
export function mergePlatformStatusIntoCache(org, site, ref, platformStatus) {
  if (!platformStatus || typeof platformStatus !== 'object') return;
  const paths = Object.keys(platformStatus);
  if (paths.length === 0) return;

  const store = readStore();
  const siteKey = buildSiteKey(org, site, ref);
  if (!store.sites[siteKey]) store.sites[siteKey] = {};
  const siteCache = store.sites[siteKey];
  const checkedAt = Date.now();

  paths.forEach((path) => {
    if (!path) return;
    siteCache[path] = toCachedEntry(platformStatus[path] || {}, checkedAt);
  });

  pruneSiteCache(siteCache);
  writeStore(store);
}

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string[]} helixPaths
 */
export function removePathsFromStatusCache(org, site, ref, helixPaths) {
  if (helixPaths.length === 0) return;
  const store = readStore();
  const siteKey = buildSiteKey(org, site, ref);
  const siteCache = store.sites[siteKey];
  if (!siteCache) return;

  helixPaths.forEach((path) => {
    delete siteCache[path];
  });

  if (Object.keys(siteCache).length === 0) {
    delete store.sites[siteKey];
  }
  writeStore(store);
}

/**
 * @param {'preview'|'live'|'unpreview'|'unpublish'|'delete'} topic
 * @param {string[]} helixPaths
 * @param {Record<string, { previewedAt?: number, publishedAt?: number }>} [existing]
 * @returns {Record<string, { previewedAt?: number, publishedAt?: number }>}
 */
export function buildOptimisticStatusPatch(topic, helixPaths, existing = {}) {
  const now = Date.now();
  /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */
  const patch = {};

  helixPaths.forEach((path) => {
    const prev = existing[path] || {};
    if (topic === 'preview') {
      patch[path] = { ...prev, previewedAt: now };
      return;
    }
    if (topic === 'live') {
      patch[path] = {
        previewedAt: prev.previewedAt || now,
        publishedAt: now,
      };
      return;
    }
    if (topic === 'unpreview') {
      /** @type {{ previewedAt?: number, publishedAt?: number }} */
      const entry = {};
      if (prev.publishedAt) entry.publishedAt = prev.publishedAt;
      patch[path] = entry;
      return;
    }
    if (topic === 'unpublish') {
      /** @type {{ previewedAt?: number, publishedAt?: number }} */
      const entry = {};
      if (prev.previewedAt) entry.previewedAt = prev.previewedAt;
      patch[path] = entry;
    }
  });

  return patch;
}

/**
 * @param {ReturnType<import('./state.js').createAppState>} state
 * @param {Record<string, { previewedAt?: number, publishedAt?: number }>} platformStatus
 */
function mergeStatusEntries(a, b) {
  if (!b || typeof b !== 'object') {
    return a?.previewedAt || a?.publishedAt ? { ...a } : {};
  }

  const hasPreviewKey = Object.prototype.hasOwnProperty.call(b, 'previewedAt');
  const hasPublishKey = Object.prototype.hasOwnProperty.call(b, 'publishedAt');

  // Optimistic remove: one partition cleared, the other kept.
  if (!hasPreviewKey && hasPublishKey) {
    /** @type {{ previewedAt?: number, publishedAt?: number }} */
    const merged = {};
    if (b.publishedAt) merged.publishedAt = b.publishedAt;
    return merged;
  }
  if (hasPreviewKey && !hasPublishKey) {
    /** @type {{ previewedAt?: number, publishedAt?: number }} */
    const merged = {};
    if (b.previewedAt) merged.previewedAt = b.previewedAt;
    return merged;
  }

  if (Object.keys(b).length === 0) {
    /** @type {{ previewedAt?: number, publishedAt?: number }} */
    const merged = {};
    if (a?.previewedAt) merged.previewedAt = a.previewedAt;
    if (a?.publishedAt) merged.publishedAt = a.publishedAt;
    return merged;
  }

  const previewedAt = Math.max(a?.previewedAt || 0, b.previewedAt || 0);
  const publishedAt = Math.max(a?.publishedAt || 0, b.publishedAt || 0);
  /** @type {{ previewedAt?: number, publishedAt?: number }} */
  const merged = {};
  if (previewedAt > 0) merged.previewedAt = previewedAt;
  if (publishedAt > 0) merged.publishedAt = publishedAt;
  return merged;
}

/**
 * @param {ReturnType<import('./state.js').createAppState>} state
 * @param {Record<string, { previewedAt?: number, publishedAt?: number }>} platformStatus
 * @param {{ replacePaths?: string[], removalTopic?: 'unpreview'|'unpublish' }} [options]
 */
export function commitPlatformStatus(state, platformStatus, options = {}) {
  if (!platformStatus || typeof platformStatus !== 'object') return;
  const replacePaths = options.replacePaths?.length
    ? new Set(options.replacePaths)
    : null;
  const { removalTopic } = options;
  const next = { ...state.platformStatus };
  /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */
  const mergedPatch = {};
  Object.entries(platformStatus).forEach(([path, entry]) => {
    let merged;
    if (replacePaths?.has(path)) {
      merged = {};
      if (removalTopic === 'unpreview') {
        if (entry?.publishedAt) merged.publishedAt = entry.publishedAt;
      } else if (removalTopic === 'unpublish') {
        if (entry?.previewedAt) merged.previewedAt = entry.previewedAt;
      } else {
        if (entry?.previewedAt) merged.previewedAt = entry.previewedAt;
        if (entry?.publishedAt) merged.publishedAt = entry.publishedAt;
      }
    } else {
      merged = mergeStatusEntries(next[path], entry);
    }
    next[path] = merged;
    mergedPatch[path] = merged;
  });
  state.platformStatus = next;
  mergePlatformStatusIntoCache(state.org, state.site, state.ref, mergedPatch);
}

/**
 * @param {ReturnType<import('./state.js').createAppState>} state
 */
export function persistCurrentPlatformStatus(state) {
  if (!state.platformStatus || typeof state.platformStatus !== 'object') return;
  mergePlatformStatusIntoCache(state.org, state.site, state.ref, state.platformStatus);
}

/**
 * Hydrate in-memory status from localStorage for the current page list.
 * @param {ReturnType<import('./state.js').createAppState>} state
 * @param {string[]} helixPaths
 * @returns {{ hydrated: boolean, complete: boolean }}
 */
export function hydratePlatformStatusFromCache(state, helixPaths) {
  const cached = readCachedPlatformStatus(state.org, state.site, state.ref, helixPaths);
  const complete = hasCompleteCachedStatus(state.org, state.site, state.ref, helixPaths);
  if (Object.keys(cached).length === 0) {
    return { hydrated: false, complete: false };
  }
  state.platformStatus = { ...cached };
  if (complete) state.statusFetched = true;
  return { hydrated: true, complete };
}
