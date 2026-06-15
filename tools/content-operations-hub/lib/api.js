import {
  DA_ADMIN,
  HLX_ADMIN,
  dedupePaths,
  classifyEntry,
  getEntryName,
  joinPath,
  normalizeFolderPath,
  decodeHelixPath,
  helixToWebPath,
  sourcePathToDaDeletePath,
  toHelixPath,
} from './paths.js';

const ADMIN_STATUS_POST_SUFFIX = 'index';

/** AEM Admin API (preview / live / status / jobs) — same host as Postman. */
const adminApiBase = HLX_ADMIN;

/** Max concurrent per-page status GET workers. */
export const STATUS_PARALLEL_BATCH_SIZE = 20;
/** Below this count, skip slow bulk jobs and fetch per-page in parallel. */
export const STATUS_FAST_PER_PAGE_MAX = 25;
/** Poll interval while waiting for a bulk status job (ms). */
const STATUS_BULK_POLL_MS = 1000;

/**
 * Pass through to DA SDK daFetch (adds Bearer + x-content-source-authorization on admin.hlx.page).
 * @param {Function} baseFetch
 * @returns {Function}
 */
export function wrapDaFetch(baseFetch) {
  return async (url, init = {}) => baseFetch(String(url), init);
}

/**
 * Job links from AEM are already on admin.hlx.page.
 * @param {string} url
 * @returns {string}
 */
function resolveAdminUrl(url) {
  return String(url);
}

/** @typedef {'preview'|'live'|'unpreview'|'unpublish'|'delete'|'status'|'list'} AdminOperation */

const OPERATION_LABELS = {
  preview: 'preview pages',
  live: 'publish pages to production',
  unpreview: 'remove preview deployments',
  unpublish: 'unpublish pages from production',
  delete: 'delete documents from Document Authoring',
  status: 'read deployment status',
  list: 'browse site content',
};

export const CONTENT_OPERATION_HUB_NAME = 'Content Operations Hub';

/** Primary sign-in hint — DA profile / Sign in control is top-right in the shell. */
export const DA_SIGN_IN_TOP_RIGHT_MESSAGE = 'Sign in using the button in the top right, then reload this tool.';

/** Shown when the tool is opened outside DA (preview URLs, missing SDK token, etc.). */
export const DA_AUTH_CONTEXT_MESSAGE = DA_SIGN_IN_TOP_RIGHT_MESSAGE;

/** Shown when daFetch is unavailable at startup. */
export const DA_LOGIN_REQUIRED_MESSAGE = DA_SIGN_IN_TOP_RIGHT_MESSAGE;

/** Shown when org/site context is missing. */
export const DA_SITE_CONTEXT_MESSAGE = `Open ${CONTENT_OPERATION_HUB_NAME} from your site app in Document Authoring.`;

/**
 * @param {string} message
 * @returns {boolean}
 */
export function isDaAccessError(message) {
  return /document authoring|da\.live|content operation hub|preview.*cannot authenticate|not signed in|missing ims client|missing org or site/i.test(
    String(message || ''),
  );
}

/**
 * @param {unknown} data
 * @param {number} status
 * @param {AdminOperation} [operation]
 * @returns {string | null}
 */
export function formatAdminApiError(data, status, operation = '') {
  const raw = data && typeof data === 'object'
    ? String(
      /** @type {{ message?: string, error?: string }} */ (data).message
      /** @type {{ error?: string }} */ || (data).error
            || '',
    )
    : '';
  const opLabel = operation ? OPERATION_LABELS[operation] : '';
  const opSuffix = opLabel ? ` to ${opLabel}` : '';

  if (/missing ims client id/i.test(raw)) {
    return DA_AUTH_CONTEXT_MESSAGE;
  }
  if (status === 401) {
    return DA_SIGN_IN_TOP_RIGHT_MESSAGE;
  }
  if (status === 403) {
    if (raw && !/^forbidden$/i.test(raw.trim())) {
      return `${raw} If this persists, ask your AEM administrator for permission${opSuffix}.`;
    }
    return `You do not have permission${opSuffix}. Ask your AEM administrator to grant the required AEM / DA role for this site.`;
  }
  if (status === 429) {
    return 'Too many requests — wait a moment and try again.';
  }
  return raw || null;
}

/**
 * @param {string} message
 * @param {number} [status]
 * @param {unknown} [data]
 * @returns {Error & { status?: number, data?: unknown }}
 */
function createApiError(message, status = 0, data = null) {
  const err = new Error(message);
  if (status) err.status = status;
  if (data) err.data = data;
  return err;
}

/**
 * @param {unknown} err
 * @param {string} [fallback]
 * @param {AdminOperation} [operation]
 * @returns {string}
 */
export function messageFromApiError(
  err,
  fallback = 'Operation failed.',
  operation = '',
) {
  const raw = err instanceof Error ? err.message : String(err ?? fallback);
  const data = err && typeof err === 'object' && 'data' in err && err.data
    ? err.data
    : { message: raw };
  const status = err && typeof err === 'object' && 'status' in err
    ? Number(/** @type {{ status?: number }} */ (err).status)
    : 0;
  return formatAdminApiError(data, status, operation) || raw || fallback;
}

/**
 * @param {number} status
 * @param {string} message
 * @returns {string}
 */
export const STATUS_ACCESS_DENIED_MESSAGE = 'You do not have access to fetch deployment status for these pages. Ask your AEM administrator for the required preview/publish permissions.';

/**
 * @param {string} message
 * @returns {boolean}
 */
export function isStatusPermissionError(message) {
  const text = String(message || '');
  return /not permitted|permission|forbidden|not authorized|access denied|do not have access/i.test(
    text,
  );
}

export function permissionErrorHint(status, message) {
  const text = String(message || '');
  const looksForbidden = status === 403 || isStatusPermissionError(text);
  if (!looksForbidden) return '';
  return 'You may lack the AEM or Document Authoring role needed for this action. Contact your site administrator to request preview, publish, or content access.';
}

/**
 * @param {Record<string, unknown>} job
 * @returns {string}
 */
function extractJobFailureDetail(job) {
  /** @type {string[]} */
  const parts = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !parts.includes(text)) parts.push(text);
  };

  push(job.message);
  push(job.error);
  const progress = job.progress || job.job?.progress;
  if (progress && typeof progress === 'object') {
    push(/** @type {{ message?: string }} */ (progress).message);
    const errors = /** @type {{ errors?: unknown[] }} */ (progress).errors;
    if (Array.isArray(errors)) {
      errors.slice(0, 3).forEach((item) => {
        if (typeof item === 'string') push(item);
        else if (item && typeof item === 'object') {
          push(
            /** @type {{ message?: string, error?: string }} */ (item).message,
          );
          push(/** @type {{ error?: string }} */ (item).error);
        }
      });
    }
  }

  const jobErrors = job.errors;
  if (Array.isArray(jobErrors)) {
    jobErrors.slice(0, 3).forEach((item) => {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') {
        push(/** @type {{ message?: string }} */ (item).message);
      }
    });
  }

  return parts.join(' · ');
}

