# Content Deployment Hub

Enterprise workspace for **AEM Edge Delivery** (Document Authoring). Browse site content, check preview and live deployment status, run bulk preview/publish/removal operations, and open Document Authoring or environment URLs from one place.

| | |
|---|---|
| **Display name** | Content Deployment Hub |
| **Technical slug** | `content-deployment-hub` |
| **Entry points** | `tools/content-deployment-hub/index.html` · `tools/content-deployment-hub.html` |
| **Requires** | Document Authoring (DA) — Adobe IMS authentication via DA SDK |

---

## Table of contents

1. [Setup](#setup)
2. [Getting started](#getting-started)
3. [Interface overview](#interface-overview)
4. [Workspace — browse and fetch](#workspace--browse-and-fetch)
5. [Site content — Browse tab](#site-content--browse-tab)
6. [Deployment status](#deployment-status)
7. [Page selection](#page-selection)
8. [Bulk deploy actions](#bulk-deploy-actions)
9. [Bulk removal and delete](#bulk-removal-and-delete)
10. [Open URLs and Document Authoring](#open-urls-and-document-authoring)
11. [Urls tab](#urls-tab)
12. [Modals and confirmations](#modals-and-confirmations)
13. [Cancel and stop behavior](#cancel-and-stop-behavior)
14. [Per-row actions](#per-row-actions)
15. [Status legend and filters](#status-legend-and-filters)
16. [URL parameters and debug](#url-parameters-and-debug)
17. [Technical reference](#technical-reference)
18. [Limitations and troubleshooting](#limitations-and-troubleshooting)
19. [Development](#development)

---

## Setup

Follow these steps to deploy Content Deployment Hub and register it in Document Authoring.

### 1. Add the tool code under `tools/`

The full app lives in this repository under `tools/content-deployment-hub/`:

```
tools/
├── content-deployment-hub.html          # Alternate entry (optional)
└── content-deployment-hub/
    ├── index.html                       # Primary entry
    ├── content-deployment-hub.js
    ├── content-deployment-hub.css
    └── lib/                             # API, UI, state, paths, modals, …
```

If your DA site uses a different Git repository, copy the entire `tools/content-deployment-hub/` folder (and optionally `tools/content-deployment-hub.html`) into that repo so the code is available at `tools/content-deployment-hub` on the branch DA serves.

### 2. Connect AEM Code Sync

1. Add the [AEM Code Sync GitHub App](https://github.com/apps/aem-code-sync) to the repository that backs your DA site.
2. Push your branch to GitHub. Code Sync publishes the `tools/` folder to your preview environment.
3. Confirm the app loads at:
   - `https://main--{repo}--{owner}.aem.page/tools/content-deployment-hub`
   - or your feature preview URL on a branch.

### 3. Register the app in DA site config

1. Open your site configuration: [https://da.live/config#/{org}/{site}/](https://da.live/config#/{org}/{site}/)  
   Example: `https://da.live/config#/rusmeenkhan1/abbvie/`
2. Keep the existing **data** tab (site key/value settings).
3. Create a new tab named **apps**.
4. Add these column headers on the **apps** tab:

   | title | path | format | icon | experience | ref | description |

5. Add one row for Content Deployment Hub:

   | Column | Value |
   |--------|-------|
   | **title** | `Content Deployment Hub` |
   | **path** | `https://da.live/app/{org}/{site}/tools/content-deployment-hub` |
   | **format** | *(leave empty)* |
   | **icon** | *(leave empty, or URL to a 1:1 app icon)* |
   | **experience** | *(leave empty)* |
   | **ref** | *(leave empty unless pinning a branch)* |
   | **description** | `Browse pages, check deployment status, and run bulk preview, publish, and removal operations.` |

   Example path for org `rusmeenkhan1` and site `abbvie`:

   `https://da.live/app/rusmeenkhan1/abbvie/tools/content-deployment-hub`

6. Save the config sheet and **Publish** so the apps tab is active.

A reference multi-sheet config (with **data** and **apps** tabs) is in [`site-config/config.example.json`](site-config/config.example.json). Replace `rusmeenkhan1` / `abbvie` with your org and site if you import or copy values from that file.

### 4. Migrate from `bulk-preview-publish`

If you previously registered the old slug, update the **apps** tab row:

| Before | After |
|--------|-------|
| `tools/bulk-preview-publish` | `tools/content-deployment-hub` |
| Title `Bulk-preview` | `Content Deployment Hub` |

Remove or replace any row whose path ends in `/tools/bulk-preview-publish`.

### 5. Verify and launch

1. Open the DA Apps dashboard: [https://da.live/apps#/{org}/{site}/](https://da.live/apps#/{org}/{site}/)
2. Confirm **Content Deployment Hub** appears as a card.
3. Open the app directly: `https://da.live/app/{org}/{site}/tools/content-deployment-hub`
4. After code changes, hard refresh in DA (`Cmd+Shift+R` / `Ctrl+Shift+R`) to bypass cached assets.

The tool must be opened from Document Authoring (or via the DA Apps menu). It cannot authenticate when opened as a standalone `.aem.page` / `.aem.live` URL.

---

## Getting started

### How to open the tool

1. Sign in to **Document Authoring** at [https://da.live](https://da.live).
2. Open your site app: `https://da.live/app/{org}/{site}/…`
3. Launch **Content Deployment Hub** from the DA Apps menu (see [Setup](#setup) to register the app).

The tool **cannot authenticate** when opened directly on `.aem.page` / `.aem.live` preview URLs or as a local file. It needs the DA SDK (`https://da.live/nx/utils/sdk.js`), which provides `daFetch` with Bearer tokens for AEM Admin APIs.

### First load

- Shows **Loading Content Deployment Hub…**
- Resolves **org**, **site**, and **ref** (branch) from the DA app URL
- Auto-runs **Fetch** at the site root (or at `?path=` / `?ref=` if present in the URL)
- On failure: **Content Deployment Hub failed to start** — hard refresh (`Cmd+Shift+R` / `Ctrl+Shift+R`) after deploy

### Capability pills (header)

| Pill | What it covers |
|------|----------------|
| Deployment status | Preview/publish timestamps and status dots |
| Bulk preview & publish | AEM Admin preview and live jobs |
| Unpreview & unpublish | Remove preview/live deployments |
| Delete from DA | Full removal pipeline including source delete |
| Open DA & URLs | DA edit links, `.aem.page`, `.aem.live` |

---

## Interface overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: title, description, org / site / ref badges            │
├─────────────────────────────────────────────────────────────────┤
│  Workspace                                                      │
│    Jump to path · Pages to show · Fetch · [status checkbox]     │
├─────────────────────────────────────────────────────────────────┤
│  Site content                                                   │
│    [ Browse ] [ Urls ]                                          │
│    Folders (breadcrumb, search, list)                           │
│    Pages (stats, filters, search, toolbar, list)                  │
└─────────────────────────────────────────────────────────────────┘
```

### Header

| Element | Content |
|---------|---------|
| Eyebrow | Adobe Experience Manager · Edge Delivery |
| Title | **Content Deployment Hub** |
| Description | Browse pages, check deployment status, and run bulk preview, publish, and removal operations. |
| Badges | Current **org**, **site**, and **ref** (branch) |

---

## Workspace — browse and fetch

Controls at the top of the app for loading content.

| Control | ID | Purpose |
|---------|-----|---------|
| **Jump to path** | `#bulk-pp-path` | Enter a folder path (e.g. `/who-we-are`) or leave empty for site root. Press **Enter** or click **Fetch**. |
| **Pages to show** | `#bulk-pp-depth` | **This folder** — pages in the current folder only. **All subfolders** — recursive page list under the folder. |
| **Fetch** | `#bulk-pp-fetch-btn` | Loads folders and pages for the current path and scope. Label becomes **Fetching…** while loading. |
| **Load preview & publish status on Fetch** | `#bulk-pp-fetch-status` | When checked, deployment status is fetched automatically after content loads. |

### Fetch behavior

- Normalizes paths (app route `tools/content-deployment-hub` is treated as site root)
- Syncs browser URL: `?path=` for folder, `?ref=` when branch is not `main`
- **Fetch** is blocked while a status check is in progress
- Changing folder via navigation cancels an in-flight status check (no user message)
- A fresh **Fetch** (not navigation) clears page selection

### Tree scope + status warning

If **All subfolders** is selected and the status checkbox is on, a confirmation appears:

- **Title:** Load status for all subfolders?
- **Body:** Warns that large sites can take several minutes; you can cancel anytime.
- **Continue** / **Cancel**

---

## Site content — Browse tab

The **Browse** tab is the main working area: folders, pages, filters, and the action toolbar.

### Folders section

Shown when the current location has subfolders or you are inside a subfolder.

| Feature | Details |
|---------|---------|
| **Breadcrumb** | **Back to root** plus clickable path segments. Current segment is plain text. Disabled while status is loading. |
| **Find a folder** | `#bulk-pp-folder-search` — minimum **3 characters** to filter by folder name. **Escape** clears search. |
| **Folder list** | Click a folder name to navigate deeper and re-fetch content. |

**Empty states**

- Type at least 3 characters to search.
- No folders match this search.
- No folders in this location.

### Pages section

| Feature | Details |
|---------|---------|
| **Page count** | Shows total pages, or **X of Y** when search/filter is active |
| **Deployment stats bar** | KPI cards after status is loaded (see [Deployment status](#deployment-status)) |
| **Fetch Deployment status** | `#bulk-pp-check-status` — standalone status fetch when pages are loaded but status is not |
| **Filter pages** | `#bulk-pp-page-filter` — requires status (see [Status legend and filters](#status-legend-and-filters)) |
| **Find a page** | `#bulk-pp-page-search` — minimum **3 characters**; matches name, path, and title |
| **Toolbar** | Selection and bulk actions (see below) |
| **Page list** | Checkboxes, path labels, optional preview/publish dates, **DA** button, status dot |

**Empty states**

- No pages in this scope.
- No pages match this search.
- No pages match this filter.
- No folders or pages in this location.

---

## Deployment status

Deployment status answers: *Has this page been previewed on `.aem.page`? Published on `.aem.live`?*

### How to load status

1. Check **Load preview & publish status on Fetch** before **Fetch**, or
2. Click **Fetch Deployment status** after pages are listed.

### Status fetch modal

| Phase | Title | Cancel button |
|-------|-------|---------------|
| In progress | **Fetching deployment status** | **Cancel Fetching** |
| Complete | **Status check complete** / **Deployment status ready** | **Close** |
| Stopped | **Status check stopped** / **Check stopped** | **Close** |
| Error | **Status check failed** / **Could not load status** | **Close** |

Progress shows **N of M pages checked (P%)** with a runtime ETA.

### Completion breakdown (modal + stats bar)

| Stat | Label |
|------|-------|
| Live | **Published** |
| Preview only | **Preview only** |
| None | **neither previewed nor published** |
| Total | **Pages in view** / **Total in view** |

### Classification rules

| Condition | Status | Dot color | Legend label |
|-----------|--------|-----------|--------------|
| `publishedAt` present | Published | Green `#2d8a4e` | **Published** |
| Only `previewedAt` | Preview only | Amber `#c9940a` | **Preview only** |
| Neither timestamp | Untouched | Red `#c9252d` | **Not previewed** |

Row tooltips use: *Published*, *only previewed*, *not previewed*.

### Before status is loaded

- Grey/pending dots on rows
- Hint: *Preview/publish status not loaded. Fetch usually takes ~… for N pages.*
- Filters locked — options show *(requires status)*

### After a successful status run

- The **Load preview & publish status on Fetch** checkbox auto-unchecks
- `statusFetched` is true; filters unlock
- Partial results are kept if you cancel mid-fetch

### API behavior (summary)

- Pages checked in parallel batches of **10**, **120 ms** pause between batches
- For **≥ 3 pages**, bulk status API is used unless disabled via URL flags
- Per-page fallback when bulk mapping misses a path
- Rate limit (**429**): *Too many status requests — wait a moment and click Refresh.*

---

## Page selection

| Control | ID | Behavior |
|---------|-----|----------|
| **Select all** | `#bulk-pp-select-all` | Selects all **currently visible** pages (respects search/filter) |
| **Clear** | `#bulk-pp-select-none` | Clears all selection |
| Row checkbox | `.bulk-pp-page-cb` | Toggle individual pages |

### Selection pill (`#bulk-pp-selection-pill`)

Examples:

- `No pages selected · N in list`
- `N of M selected`
- `N selected · X of Y shown`

### Selection persistence

- **Folder navigation:** selection kept for paths that still exist in the new page list
- **New Fetch** (same or different path): selection cleared
- Bulk actions only affect paths in the **current loaded page list**

---

## Bulk deploy actions

Toolbar group: **Deploy selected**

| Button | ID | Color | Confirmation |
|--------|-----|-------|--------------|
| **Preview selected** | `#bulk-pp-preview-btn` | Amber | None — runs immediately |
| **Publish selected** | `#bulk-pp-publish-btn` | Green | **Publish to production?** → **Publish to production** |

### Preview

- POST to AEM Admin `preview/{org}/{site}/{ref}/*`
- Job modal: **Running bulk preview on N pages**
- Cancel: **Cancel job**
- On success: refreshes status for affected paths; URLs stored for **Urls** tab

### Publish

- POST to AEM Admin `live/{org}/{site}/{ref}/*`
- Confirmation warns that `.aem.live` production content will update
- Job modal: **Publishing N pages to production**
- Uses async job mode when **> 5 pages**

### Disabled when

- No pages selected
- Content or status loading
- A bulk job modal is open (`loading` / `isJobModalOpen()`)

### Job completion

| Outcome | Modal title | Extra action |
|---------|-------------|--------------|
| Preview success | **Preview complete** | **View URLs** |
| Publish success | **Publish complete** | **View URLs** |
| Failure | **Preview failed** / **Publish failed** | **Close** only |
| User stopped tracking | **Job stopped on screen** | **Close** |

---

## Bulk removal and delete

Toolbar group: **Remove selected**

All destructive actions use a **two-step confirmation**:

1. **Keyword step** — type `unpreview`, `unpublish`, or `delete` exactly
2. **Final step** — *This cannot be undone* with a danger confirm button

| Button | ID | Keyword | Final confirm |
|--------|-----|---------|---------------|
| **Unpreview selected** | `#bulk-pp-unpreview-btn` | `unpreview` | **Yes, remove preview** |
| **Unpublish selected** | `#bulk-pp-unpublish-btn` | `unpublish` | **Yes, unpublish** |
| **Delete selected from DA** | `#bulk-pp-delete-btn` | `delete` | **Yes, delete permanently** |

### Unpreview

- Removes preview deployments from `.aem.page`
- Job modal: **Removing preview for N pages** — **Cancel unpreview**

### Unpublish

- Removes live deployments from `.aem.live`
- Job modal: **Unpublishing N pages from production** — **Cancel unpublish**

### Delete from DA (3-step pipeline)

Permanent removal. Runs in order:

| Step | Label | Action |
|------|-------|--------|
| 1 | Step 1 of 3 · Unpreview | Bulk preview removal job |
| 2 | Step 2 of 3 · Unpublish | Bulk live removal job |
| 3 | Step 3 of 3 · Delete from DA | Sequential `DELETE` on `admin.da.live/source/…` |

- Job modal: **Deleting N pages from Document Authoring** — **Cancel delete**
- Successfully deleted pages are removed from the UI list and selection
- **Urls** tab is not updated for destructive operations

---

## Open URLs and Document Authoring

Toolbar group: **Open selected** (hidden when nothing is selected)

| Button | ID | Opens |
|--------|-----|-------|
| **Open DA URL for selected** | `#bulk-pp-open-selected-da` | DA edit URLs |
| **Open preview URL for selected** | `#bulk-pp-open-selected-preview` | `{ref}--{site}--{org}.aem.page` |
| **Open publish URL for selected** | `#bulk-pp-open-selected-live` | `{ref}--{site}--{org}.aem.live` |

### Open confirmation

**Open URLs in new tabs?**

- **Open N tab(s)** / **Cancel**
- Warning at ≥ 5 tabs (browser limits)
- Stronger warning at ≥ 20 tabs (popup blockers)

### Popup blocked

If the browser blocks tabs:

> Your browser blocked new tabs. Allow pop-ups for this site, or use Copy URLs on the Urls tab.

Embedded DA may treat some `window.open` failures differently; use **Copy URLs** as a fallback.

---

## Urls tab

Switch to **Urls** after a successful **Preview** or **Publish** job.

| Feature | Details |
|---------|---------|
| Section title | **Preview (.aem.page)** or **Published (.aem.live)** |
| Host line | Environment hostname pattern |
| URL list | Clickable links (`target="_blank"`) |
| **Copy URLs** | Copies all URLs (newline-separated); brief **Copied** / **Copy failed** feedback |
| **Open all URLs (N)** | Opens every URL with the same tab confirmation flow |
| Footer | `N page(s) · completed {datetime}` |

**Empty state:** *Run Preview or Publish on selected pages to see URLs from that operation here.*

**View URLs** on the job-complete modal switches to this tab (not shown for unpreview/unpublish/delete).

---

## Modals and confirmations

### Standard confirm modal

Used for tree scope, open tabs, publish, and destructive final step.

- **Escape** or backdrop click → cancel
- Warning variant shows **!** icon

### Keyword destructive modal (step 1)

| Action | Title |
|--------|-------|
| Unpreview | Remove preview for selected pages? |
| Unpublish | Unpublish selected pages from production? |
| Delete | Delete selected pages from Document Authoring? |

- Input: **Type {keyword} to continue**
- **Continue to confirmation** disabled until keyword matches (case-insensitive)
- Hint: *This is a destructive action. You will be asked to confirm once more before anything runs.*

### Progress modals

Shared layout: title, cancel/stop button, intro text, progress bar, ETA line.

**Job titles by topic**

| Topic | Title |
|-------|-------|
| preview | Running bulk preview on N pages |
| live | Publishing N pages to production |
| unpreview | Removing preview for N pages |
| unpublish | Unpublishing N pages from production |
| delete | Deleting N pages from Document Authoring |

---

## Cancel and stop behavior

> **Important:** Cancel / Stop controls **client-side tracking only**. Work already accepted by AEM Admin or DA may continue on the server.

### Cancel Fetching (status)

- Aborts in-flight status requests via `AbortController`
- **Partial results kept** if any pages were already checked
- Message examples:
  - *Status check stopped · N of M pages checked (partial results kept)*
  - *Status check cancelled before any pages were checked*

### Cancel job / unpreview / unpublish / delete

- Stops UI polling and closes tracking
- Server job may still run to completion
- Modal explains that work already started may continue

### Navigation during status

- Changing folders cancels status silently and re-fetches

---

## Per-row actions

Each page row includes:

| Element | Behavior |
|---------|----------|
| **Checkbox** | Add/remove from selection |
| **Label** (relative path) | Clicking focuses the checkbox |
| **DA** | Open single page in Document Authoring |
| **Status dot** | Visual indicator; `aria-label` from status |

### DA button rules

| Selection count | DA button |
|-----------------|-----------|
| 0 or 2+ | Disabled when 2+ selected — use **Open DA URL for selected** |
| 1 | Opens `https://da.live/edit?ref=…#/{org}/{site}/{path}` |

Tooltip when disabled (multi-select): *Use "Open DA URL for selected" in the toolbar when multiple pages are selected*

---

## Status legend and filters

### Legend (beside filter)

| Dot | Label |
|-----|-------|
| Red | Not previewed |
| Amber | Preview only |
| Green | Published |

### Filter pages (`#bulk-pp-page-filter`)

| Value | Label |
|-------|-------|
| `all` | All pages |
| `never-previewed` | Never previewed |
| `never-published` | Never published |
| `recent-preview` | Recently previewed |
| `recent-publish` | Recently published |
| `oldest-preview` | Oldest previewed |
| `oldest-publish` | Oldest published |

**Notes**

- Locked until status is fetched: *Fetch Deployment status to unlock filters*
- After unlock: *Folder scope only · resets on navigation*
- Date-based filters sort by `previewedAt` / `publishedAt`

---

## URL parameters and debug

| Parameter | Effect |
|-----------|--------|
| `ref` | Branch override (default from DA context, usually `main`) |
| `path` | Initial folder path |
| `debug` | Log bulk status failures; show job JSON in error UI |
| `hardcodeIndex` | Test mode: only index page gets real status |
| `bulkStatus` | Force bulk status API |
| `noBulk` / `noBulkStatus` | Disable bulk status API |

Example: `?path=/who-we-are&ref=feature-branch`

---

## Technical reference

### Source layout

```
site-config/
└── config.example.json         # Reference DA site config (data + apps tabs)

tools/
├── content-deployment-hub.html   # Alternate entry
└── content-deployment-hub/
    ├── index.html              # Primary entry
    ├── content-deployment-hub.js
    ├── content-deployment-hub.css
    └── lib/
    ├── api.js              # DA list, bulk jobs, status, delete
    ├── modal.js            # Confirm & keyword modals
    ├── progress-modal.js   # Status & job progress UI
    ├── search-ui.js        # Search fields & row patches
    ├── page-history.js     # Status classification & filters
    ├── paths.js            # Path normalization & DA delete paths
    ├── urls.js             # Preview/live/DA URL builders
    ├── state.js            # App state factory & search helpers
    ├── status-estimate.js  # ETA formatting
    ├── dom.js              # DOM helpers
    └── ui-utils.js         # Clipboard, button feedback
```

### SDK and authentication

- Dynamic import: `https://da.live/nx/utils/sdk.js` (8 s timeout)
- `wrapDaFetch()` passes through SDK fetch for Admin API calls
- Without SDK: *Open Content Deployment Hub from Document Authoring (https://da.live → Apps).*

### API hosts

| Host | Usage |
|------|-------|
| `https://admin.da.live` | List folders/pages, delete source documents |
| `https://admin.hlx.page` | Preview, live, status, and job polling |

### What counts as a “page”

- Document entries (`index`, section pages, etc.)
- **Excluded:** data/config files (`metadata`, `json`, spreadsheets, etc.)
- Homepage paths normalize `/index` ↔ `/`

### Job polling

- Up to **60** polls × **2 s** interval
- Terminal states: `stopped`, `succeeded`, `failed`, `cancelled`, `timeout`
- Timeout message: *timed out — check job status in DA*
- Async forced when **> 5 paths** or delete operations

### Status refresh after tool jobs

After preview, publish, or destructive jobs initiated by this tool, status is refreshed for affected paths via `fetchPlatformStatusForPaths`. Status does **not** auto-refresh when preview/publish happens outside this tool (e.g. directly in DA).

---

## Limitations and troubleshooting

| Issue | Cause / mitigation |
|-------|-------------------|
| Tool won’t start | Open from DA, not standalone preview URL. Hard refresh after deploy. |
| Auth errors (401/403) | Sign in to DA with Adobe IMS. |
| Missing IMS client ID | Preview URLs cannot authenticate — use DA. |
| Buttons disabled | Wait for fetch/status/job to finish; select at least one page. |
| DA row button disabled | Select only one page, or use toolbar **Open DA URL for selected**. |
| Popup blocker | Allow pop-ups; use **Copy URLs** on Urls tab. |
| Status slow on large trees | Use **This folder** scope; cancel with **Cancel Fetching**; partial results kept. |
| 429 rate limit | Wait and retry **Fetch Deployment status**. |
| Stop didn’t undo work | Expected — server jobs continue; modal explains this. |
| Delete partial failure | Per-path errors reported (up to 3 samples in UI). |
| Urls tab empty after delete | Urls tab only reflects last preview/publish job. |
| External DA preview/publish | Status won’t update until you fetch again manually. |

### Boot and content errors

| Message | Meaning |
|---------|---------|
| Content Deployment Hub failed to start | JS init error — check console, hard refresh |
| Could not load deployment status from AEM. | Status API failure — see `statusError` detail |
| No folders or pages in this location. | Empty folder or invalid path |
| Fetching content… | Content list in progress |

### Deploy note

After pushing code changes, users must hard refresh the DA tool URL (`Cmd+Shift+R` / `Ctrl+Shift+R`) to bypass cached assets.

---

## Quick workflow reference

### Preview several pages

1. **Jump to path** → set scope → **Fetch**
2. Optional: enable status checkbox or **Fetch Deployment status**
3. **Select all** or pick checkboxes
4. **Preview selected**
5. **View URLs** or open **Urls** tab

### Publish to production

1. Select pages → **Publish selected**
2. Confirm **Publish to production**
3. Wait for job modal → **View URLs** for live links

### Remove preview only

1. Select pages → **Unpreview selected**
2. Type `unpreview` → **Yes, remove preview**

### Fully delete from DA

1. Select pages → **Delete selected from DA**
2. Type `delete` → **Yes, delete permanently**
3. Monitor 3-step progress (unpreview → unpublish → DA source delete)

---

## Development

### Environments

- Preview: `https://main--{repo}--{owner}.aem.page/`
- Live: `https://main--{repo}--{owner}.aem.live/`

### Installation

```sh
npm i
```

### Linting

```sh
npm run lint
```

### Local development

See [Setup](#setup) for Code Sync and DA site config. For local site work:

1. Install the [AEM CLI](https://github.com/adobe/helix-cli): `npm install -g @adobe/aem-cli`
2. Start AEM Proxy: `aem up` (opens your browser at `http://localhost:3000`)
3. Open the repository in your IDE and start coding

Content Deployment Hub itself is tested inside DA (`https://da.live/app/{org}/{site}/tools/content-deployment-hub`), not via `localhost:3000`.

### AEM Edge Delivery documentation

- [Developer Tutorial](https://www.aem.live/developer/tutorial)
- [The Anatomy of a Project](https://www.aem.live/developer/anatomy-of-a-project)
- [Web Performance](https://www.aem.live/developer/keeping-it-100)
- [Markup, Sections, Blocks, and Auto Blocking](https://www.aem.live/developer/markup-sections-blocks)
