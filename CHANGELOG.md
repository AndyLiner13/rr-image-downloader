# Changelog

All notable changes to this fork are documented in this file.

This fork lives at [AndyLiner13/rr-image-downloader](https://github.com/AndyLiner13/rr-image-downloader)
and was branched from the upstream
[Winston-Saarloos/rr-image-downloader](https://github.com/Winston-Saarloos/rr-image-downloader)
project at tag **v4.0.7**. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Scope note.** The fork's git history begins with a single squashed commit
> (_"Initial commit: RR Image Downloader with custom changes"_), so the
> customizations are not visible as individual commits. The list below was
> reconstructed by diffing the fork against the upstream **v4.0.7** tag
> (`git diff v4.0.7 main` — **17 files changed, +2,578 / −528 lines**).

## [Unreleased]

### Added

#### Incremental SQLite capture store (room photo overhaul)

- **New `RoomDatabase` storage layer** (`src/main/services/storage/room-database.ts`)
  backed by the Node built-in **`node:sqlite`** module (`DatabaseSync`) — no
  native addon, no ABI rebuild. Each room captures into a `capture.sqlite`
  database (WAL mode, `synchronous=NORMAL`, `busy_timeout=5000`) with tables for
  photos, accounts, rooms, events, and image comments, plus indexed columns for
  sorting/searching and a verbatim `data` JSON blob per record for byte-identical
  export.
- **Incremental capture.** `downloadRoomPhotoBatch` now writes each batch as a
  small `upsert` into SQLite instead of repeatedly loading and rewriting the
  entire accumulating `*_photos.json`. The familiar JSON files are exported once,
  at the end of a completed capture, via `exportRoomJsonFromDatabase` — output is
  byte-identical to the previous behavior (`normalizePhotos` blobs reproduce the
  exact same fields; `JSON.stringify` drops the `undefined` keys, matching the
  real saved files).
- **`migrateRoomJsonIntoDatabase`** transparently imports any pre-existing
  per-room JSON into the new database on first capture, so existing room folders
  keep working.

#### SQLite-backed room photo viewer paging

- **The room photo viewer now pages directly from `capture.sqlite`** instead of
  reading the entire `*_photos.json` into main-process memory on every page. The
  `load-room-photos` IPC handler is **DB-primary**: when a room's
  `capture.sqlite` exists it serves each page via `RoomDatabase.getPhotosPage`
  (filtered to downloaded photos), and only falls back to the legacy JSON scan
  for rooms with no database. This makes the viewer responsive on rooms with
  tens of thousands of images and lets you browse a room **while it is still
  being captured** (the JSON export does not exist until capture finishes).
- **`RoomDatabase` query extensions** to preserve the viewer's full behavior on
  the DB path: `getPhotosPage` now supports a `favoriteIds` filter (favorites-only
  view) and returns each photo's stored `local_file_path`; the new
  `getPhotoIndex` resolves an anchor photo's position within the sorted/filtered
  set so "keep my scroll position while new photos stream in" (`anchorPhotoId` /
  `preferLatest`) works without loading the whole room.

### Changed

- **Electron 28 → 38** and **electron-builder 24 → 26**; `@types/node` aligned to
  `^22.18` to match Electron 38's Node 22 runtime. This is required because
  `node:sqlite` does not exist in Electron 28's Node 18 runtime — the packaged app
  would otherwise crash on first capture. Verified empirically that
  `require('node:sqlite')` loads and round-trips a query inside the Electron 38
  (Node 22.22) runtime.

### Fixed

- **Newest-first re-captures now re-scan the feed head.** The room-photo cursor's
  head-insertion check was unreachable dead code: the guards were mutually
  exclusive (`isFreshNewestFirstRun` required `savedNextSkip <= 0` while the
  head-check required `savedNextSkip > 0`), so a newest-first re-capture with a
  saved cursor resumed deep pagination and **silently missed brand-new photos at
  the top of the feed**. Reworked the cursor logic around a single
  `isNewestFirstAutoRun` predicate: default-sort auto runs always restart at the
  head, detect newly-inserted photos, then jump past the previously-scanned
  region; non-default sorts resume from their own saved cursor. (This was a
  pre-existing bug, not introduced by the SQLite work — confirmed via `git diff`.)

## [4.0.8] - 2026-06-05

This is the first release published from the fork. Everything below is new
relative to the upstream **v4.0.7** baseline.

### Added

#### Room Photos — bulk download from your rooms

- **`myrooms.json` manifest support.** The app can load a list of your rooms
  from a `myrooms.json` manifest and present them for selection instead of
  forcing you to look up each room by hand.
  - New IPC + service plumbing: `loadMyRoomsManifest()`,
    `selectMyRoomsJson()` (native file picker), plus the
    `getMyRoomsCandidatePaths()`, `resolveMyRoomsManifestPath()`, and
    `parseMyRoomsManifest()` helpers in the main process.
  - New `MyRoomsManifestResult` shared type (`{ sourcePath, rooms }`).
- **Add rooms manually** by name (`^RoomName`) or by **room ID**.
  - New `lookupRoomById(roomId, token?)` service method and the
    `lookupRoomById` / `select-my-rooms-json` IPC handlers.
  - `downloadRoomPhotoBatch` now accepts `roomName?`, `roomId?`, **or** a
    full `room` object so rooms can be queued from any of those sources.
- **Multi-room download queue with detailed progress.** A new
  `RoomPhotoQueueProgress` progress shape reports queue-wide state:
  `totalRooms`, `roomsCompleted`, `currentRoomIndex/Name/Id`,
  `batchesCompleted`, the current batch's fetched/current/total/progress,
  `photosDiscovered`, `newDownloads`, `alreadyDownloaded`, `failedDownloads`,
  and `hasMoreForCurrentRoom`.
- **Resumable, batched room scans.** `downloadRoomPhotoBatch` gained
  `startSkip` and `batchPages` parameters so large room photo histories are
  fetched in resumable batches (cursor / inferred-skip) instead of restarting
  from `skip=0` every time.

#### Paginated room photo viewer

- **`loadRoomPhotos` is now fully paginated** and returns a new
  `PhotoPageResult` (`{ photos, total, offset, limit }`) instead of a flat
  array. It accepts:
  - `offset` / `limit` — page windowing (100 thumbnails per page).
  - `sortBy` — `oldest-to-newest` (default), `newest-to-oldest`,
    `most-cheered`, or `most-comments`.
  - `searchQuery` — filter photos within a room.
  - `favoriteIds` — surface favorited photos.
  - `anchorPhotoId` / `anchorIndexInPage` / `preferLatest` — keep your place
    (page anchoring) while photos stream in during a live download.
- Reworked **`PhotoViewer`** and **`PhotoGrid`** components with paged
  navigation controls (First / Previous 100 / Next 100 / Last) and the new
  default **Oldest → Newest** sort order.

#### UI

- Expanded **`ProgressDisplay`** to render the new room-photo queue progress
  (per-room and per-batch detail).
- Reworked **`DownloadPanel`** and **`App`** with the room-selection workflow,
  collapsible **Download Progress** and **Room photo** panels, and the
  manifest/manual-add controls.

#### Packaging & distribution

- **Self-contained Windows installer.** Releases now ship an NSIS installer
  (`RR-Image-Downloader-Setup-4.0.8.exe`, ~79 MB) that bundles the entire
  Electron runtime — `ffmpeg.dll`, the `.pak` resources, `locales/`, and
  `app.asar` — and installs to a folder of the user's choice (not one-click;
  the install directory can be changed).
- Added `scripts/publish-win-unpacked-to-root.js` and the corresponding
  `build:win:dir` / `publish:root` build steps.
- Added an `LICENSE.electron.txt` and a project `.gitignore`.

### Changed

- Bumped the application version from `4.0.7` to `4.0.8`.
- Significantly expanded the RecNet service, preload bridge, and shared
  `electron-api.d.ts` surface to expose the new room-photo, manifest, and
  pagination APIs.

### Fixed

- **`ffmpeg.dll was not found` on other machines.** The previous distribution
  uploaded a bare, loose `.exe` from an unpacked (`--dir`) build, which only ran
  on a machine that already had its sibling DLLs next to it. The new installer
  lays down every runtime dependency, so the app runs on any Windows computer
  rather than only the build machine.

### Documentation

- **README overhaul** (+282 lines, restructured). Added focused sections:
  Current Highlights, Using the App, Room Photos, Image Preview, Data Locations,
  Token Notes, Troubleshooting, Development Setup, Building, and Screenshots.
  - Documented the Room Photos workflows (manifest loading, selecting rooms,
    adding rooms by `^RoomName` or room ID).
  - Explained the room-download resume behavior (cursor / inferred-skip).
  - Documented the paged image preview (100 thumbnails per page;
    First / Previous 100 / Next 100 / Last; default Oldest → Newest; page
    anchoring during live downloads).
  - Expanded the data-location reference (per-account photos/feed/profile-history
    folders, room and event photo folders, and the associated metadata JSON).
  - Added step-by-step access-token instructions and a broader troubleshooting
    list, plus the new build scripts.

### Distribution notes

- The installer is **unsigned** (no code-signing certificate), so Windows
  SmartScreen will display a "Windows protected your PC" warning on first run.
  Choose **More info → Run anyway** to proceed.

## [4.0.7] - upstream baseline

The starting point of this fork — upstream
[Winston-Saarloos/rr-image-downloader](https://github.com/Winston-Saarloos/rr-image-downloader)
at tag `v4.0.7`. An Electron + React desktop app for saving Rec Room / Rec.net
photos locally, browsing them offline, and exploring library stats. All entries
under [4.0.8] above describe this fork's divergence from that baseline.

[4.0.7]: https://github.com/Winston-Saarloos/rr-image-downloader/releases/tag/v4.0.7
[4.0.8]: https://github.com/AndyLiner13/rr-image-downloader/releases/tag/v4.0.8