/**
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 */
export function assertAdminContext(org, site, ref) {
  if (!org || !site) {
    throw new Error(
      `Missing org or site for AEM Admin API (got org="${org}", site="${site}"). ${DA_SITE_CONTEXT_MESSAGE}`,
    );
  }
}

/**
 * Postman-ready endpoint list for this site.
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string} [helixPath]
 */
function describeAdminEndpoints(org, site, ref, helixPath = '/nav') {
  const web = helixToWebPath(helixPath);
  const bare = web === '/' ? 'index' : web.replace(/^\//, '');
  const segments = bare.split('/').filter(Boolean).join('/');
  const pathSuffix = segments || 'index';
  const base = HLX_ADMIN;
  return {
    auth: 'Authorization: Bearer <token> + x-content-source-authorization (from da.live → Network → admin.hlx.page request)',
    endpoints: [
      {
        method: 'POST',
        url: `${base}/status/${org}/${site}/${ref}/${ADMIN_STATUS_POST_SUFFIX}`,
        body: {
          paths: [web.startsWith('/') ? web : `/${web}`],
          select: ['preview', 'live'],
          forceAsync: true,
        },
      },
      {
        method: 'GET',
        url: `${base}/job/${org}/${site}/${ref}/status/<job-name>/details`,
      },
      {
        method: 'GET',
        url: `${base}/preview/${org}/${site}/${ref}/${pathSuffix}`,
      },
      {
        method: 'GET',
        url: `${base}/live/${org}/${site}/${ref}/${pathSuffix}`,
      },
      {
        method: 'GET',
        url: `${base}/list/${org}/${site}/`,
      },
      {
        method: 'POST',
        url: `${base}/preview/${org}/${site}/${ref}/*`,
        body: {
          paths: [web.startsWith('/') ? web : `/${web}`],
          forceAsync: false,
        },
      },
    ],
  };
}

/**
 * @param {Response} resp
 * @returns {Promise<unknown>}
 */
async function parseJson(resp) {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} data
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeListing(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = /** @type {{ items?: unknown[] }} */ (data);
    if (Array.isArray(obj.items)) return obj.items;
  }
  return [];
}

/**
 * Normalize DA list API items (same shape as da.live nx2 hlx6ToDaList).
 * @param {string} org
 * @param {string} repo
 * @param {string} folderPath
 * @param {unknown} raw
 * @returns {Record<string, unknown>[]}
 */
function normalizeListItems(org, repo, folderPath, raw) {
  const parentPath = `/${org}/${repo}${folderPath ? `/${folderPath}` : ''}`;
  return normalizeListing(raw).map((entry) => {
    const item = /** @type {Record<string, unknown>} */ (entry);
    const rawName = String(item.name || '');
    const entryType = String(item.type || item.kind || '').toLowerCase();
    const isFolder = rawName.endsWith('/')
      || String(item['content-type'] || item.contentType || '').includes(
        'folder',
      )
      || entryType === 'folder'
      || entryType === 'directory'
      || entryType === 'dir'
      || item.isdir === true
      || item.isDirectory === true;
    let name = rawName.replace(/\/$/, '');
    let ext = String(item.ext || '').toLowerCase();

    if (!ext && name.includes('.')) {
      const parts = name.split('.');
      if (parts.length > 1) {
        ext = parts.pop().toLowerCase();
        name = parts.join('.');
      }
    }

    const contentType = item.contentType || item['content-type'] || '';
    const path = item.path
      || (isFolder ? `${parentPath}/${name}/` : `${parentPath}/${name}`);

    return {
      ...item,
      name: isFolder ? `${name}/` : name,
      path,
      ext,
      contentType,
      'content-type': contentType,
      isFolder,
    };
  });
}

/**
 * Fetch paginated JSON from a DA admin URL.
 * @param {Function} daFetch
 * @param {string} url
 * @returns {Promise<unknown[]>}
 */
async function fetchPaginated(daFetch, url) {
  /** @type {unknown[]} */
  const all = [];
  let continuationToken = null;

  /* eslint-disable no-await-in-loop -- paginated listing */
  do {
    const opts = continuationToken
      ? {
        method: 'GET',
        headers: { 'da-continuation-token': continuationToken },
      }
      : { method: 'GET' };
    const resp = await daFetch(url, opts);

    if (resp.status === 404) return all;
    if (!resp.ok) {
      const data = await parseJson(resp);
      const message = formatAdminApiError(data, resp.status, 'list')
        || `Could not list folder (${resp.status})`;
      throw createApiError(message, resp.status, data);
    }

    const data = await parseJson(resp);
    all.push(...normalizeListing(data));
    continuationToken = resp.headers.get('da-continuation-token')
      || resp.headers.get('x-da-continuation-token');
  } while (continuationToken);
  /* eslint-enable no-await-in-loop */

  return all;
}

/**
 * List folder contents. DA Browse uses /list/; /source/ is for file bodies.
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} repo
 * @param {string} folderPath
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function listFolder(daFetch, org, repo, folderPath) {
  const normalized = normalizeFolderPath(folderPath);
  const listPath = normalized ? `/${normalized}` : '';
  const listUrl = `${DA_ADMIN}/list/${org}/${repo}${listPath}`;

  const raw = await fetchPaginated(daFetch, listUrl);
  if (raw.length > 0) {
    return normalizeListItems(org, repo, normalized, raw);
  }

  // HLX6 sites may use source directory listing; skip for invalid/app paths
  const suffix = normalized ? `${normalized}/` : '';
  if (!suffix || suffix.includes('tools/')) {
    return [];
  }

  const sourceUrl = `${DA_ADMIN}/source/${org}/${repo}/${suffix}`;
  const sourceRaw = await fetchPaginated(daFetch, sourceUrl);
  return normalizeListItems(org, repo, normalized, sourceRaw);
}

/**
 * @typedef {{ helixPath: string, sourcePath: string, name: string }} PageEntry
 */

/**
 * @typedef {{ kind: 'folder', name: string, folderPath: string }} FolderEntry
 * @typedef {{ kind: 'document' } & PageEntry} DocumentEntry
 * @typedef {{ kind: 'data', name: string, sourcePath: string }} DataEntry
 * @typedef {FolderEntry | DocumentEntry | DataEntry} BrowseEntry
 */

/**
 * List immediate children of a folder (folders and page documents).
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} repo
 * @param {string} folderPath
 * @returns {Promise<BrowseEntry[]>}
 */
export async function listFolderEntries(daFetch, org, repo, folderPath) {
  const normalized = normalizeFolderPath(folderPath);
  const entries = await listFolder(daFetch, org, repo, normalized);
  /** @type {BrowseEntry[]} */
  const result = [];

  const kindOrder = { folder: 0, document: 1, data: 2 };

  entries.forEach((entry) => {
    const name = getEntryName(entry);
    if (!name) return;

    const kind = classifyEntry(entry);
    if (kind === 'folder') {
      result.push({
        kind: 'folder',
        name,
        folderPath: joinPath(normalized, name),
      });
      return;
    }

    if (kind === 'document') {
      result.push({
        kind: 'document',
        name,
        sourcePath: joinPath(normalized, name),
        helixPath: toHelixPath(normalized, name),
      });
      return;
    }

    if (kind === 'data') {
      result.push({
        kind: 'data',
        name,
        sourcePath: joinPath(normalized, name),
      });
    }
  });

  return result.sort((a, b) => {
    const orderDiff = kindOrder[a.kind] - kindOrder[b.kind];
    if (orderDiff !== 0) return orderDiff;
    const aKey = a.kind === 'document' ? a.helixPath : a.name;
    const bKey = b.kind === 'document' ? b.helixPath : b.name;
    return aKey.localeCompare(bKey);
  });
}

/**
 * Collect HTML pages under a folder up to maxDepth.
 * maxDepth 0 = this folder only; -1 = unlimited.
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} repo
 * @param {string} rootPath
 * @param {number} maxDepth
 * @returns {Promise<PageEntry[]>}
 */
export async function collectPages(daFetch, org, repo, rootPath, maxDepth) {
  const unlimited = maxDepth < 0;
  /** @type {PageEntry[]} */
  const pages = [];

  /**
   * @param {string} folder
   * @param {number} depth
   */
  async function walk(folder, depth) {
    const entries = await listFolder(daFetch, org, repo, folder);
    const subfolders = [];

    entries.forEach((entry) => {
      const name = getEntryName(entry);
      if (classifyEntry(entry) === 'folder') {
        const folderName = String(entry.name || name).replace(/\/$/, '');
        if (folderName) subfolders.push(joinPath(folder, folderName));
        return;
      }
      if (classifyEntry(entry) === 'document') {
        pages.push({
          name,
          sourcePath: joinPath(folder, name),
          helixPath: toHelixPath(folder, name),
        });
      }
    });

    if (!unlimited && depth >= maxDepth) return;

    await Promise.all(subfolders.map((sub) => walk(sub, depth + 1)));
  }

  await walk(normalizeFolderPath(rootPath), 0);
  const byPath = new Map();
  pages.forEach((p) => byPath.set(p.helixPath, p));
  return [...byPath.values()].sort((a, b) => a.helixPath.localeCompare(b.helixPath));
}

/**
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {'preview'|'live'} topic
 * @param {string[]} paths
 * @param {{ delete?: boolean }} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function startBulkJob(
  daFetch,
  org,
  site,
  ref,
  topic,
  paths,
  opts = {},
) {
  const unique = dedupePaths(paths);
  if (unique.length === 0) {
    throw new Error('No pages selected.');
  }

  const route = topic === 'live' ? 'live' : 'preview';
  const url = `${adminApiBase}/${route}/${org}/${site}/${ref}/*`;
  const body = {
    paths: unique,
    forceAsync: unique.length > 5 || Boolean(opts.delete),
    ...(opts.delete ? { delete: true } : {}),
  };

  const resp = await daFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await parseJson(resp);
  if (!resp.ok && resp.status !== 202) {
    const op = topic === 'live' ? 'live' : 'preview';
    const message = formatAdminApiError(data, resp.status, op)
      || `Bulk ${topic} failed (${resp.status})`;
    throw createApiError(message, resp.status, data);
  }

  return data || { status: resp.status };
}

/**
 * @param {string} org
 * @param {string} repo
 * @param {string} deletePath
 * @returns {string}
 */
function buildDaSourceDeleteUrl(org, repo, deletePath) {
  const segments = String(deletePath || '')
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  return `${DA_ADMIN}/source/${org}/${repo}/${segments.join('/')}`;
}

/**
 * Delete one document or folder from the DA content repository.
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} repo
 * @param {string} sourcePath
 * @param {string} [helixPath]
 */
export async function deleteDaSourceDocument(
  daFetch,
  org,
  repo,
  sourcePath,
  helixPath = '',
) {
  const deletePath = sourcePathToDaDeletePath(sourcePath, helixPath);
  const url = buildDaSourceDeleteUrl(org, repo, deletePath);
  const resp = await daFetch(url, { method: 'DELETE' });
  if (resp.status === 204 || resp.status === 404) return;
  const data = await parseJson(resp);
  const message = formatAdminApiError(data, resp.status, 'delete')
    || `Could not delete ${deletePath} (${resp.status})`;
  throw createApiError(message, resp.status, data);
}

/**
 * @typedef {{ helixPath: string, sourcePath: string }} DaPageRef
 */

/**
 * Delete DA source documents one at a time with progress callbacks.
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} repo
 * @param {DaPageRef[]} pages
 * @param {(opts: { processed: number, total: number, failed: number, currentPath?: string }) => void} [onProgress]
 * @param {AbortSignal} [signal]
 */
export async function deleteDaDocumentsSequential(
  daFetch,
  org,
  repo,
  pages,
  onProgress,
  signal,
) {
  let failed = 0;
  /** @type {{ helixPath: string, message: string }[]} */
  const errors = [];
  /** @type {string[]} */
  const deleted = [];

  /* eslint-disable no-await-in-loop -- sequential deletes avoid rate limits */
  for (let i = 0; i < pages.length; i += 1) {
    if (signal?.aborted) throw new DOMException('Delete cancelled', 'AbortError');
    const page = pages[i];
    try {
      await deleteDaSourceDocument(
        daFetch,
        org,
        repo,
        page.sourcePath,
        page.helixPath,
      );
      deleted.push(page.helixPath);
    } catch (err) {
      failed += 1;
      errors.push({
        helixPath: page.helixPath,
        message: messageFromApiError(err, 'Delete failed', 'delete'),
      });
    }
    if (onProgress) {
      onProgress({
        processed: i + 1,
        total: pages.length,
        failed,
        currentPath: page.helixPath,
      });
    }
  }
  /* eslint-enable no-await-in-loop */

  return { deleted, failed, errors };
}

/**
 * Start and poll a bulk remove job (unpreview or unpublish).
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {'preview'|'live'} topic
 * @param {string[]} paths
 * @param {(job: Record<string, unknown>) => void} [onProgress]
 * @param {AbortSignal} [signal]
 */
export async function runBulkRemoveJob(
  daFetch,
  org,
  site,
  ref,
  topic,
  paths,
  onProgress,
  signal,
) {
  const bulkResp = await startBulkJob(daFetch, org, site, ref, topic, paths, {
    delete: true,
  });
  if (signal?.aborted) throw new DOMException('Job cancelled', 'AbortError');

  const jobUrl = getJobPollUrl(bulkResp, org, site, ref, topic);
  if (!jobUrl) {
    return {
      state: 'succeeded',
      progress: { processed: paths.length, total: paths.length, failed: 0 },
    };
  }

  return pollJob(daFetch, jobUrl, onProgress, signal);
}

/**
 * Poll job until terminal state.
 * @param {Function} daFetch
 * @param {string} jobUrl
 * @param {(job: Record<string, unknown>) => void} [onProgress]
 * @returns {Promise<Record<string, unknown>>}
 */
async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {Function} daFetch
 * @param {string} jobUrl
 */
async function fetchJobDetails(daFetch, jobUrl) {
  const base = resolveAdminUrl(jobUrl).replace(/\/$/, '');
  const detailsResp = await daFetch(`${base}/details`, { method: 'GET' });
  const details = await parseJson(detailsResp);
  if (detailsResp.ok && details) return /** @type {Record<string, unknown>} */ (details);
  return null;
}

export async function pollJob(
  daFetch,
  jobUrl,
  onProgress,
  signal,
  options = {},
) {
  const terminal = new Set(['stopped', 'succeeded', 'failed', 'cancelled']);
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 2000;
  let last = null;
  let notFoundCount = 0;
  const resolvedJobUrl = resolveAdminUrl(jobUrl);

  /* eslint-disable no-await-in-loop -- job polling is intentionally sequential */
  for (let i = 0; i < 60; i += 1) {
    if (signal?.aborted) throw new DOMException('Job cancelled', 'AbortError');
    const resp = await daFetch(resolvedJobUrl, { method: 'GET' });

    if (resp.status === 404 || resp.status === 410) {
      notFoundCount += 1;
      const details = await fetchJobDetails(daFetch, resolvedJobUrl);
      if (details) return details;
      if (notFoundCount >= 2) return last || { state: 'stopped' };
      await sleep(1000);
      if (signal?.aborted) throw new DOMException('Job cancelled', 'AbortError');
      continue;
    }

    if (resp.status === 401 || resp.status === 403) {
      const data = await parseJson(resp);
      const msg = formatAdminApiError(data, resp.status)
        || `Not authorized to track this job (${resp.status})`;
      throw createApiError(msg, resp.status, data);
    }

    notFoundCount = 0;
    const data = await parseJson(resp);
    if (data) {
      last = /** @type {Record<string, unknown>} */ (data);
      if (onProgress) onProgress(last);
      const state = last.state || last.job?.state;
      if (state && terminal.has(String(state))) return last;
    }
    await sleep(pollMs);
    if (signal?.aborted) throw new DOMException('Job cancelled', 'AbortError');
  }
  /* eslint-enable no-await-in-loop */

  const details = await fetchJobDetails(daFetch, resolvedJobUrl);
  if (details) return details;
  return last || { state: 'timeout' };
}

/**
 * Map Helix job result to UI status (stopped with 0 failed = success).
 * @param {Record<string, unknown>} job
 * @returns {{ statusType: 'success'|'error'|'info', message: string }}
 */
export function resolveJobOutcome(job) {
  const state = String(job?.state || 'unknown');
  const progress = job?.progress || job?.job?.progress || {};

  const failed = Number(progress.failed ?? 0);
  const success = Number(progress.success ?? 0);
  const processed = Number(progress.processed ?? 0);
  const total = Number(progress.total ?? 0);
  const completed = success || processed || total;

  if (state === 'failed' || failed > 0) {
    const detail = extractJobFailureDetail(job);
    const base = failed > 0 ? `finished with ${failed} failed` : 'failed';
    return {
      statusType: 'error',
      message: detail ? `${base} — ${detail}` : base,
    };
  }

  if (state === 'succeeded' || (failed === 0 && completed > 0)) {
    const count = success || processed || total;
    return {
      statusType: 'success',
      message: `completed successfully${count ? ` (${count} page${count === 1 ? '' : 's'})` : ''}`,
    };
  }

  if (state === 'cancelled') {
    return { statusType: 'info', message: 'was cancelled' };
  }

  if (state === 'timeout') {
    return {
      statusType: 'info',
      message: 'timed out — check job status in DA',
    };
  }

  return { statusType: 'info', message: `finished (${state})` };
}

/**
 * Resolve job self link from bulk response.
 * @param {Record<string, unknown>} bulkResponse
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {'preview'|'live'} topic
 * @returns {string|null}
 */
export function getJobPollUrl(bulkResponse, org, site, ref, topic) {
  const { links, job } = bulkResponse || {};
  if (links && typeof links === 'object') {
    const { self } = /** @type {{ self?: string }} */ (links);
    if (self) return resolveAdminUrl(self);
  }

  if (job && typeof job === 'object') {
    const { name, topic: jobTopic } =
      /** @type {{ name?: string, topic?: string }} */ (job);
    const resolvedTopic = jobTopic || topic;
    if (name && resolvedTopic) {
      return `${adminApiBase}/job/${org}/${site}/${ref}/${resolvedTopic}/${name}`;
    }
  }

  return null;
}

/**
 * Path keys to try for GET /status/{org}/{site}/{ref}/{path segments…}
 * @param {string} helixPath
 * @returns {string[]}
 */
function helixPathToStatusPathKeys(helixPath) {
  const decoded = decodeHelixPath(helixPath);
  const norm = normalizeWebPath(decoded);
  const web = helixToWebPath(decoded);
  const webBare = web === '/' ? 'index' : web.replace(/^\//, '');
  const normBare = norm === '/' ? 'index' : norm.replace(/^\//, '');
  /** @type {string[]} */
  const ordered = [];
  const push = (key) => {
    const bare = (key || '').replace(/^\//, '');
    if (!bare) {
      if (!ordered.includes('index')) ordered.push('index');
      return;
    }
    if (!ordered.includes(bare)) ordered.push(bare);
    const htmlKey = `${bare}.html`;
    if (!bare.endsWith('.html') && !ordered.includes(htmlKey)) ordered.push(htmlKey);
  };

  // DA folder pages (…/story/index) — try full resource path before parent slug
  if (normBare.endsWith('/index') && normBare !== 'index') {
    push(normBare);
    push(normBare.slice(0, -'/index'.length));
  } else if (normBare !== 'index') {
    push(normBare);
    push(`${normBare}/index`);
  }

  if (webBare !== normBare) {
    push(webBare);
    if (webBare !== 'index' && !webBare.endsWith('/index')) push(`${webBare}/index`);
  }

  if (webBare === 'index' || normBare === 'index') push('index');
  return ordered;
}

/**
 * GET /preview|live|status/{org}/{site}/{ref}/{path…}
 * @param {'preview'|'live'|'status'} route
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string} pathKey
 * @returns {string}
 */
function buildAdminResourceUrl(route, org, site, ref, pathKey) {
  const prefix = `${adminApiBase}/${route}/${org}/${site}/${ref}`;
  const bare = (pathKey || '').replace(/^\//, '') || 'index';
  const segments = bare
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s));
  return segments.length
    ? `${prefix}/${segments.join('/')}`
    : `${prefix}/index`;
}

/**
 * @param {unknown} partition
 * @returns {number | undefined}
 */
function partitionTimestamp(partition) {
  if (!partition || typeof partition !== 'object') return undefined;
  const status = Number(/** @type {{ status?: number }} */ (partition).status);
  if (status === 404) return undefined;
  if (status && status >= 400) return undefined;
  const lm =
    /** @type {{ lastModified?: string, contentBusId?: string, url?: string }} */ (
      partition
    ).lastModified;
  if (lm) {
    const ts = Date.parse(String(lm));
    if (!Number.isNaN(ts)) return ts;
  }
  if (status === 200 || status === 304 || partition.contentBusId) {
    return Date.now();
  }
  return undefined;
}

/**
 * @param {unknown} data
 * @returns {{ previewedAt?: number, publishedAt?: number }}
 */
function parseStatusPayload(data) {
  if (!data || typeof data !== 'object') return {};
  const { preview, live } = /** @type {{
    preview?: Record<string, unknown>,
    live?: Record<string, unknown>,
  }} */ (data);
  /** @type {{ previewedAt?: number, publishedAt?: number }} */
  const entry = {};
  const previewTs = partitionTimestamp(preview);
  const liveTs = partitionTimestamp(live);
  if (previewTs) entry.previewedAt = previewTs;
  if (liveTs) entry.publishedAt = liveTs;
  return entry;
}

/**
 * @param {string[]} helixPaths
 * @returns {Map<string, string>}
 */
function buildHelixPathLookup(helixPaths) {
  const lookup = new Map();
  const link = (webPath, helix) => {
    if (!webPath && webPath !== '') return;
    const key = normalizeWebPath(webPath);
    if (!lookup.has(key)) lookup.set(key, helix);
    const bare = key.replace(/^\//, '');
    if (bare && !lookup.has(bare)) lookup.set(bare, helix);
    if (bare && !lookup.has(`/${bare}`)) lookup.set(`/${bare}`, helix);
  };
  helixPaths.forEach((helix) => {
    link(helix, helix);
    link(helixToWebPath(helix), helix);
    helixPathToStatusPathKeys(helix).forEach((pathKey) => link(pathKey, helix));
    const norm = normalizeWebPath(helix);
    if (norm.endsWith('/index')) {
      link(norm.slice(0, -'/index'.length) || '/', helix);
    }
    if (norm === '/index' || norm === '/') {
      link('/', helix);
      link('/index', helix);
      link('index', helix);
    }
    const bare = norm.replace(/^\//, '');
    if (bare) {
      link(`${bare}.md`, helix);
      link(`${bare}.html`, helix);
    }
  });
  return lookup;
}

/**
 * @param {Map<string, string>} lookup
 * @param {string} rawPath
 * @param {string[]} helixPaths
 * @returns {string | undefined}
 */
function resolveHelixForWebPath(lookup, rawPath, helixPaths) {
  if (!rawPath) return undefined;
  const candidates = [
    rawPath,
    normalizeWebPath(rawPath),
    helixToWebPath(rawPath),
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const key = normalizeWebPath(candidates[i]);
    const hit = lookup.get(key) || lookup.get(key.replace(/^\//, ''));
    if (hit) return hit;
  }
  const norm = normalizeWebPath(rawPath);
  const slug = norm.split('/').filter(Boolean).pop();
  if (!slug) return undefined;
  const matches = helixPaths.filter(
    (h) => h === norm
      || h.endsWith(`/${slug}`)
      || h.endsWith(`/${slug}/index`)
      || normalizeWebPath(h) === norm,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * @param {unknown} node
 * @param {(row: Record<string, unknown>) => void} visit
 * @param {number} [depth]
 */
function walkStatusNodes(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    node.forEach((item) => walkStatusNodes(item, visit, depth + 1));
    return;
  }
  const row = /** @type {Record<string, unknown>} */ (node);
  if (row.webPath || row.path || row.resourcePath) visit(row);
  Object.values(row).forEach((value) => {
    if (value && typeof value === 'object') walkStatusNodes(value, visit, depth + 1);
  });
}

/**
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string} helixPath
 */
/**
 * @param {Function} daFetch
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function daFetchWithRetry(daFetch, url, init) {
  let lastResp = null;
  /* eslint-disable no-await-in-loop */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      lastResp = await daFetch(url, init);
    } catch (err) {
      if (err instanceof Error && /missing ims client id/i.test(err.message)) throw err;
      if (err instanceof TypeError) throw err;
      throw err;
    }
    if (lastResp.status !== 429) return lastResp;
    await sleep(800 + attempt * 600);
  }
  /* eslint-enable no-await-in-loop */
  return lastResp;
}

/**
 * @returns {boolean}
 */
export function isHardcodeIndexTest() {
  return (
    typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('hardcodeIndex')
  );
}

/**
 * @param {string} helixPath
 * @returns {boolean}
 */
function isIndexHelixPath(helixPath) {
  const n = normalizeWebPath(helixPath);
  return n === '/' || n === '/index';
}

/**
 * User-verified API: GET admin.hlx.page/preview/{org}/{site}/{ref}/index
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 */
async function fetchHardcodedIndexStatus(daFetch, org, site, ref) {
  assertAdminContext(org, site, ref);

  const previewUrl = `${HLX_ADMIN}/preview/${org}/${site}/${ref}/index`;
  const statusUrl = `${HLX_ADMIN}/status/${org}/${site}/${ref}/index`;

  /** @type {{ previewedAt?: number, publishedAt?: number }} */
  const entry = {};

  try {
    const resp = await daFetchWithRetry(daFetch, previewUrl, { method: 'GET' });
    const data = await parseJson(resp);
    if (isHardcodeIndexTest()) {
      // eslint-disable-next-line no-console
      console.log(
        '[bulk-pp] hardcodeIndex GET preview',
        previewUrl,
        resp.status,
        data,
      );
    }
    if (resp.ok && data) {
      const parsed = parseStatusPayload(data);
      const previewPart =
        /** @type {Record<string, unknown>} */ (data).preview || data;
      entry.previewedAt = parsed.previewedAt || partitionTimestamp(previewPart);
    }
  } catch (err) {
    if (isHardcodeIndexTest()) {
      // eslint-disable-next-line no-console
      console.warn('[bulk-pp] hardcodeIndex preview failed', err);
    }
  }

  try {
    const resp = await daFetchWithRetry(daFetch, statusUrl, { method: 'GET' });
    const data = await parseJson(resp);
    if (isHardcodeIndexTest()) {
      // eslint-disable-next-line no-console
      console.log(
        '[bulk-pp] hardcodeIndex GET status',
        statusUrl,
        resp.status,
        data,
      );
    }
    if (resp.ok && data) {
      const parsed = parseStatusPayload(data);
      entry.previewedAt = entry.previewedAt || parsed.previewedAt;
      entry.publishedAt = parsed.publishedAt;
    }
  } catch (err) {
    if (isHardcodeIndexTest()) {
      // eslint-disable-next-line no-console
      console.warn('[bulk-pp] hardcodeIndex status failed', err);
    }
  }

  return entry;
}

/**
 * @param {{ previewedAt?: number, publishedAt?: number }} a
 * @param {{ previewedAt?: number, publishedAt?: number }} b
 */
function mergeStatusTimestamps(a, b) {
  return {
    previewedAt: a.previewedAt || b.previewedAt,
    publishedAt: a.publishedAt || b.publishedAt,
  };
}

/**
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string} pathKey
 */
async function fetchPathKeyStatusGet(daFetch, org, site, ref, pathKey) {
  const statusUrl = buildAdminResourceUrl('status', org, site, ref, pathKey);
  try {
    const statusResp = await daFetchWithRetry(daFetch, statusUrl, {
      method: 'GET',
    });
    const statusData = await parseJson(statusResp);
    if (statusResp.ok && statusData) return parseStatusPayload(statusData);
  } catch {
    // fall through to preview/live
  }
  return {};
}

/**
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string} pathKey
 */
async function fetchPathKeyPreviewGet(daFetch, org, site, ref, pathKey) {
  const previewUrl = buildAdminResourceUrl('preview', org, site, ref, pathKey);
  /** @type {{ previewedAt?: number, publishedAt?: number }} */
  const entry = {};
  try {
    const resp = await daFetchWithRetry(daFetch, previewUrl, { method: 'GET' });
    const data = await parseJson(resp);
    if (resp.ok && data) {
      const fromPreview = entryFromPreviewBody(data);
      entry.previewedAt = fromPreview.previewedAt;
      entry.publishedAt = fromPreview.publishedAt;
      const linked = await fetchLinkedStatusFromPreview(daFetch, data);
      return mergeStatusTimestamps(entry, linked);
    }
  } catch {
    // try live next
  }
  return entry;
}

/**
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string} pathKey
 * @param {{ previewedAt?: number, publishedAt?: number }} best
 */
async function fetchPathKeyLiveGet(daFetch, org, site, ref, pathKey, best) {
  const url = buildAdminResourceUrl('live', org, site, ref, pathKey);
  let resp;
  try {
    resp = await daFetchWithRetry(daFetch, url, { method: 'GET' });
  } catch (err) {
    if (err instanceof Error && /missing ims client id/i.test(err.message)) {
      throw new Error(
        formatAdminApiError({ message: err.message }, 0) || err.message,
      );
    }
    if (err instanceof TypeError) {
      throw new Error(
        `Network or CORS error reaching AEM Admin API. ${DA_AUTH_CONTEXT_MESSAGE}`,
      );
    }
    throw err;
  }
  const data = await parseJson(resp);

  if (resp.status === 401 || resp.status === 403) {
    const msg = formatAdminApiError(data, resp.status);
    throw new Error(msg || `Not authorized (${resp.status}).`);
  }
  if (resp.status === 429) return best;
  if (resp.status === 404 || !resp.ok) return best;

  const parsed = parseStatusPayload(data);
  return mergeStatusTimestamps(best, {
    publishedAt: parsed.publishedAt || partitionTimestamp(data),
  });
}

async function fetchSinglePagePlatformStatus(
  daFetch,
  org,
  site,
  ref,
  helixPath,
) {
  assertAdminContext(org, site, ref);

  if (isHardcodeIndexTest() && isIndexHelixPath(helixPath)) {
    return fetchHardcodedIndexStatus(daFetch, org, site, ref);
  }

  const pathKeys = helixPathToStatusPathKeys(helixPath);
  /** @type {{ previewedAt?: number, publishedAt?: number }} */
  let best = {};

  /* eslint-disable no-await-in-loop -- try path variants until one resolves */
  for (let i = 0; i < pathKeys.length; i += 1) {
    const pathKey = pathKeys[i];
    let entry = await fetchPathKeyStatusGet(daFetch, org, site, ref, pathKey);
    if (entry.previewedAt && entry.publishedAt) return entry;
    if (entry.previewedAt || entry.publishedAt) {
      if (entry.publishedAt) return entry;
      entry = await fetchPathKeyLiveGet(
        daFetch,
        org,
        site,
        ref,
        pathKey,
        entry,
      );
      if (entry.previewedAt || entry.publishedAt) return entry;
    }

    entry = mergeStatusTimestamps(
      entry,
      await fetchPathKeyPreviewGet(daFetch, org, site, ref, pathKey),
    );
    if (entry.previewedAt && entry.publishedAt) return entry;
    if (entry.previewedAt || entry.publishedAt) {
      if (entry.publishedAt) return entry;
      entry = await fetchPathKeyLiveGet(
        daFetch,
        org,
        site,
        ref,
        pathKey,
        entry,
      );
      if (entry.previewedAt || entry.publishedAt) return entry;
    } else {
      entry = await fetchPathKeyLiveGet(
        daFetch,
        org,
        site,
        ref,
        pathKey,
        entry,
      );
      if (entry.previewedAt || entry.publishedAt) return entry;
    }

    best = mergeStatusTimestamps(best, entry);
  }
  /* eslint-enable no-await-in-loop */

  return best;
}

/**
 * @param {string} path
 */
function normalizeWebPath(path) {
  if (!path) return '/';
  let p = decodeHelixPath(String(path).trim());
  if (p.endsWith('.html')) p = p.slice(0, -5);
  if (p.endsWith('.md')) p = p.slice(0, -3);
  p = p.startsWith('/') ? p : `/${p}`;
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p || '/';
}

/**
 * @param {unknown} data
 * @returns {{ previewedAt?: number, publishedAt?: number }}
 */
function entryFromPreviewBody(data) {
  if (!data || typeof data !== 'object') return {};
  const parsed = parseStatusPayload(data);
  const previewPart =
    /** @type {Record<string, unknown>} */ (data).preview || data;
  const previewTs = partitionTimestamp(previewPart);
  if (previewTs) {
    return {
      previewedAt: parsed.previewedAt || previewTs,
      publishedAt: parsed.publishedAt,
    };
  }
  if (Number(/** @type {{ status?: number }} */ (previewPart).status) === 200) {
    return {
      previewedAt: parsed.previewedAt || Date.now(),
      publishedAt: parsed.publishedAt,
    };
  }
  return parsed;
}

/**
 * Follow links.status from a preview response (same pattern as site index).
 * @param {Function} daFetch
 * @param {unknown} data
 */
async function fetchLinkedStatusFromPreview(daFetch, data) {
  if (!data || typeof data !== 'object') return {};
  const links = /** @type {{ status?: string }} */ (data).links;
  const statusUrl = links?.status;
  if (!statusUrl || typeof statusUrl !== 'string') return {};
  try {
    const resp = await daFetchWithRetry(daFetch, statusUrl, { method: 'GET' });
    const json = await parseJson(resp);
    if (resp.ok && json) return parseStatusPayload(json);
  } catch {
    // ignore
  }
  return {};
}

/**
 * @param {unknown} jobData
 * @returns {Array<Record<string, unknown>>}
 */
function extractStatusResources(jobData) {
  if (!jobData || typeof jobData !== 'object') return [];
  const root = /** @type {Record<string, unknown>} */ (jobData);
  const data = root.data && typeof root.data === 'object'
    ? /** @type {Record<string, unknown>} */ (root.data)
    : root;

  if (Array.isArray(data.resources)) return data.resources;
  if (data.resources && typeof data.resources === 'object') {
    const groups = /** @type {Record<string, unknown[]>} */ (data.resources);
    const merged = [];
    ['preview', 'live', 'edit'].forEach((key) => {
      const bucket = groups[key];
      if (!Array.isArray(bucket)) return;
      bucket.forEach((item) => {
        if (typeof item === 'string') {
          merged.push({ webPath: item, _bucket: key });
        } else if (item && typeof item === 'object') {
          merged.push({
            ...(item),
            _bucket: key,
          });
        }
      });
    });
    return merged;
  }
  return [];
}

/**
 * @param {unknown} jobData
 * @param {string[]} helixPaths
 * @returns {Record<string, { previewedAt?: number, publishedAt?: number }>}
 */
/**
 * @param {Record<string, unknown>} row
 * @returns {{ previewedAt?: number, publishedAt?: number }}
 */
function entryFromStatusRow(row) {
  const entry = parseStatusPayload(row);
  if (row.previewLastModified) {
    const ts = Date.parse(String(row.previewLastModified));
    if (!Number.isNaN(ts)) entry.previewedAt = ts;
  }
  if (row.publishLastModified || row.liveLastModified) {
    const ts = Date.parse(
      String(row.publishLastModified || row.liveLastModified),
    );
    if (!Number.isNaN(ts)) entry.publishedAt = ts;
  }
  const bucket = String(row._bucket || '');
  if (bucket === 'live' && !entry.publishedAt) {
    const livePart = row.live && typeof row.live === 'object' ? row.live : row;
    const liveTs = partitionTimestamp(livePart);
    if (liveTs) entry.publishedAt = liveTs;
  }
  if (bucket === 'preview' && !entry.previewedAt) {
    const previewPart = row.preview && typeof row.preview === 'object' ? row.preview : row;
    const previewTs = partitionTimestamp(previewPart);
    if (previewTs) entry.previewedAt = previewTs;
  }
  return entry;
}

/**
 * @param {Record<string, { previewedAt?: number, publishedAt?: number }>} result
 * @param {string} helix
 * @param {{ previewedAt?: number, publishedAt?: number }} patch
 */
function mergeEntry(result, helix, patch) {
  const prev = result[helix] || {};
  result[helix] = {
    previewedAt: patch.previewedAt || prev.previewedAt,
    publishedAt: patch.publishedAt || prev.publishedAt,
  };
}

function mapStatusJobToEntries(jobData, helixPaths) {
  /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */
  const result = {};
  helixPaths.forEach((p) => {
    result[p] = {};
  });
  const lookup = buildHelixPathLookup(helixPaths);

  const touchEntry = (webPath, bucket, item) => {
    const helix = resolveHelixForWebPath(lookup, webPath, helixPaths);
    if (!helix) return;
    let patch = {};
    if (typeof item === 'string') {
      patch = bucket === 'live'
        ? { publishedAt: Date.now() }
        : { previewedAt: Date.now() };
    } else if (item && typeof item === 'object') {
      const row = /** @type {Record<string, unknown>} */ (item);
      patch = entryFromStatusRow({ ...row, _bucket: bucket || row._bucket });
    }
    mergeEntry(result, helix, patch);
  };

  extractStatusResources(jobData).forEach((item) => {
    if (typeof item === 'string') {
      touchEntry(item, 'preview', null);
      return;
    }
    const bucket = String(item._bucket || '');
    touchEntry(
      String(item.webPath || item.path || item.resourcePath || ''),
      bucket,
      item,
    );
  });

  walkStatusNodes(jobData, (row) => {
    const path = String(row.webPath || row.path || row.resourcePath || '');
    if (!path) return;
    const bucket = String(row._bucket || '');
    if (
      row.preview
      || row.live
      || row.previewLastModified
      || row.publishLastModified
    ) {
      touchEntry(path, bucket, row);
    }
  });

  return result;
}

/**
 * @param {AbortSignal} [signal]
 */
function throwIfStatusAborted(signal) {
  if (signal?.aborted) throw new DOMException('Status check cancelled', 'AbortError');
}

/**
 * One bulk status POST + job poll for all pages in the current view.
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string[]} helixPaths
 * @param {AbortSignal} [signal]
 */
function helixPathsToStatusBulkPaths(helixPaths) {
  return dedupePaths(
    helixPaths.map((helix) => {
      const web = helixToWebPath(helix);
      if (!web || web === '/') return '/';
      return web.startsWith('/') ? web : `/${web}`;
    }),
  );
}

async function fetchBulkPlatformStatus(
  daFetch,
  org,
  site,
  ref,
  helixPaths,
  signal,
) {
  assertAdminContext(org, site, ref);
  throwIfStatusAborted(signal);
  const paths = helixPathsToStatusBulkPaths(helixPaths);
  const url = `${adminApiBase}/status/${org}/${site}/${ref}/${ADMIN_STATUS_POST_SUFFIX}`;
  const resp = await daFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paths,
      select: ['preview', 'live'],
      forceAsync: paths.length > 5,
    }),
  });
  const data = await parseJson(resp);
  if (resp.status === 401 || resp.status === 403) {
    const msg = formatAdminApiError(data, resp.status, 'status');
    throw createApiError(
      msg || `Not authorized to read page status (${resp.status}).`,
      resp.status,
      data,
    );
  }
  if (!resp.ok && resp.status !== 202) {
    const msg = formatAdminApiError(data, resp.status, 'status');
    throw createApiError(
      msg || `Status check failed (${resp.status})`,
      resp.status,
      data,
    );
  }

  const jobUrl = getJobPollUrl(data || {}, org, site, ref, 'status');
  if (!jobUrl) {
    if (data && typeof data === 'object') {
      return mapStatusJobToEntries(data, helixPaths);
    }
    return {};
  }

  let details = null;
  try {
    const detailsResp = await daFetch(`${resolveAdminUrl(jobUrl)}/details`, {
      method: 'GET',
    });
    const detailsJson = await parseJson(detailsResp);
    if (detailsResp.ok && detailsJson) details = detailsJson;
  } catch {
    // fall back to poll
  }

  if (!details) {
    details = await pollJob(daFetch, jobUrl, undefined, signal, {
      pollMs: STATUS_BULK_POLL_MS,
    });
    try {
      const detailsResp = await daFetch(`${resolveAdminUrl(jobUrl)}/details`, {
        method: 'GET',
      });
      const detailsJson = await parseJson(detailsResp);
      if (detailsResp.ok && detailsJson) details = detailsJson;
    } catch {
      // use polled job payload
    }
  }

  return mapStatusJobToEntries(details || {}, helixPaths);
}

/**
 * @param {string} folderPath
 * @returns {string}
 */
function folderPathToWildcardStatusPath(folderPath) {
  const trimmed = normalizeFolderPath(folderPath || '');
  if (!trimmed) return '/*';
  return `/${trimmed.replace(/^\/+/, '')}/*`;
}

/**
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string} folderPath
 * @param {string[]} helixPaths
 * @param {AbortSignal} [signal]
 */
async function fetchFolderWildcardPlatformStatus(
  daFetch,
  org,
  site,
  ref,
  folderPath,
  helixPaths,
  signal,
) {
  assertAdminContext(org, site, ref);
  throwIfStatusAborted(signal);
  const url = `${adminApiBase}/status/${org}/${site}/${ref}/${ADMIN_STATUS_POST_SUFFIX}`;
  const wildcardPath = folderPathToWildcardStatusPath(folderPath);
  const resp = await daFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paths: [wildcardPath],
      select: ['preview', 'live'],
      forceAsync: true,
    }),
  });
  const data = await parseJson(resp);
  if (resp.status === 401 || resp.status === 403) {
    const msg = formatAdminApiError(data, resp.status, 'status');
    throw createApiError(
      msg || `Not authorized to read page status (${resp.status}).`,
      resp.status,
      data,
    );
  }
  if (!resp.ok && resp.status !== 202) {
    const msg = formatAdminApiError(data, resp.status, 'status');
    throw createApiError(
      msg || `Status check failed (${resp.status})`,
      resp.status,
      data,
    );
  }

  const jobUrl = getJobPollUrl(data || {}, org, site, ref, 'status');
  if (!jobUrl) {
    if (data && typeof data === 'object') return mapStatusJobToEntries(data, helixPaths);
    return {};
  }

  let details = null;
  try {
    const detailsResp = await daFetch(`${resolveAdminUrl(jobUrl)}/details`, {
      method: 'GET',
    });
    const detailsJson = await parseJson(detailsResp);
    if (detailsResp.ok && detailsJson) details = detailsJson;
  } catch {
    // fall back to poll
  }

  if (!details) {
    details = await pollJob(daFetch, jobUrl, undefined, signal, {
      pollMs: STATUS_BULK_POLL_MS,
    });
    try {
      const detailsResp = await daFetch(`${resolveAdminUrl(jobUrl)}/details`, {
        method: 'GET',
      });
      const detailsJson = await parseJson(detailsResp);
      if (detailsResp.ok && detailsJson) details = detailsJson;
    } catch {
      // use polled job payload
    }
  }

  return mapStatusJobToEntries(details || {}, helixPaths);
}

/**
 * @typedef {(partial: Record<string, { previewedAt?: number, publishedAt?: number }>, checked: number, total: number) => void} StatusProgressFn
 */

/**
 * Check every path (no 25-page cap). Batched to limit rate limits.
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string[]} helixPaths
 * @param {(partial: Record<string, { previewedAt?: number, publishedAt?: number }>, done: number) => void} [onProgress]
 * @param {AbortSignal} [signal]
 */
async function fetchStatusParallel(
  daFetch,
  org,
  site,
  ref,
  helixPaths,
  onProgress,
  signal,
) {
  const unique = dedupePaths(helixPaths);
  if (unique.length === 0) return {};

  /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */
  const result = {};
  let nextIndex = 0;
  let done = 0;
  const workers = Math.min(STATUS_PARALLEL_BATCH_SIZE, unique.length);

  const worker = async () => {
    while (nextIndex < unique.length) {
      if (signal?.aborted) throw new DOMException('Status check cancelled', 'AbortError');
      const path = unique[nextIndex];
      nextIndex += 1;
      try {
        result[path] = await fetchSinglePagePlatformStatus(
          daFetch,
          org,
          site,
          ref,
          path,
        );
      } catch (err) {
        if (
          err instanceof Error
          && /authorized|too many status/i.test(err.message)
        ) throw err;
        result[path] = {};
      }
      done += 1;
      if (onProgress) onProgress({ [path]: result[path] }, done);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return result;
}

/**
 * @param {{ previewedAt?: number, publishedAt?: number }} [entry]
 */
function hasPlatformStatus(entry) {
  return Boolean(entry?.previewedAt || entry?.publishedAt);
}

/**
 * @param {Function} daFetch
 * @param {string} org
 * @param {string} site
 * @param {string} ref
 * @param {string[]} helixPaths
 * @param {StatusProgressFn} [onProgress]
 * @param {{ signal?: AbortSignal, folderPath?: string }} [options]
 */
export async function fetchPlatformStatusForPaths(
  daFetch,
  org,
  site,
  ref,
  helixPaths,
  onProgress,
  options = {},
) {
  const { signal, folderPath = '' } = options;

  const throwIfAborted = () => throwIfStatusAborted(signal);

  const unique = dedupePaths(helixPaths);
  if (unique.length === 0) return {};
  assertAdminContext(org, site, ref);
  throwIfAborted();

  if (isHardcodeIndexTest()) {
    const indexStatus = await fetchHardcodedIndexStatus(
      daFetch,
      org,
      site,
      ref,
    );
    /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */
    const result = {};
    unique.forEach((p) => {
      result[p] = isIndexHelixPath(p) ? { ...indexStatus } : {};
    });
    return result;
  }

  const useBulk = typeof window !== 'undefined'
    && (() => {
      const params = new URLSearchParams(window.location.search);
      if (params.has('noBulkStatus')) return false;
      if (unique.length < STATUS_FAST_PER_PAGE_MAX) return false;
      return (
        !params.has('noBulk')
        && (params.has('bulkStatus') || unique.length >= STATUS_FAST_PER_PAGE_MAX)
      );
    })();

  /** @type {Record<string, { previewedAt?: number, publishedAt?: number }>} */
  let result = {};
  /** @type {string[]} */
  const bulkMatched = [];

  const shouldUseFolderWildcardBulk = typeof window !== 'undefined'
    && (() => {
      const params = new URLSearchParams(window.location.search);
      if (params.has('noFolderBulkStatus')) return false;
      if (!folderPath && folderPath !== '') return false;
      return !params.has('noBulk') && !params.has('noBulkStatus');
    })();

  if (shouldUseFolderWildcardBulk) {
    try {
      throwIfAborted();
      result = await fetchFolderWildcardPlatformStatus(
        daFetch,
        org,
        site,
        ref,
        folderPath,
        unique,
        signal,
      );
      unique.forEach((p) => {
        if (hasPlatformStatus(result[p])) bulkMatched.push(p);
      });
    } catch (folderBulkErr) {
      if (new URLSearchParams(window.location.search).has('debug')) {
        // eslint-disable-next-line no-console
        console.debug(
          '[bulk-pp] folder wildcard bulk status failed',
          folderBulkErr,
        );
      }
    }
  }

  if (useBulk && bulkMatched.length === 0) {
    try {
      throwIfAborted();
      result = await fetchBulkPlatformStatus(
        daFetch,
        org,
        site,
        ref,
        unique,
        signal,
      );
      unique.forEach((p) => {
        if (hasPlatformStatus(result[p])) bulkMatched.push(p);
      });
    } catch (bulkErr) {
      if (new URLSearchParams(window.location.search).has('debug')) {
        // eslint-disable-next-line no-console
        console.debug(
          '[bulk-pp] bulk status failed',
          bulkErr,
          describeAdminEndpoints(org, site, ref, unique[0]),
        );
      }
    }
  }

  const missing = unique.filter((p) => !hasPlatformStatus(result[p]));
  const toFetch = useBulk && bulkMatched.length > 0 ? missing : unique;
  const alreadyResolved = unique.length - toFetch.length;

  const reportProgress = (doneInBatch) => {
    if (!onProgress) return;
    const checked = Math.min(alreadyResolved + doneInBatch, unique.length);
    onProgress({ ...result }, checked, unique.length);
  };

  if (useBulk && alreadyResolved > 0 && onProgress) {
    reportProgress(0);
  }

  if (toFetch.length > 0) {
    const filled = await fetchStatusParallel(
      daFetch,
      org,
      site,
      ref,
      toFetch,
      (partial, done) => {
        Object.entries(partial).forEach(([path, entry]) => {
          if (hasPlatformStatus(entry)) result[path] = entry;
        });
        reportProgress(done);
      },
      signal,
    );
    toFetch.forEach((p) => {
      const entry = filled[p];
      if (hasPlatformStatus(entry)) result[p] = entry;
      else if (!result[p]) result[p] = {};
    });
  }

  unique.forEach((p) => {
    if (!result[p]) result[p] = {};
  });

  if (onProgress) onProgress({ ...result }, unique.length, unique.length);
  return result;
}
