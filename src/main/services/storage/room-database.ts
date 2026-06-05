/**
 * RoomDatabase — incremental SQLite storage for the capture phase.
 *
 * Why this exists
 * ---------------
 * The legacy capture path treated the per-room `*_photos.json` file as the live
 * working database: every downloaded batch read the entire JSON file, merged the
 * new records into the full list, re-normalized everything, rewrote the whole
 * file, and then re-derived related accounts/rooms/events/comments over the full
 * accumulated set. That is O(N) work per batch -> O(N^2) over a full room, which
 * collapses on rooms with 100k+ images.
 *
 * This module replaces that with a SQLite database (via the built-in
 * `node:sqlite` module — no native addon, no rebuild) that:
 *   - inserts/updates ONLY the new records each batch (UPSERT),
 *   - keeps indexes for sorting / searching / paging,
 *   - tracks per-photo download status,
 *   - preserves the FULL original metadata object as a JSON blob so the exact
 *     same JSON files can be regenerated on demand.
 *
 * JSON remains the *final export* format, produced once when capture finishes
 * (or on demand) — never rewritten on every batch.
 *
 * Requires Node 22.5+ / Electron 35+ for `node:sqlite`. The app targets
 * Electron 38 (Node 22.18) where `require('node:sqlite')` is available.
 */

// `node:sqlite` is a built-in module. Types ship with @types/node >= 22.5.
// eslint-disable-next-line import/no-unresolved
import * as fs from 'fs-extra';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'path';

import type { Photo } from '../../../shared/types';
import type { EventDto } from '../../models/EventDto';
import type { ImageCommentDto } from '../../models/ImageCommentDto';
import type { ImageDto } from '../../models/ImageDto';
import type { PlayerResult } from '../../models/PlayerDto';
import type { RoomDto } from '../../models/RoomDto';

export type PhotoSortBy =
  | 'oldest-to-newest'
  | 'newest-to-oldest'
  | 'most-cheered'
  | 'most-comments';

export interface PhotoPageQuery {
  offset: number;
  limit: number;
  sortBy?: PhotoSortBy;
  searchQuery?: string;
  /** When set, only return photos that have already been downloaded locally. */
  downloadedOnly?: boolean;
}

export interface PhotoPage {
  photos: Photo[];
  total: number;
  offset: number;
  limit: number;
}

export interface UpsertPhotosResult {
  /** Number of rows that did not previously exist. */
  inserted: number;
  /** Number of rows that already existed and were updated. */
  updated: number;
}

const DB_FILE_NAME = 'capture.sqlite';

/** Current schema version. Bump when the schema changes to drive migrations. */
const SCHEMA_VERSION = 1;

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeIdValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

/**
 * A single-room (or single-folder) SQLite store. One instance owns one DB file.
 * All writes are synchronous (node:sqlite is sync) and very fast; wrap bulk
 * inserts in {@link transaction} to batch them into one fsync.
 */
export class RoomDatabase {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Resolve the canonical DB path for a capture folder. */
  static getDatabasePath(folderDir: string): string {
    return path.join(folderDir, DB_FILE_NAME);
  }

  /**
   * Open (creating if needed) the database for a capture folder. Ensures the
   * folder exists, enables WAL for concurrent readers + a single writer, and
   * applies the schema.
   */
  static async open(folderDir: string): Promise<RoomDatabase> {
    await fs.ensureDir(folderDir);
    const dbPath = RoomDatabase.getDatabasePath(folderDir);
    const db = new DatabaseSync(dbPath);

    // WAL lets the renderer/comments worker read while capture writes.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = OFF;');

    const instance = new RoomDatabase(db);
    instance.applySchema();
    return instance;
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS photos (
        id              TEXT PRIMARY KEY,
        room_id         TEXT,
        player_id       TEXT,
        created_at      TEXT,
        image_name      TEXT,
        description     TEXT,
        cheer_count     INTEGER DEFAULT 0,
        comment_count   INTEGER DEFAULT 0,
        downloaded      INTEGER NOT NULL DEFAULT 0,
        local_file_path TEXT,
        data            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_photos_created    ON photos(created_at);
      CREATE INDEX IF NOT EXISTS idx_photos_room       ON photos(room_id);
      CREATE INDEX IF NOT EXISTS idx_photos_player     ON photos(player_id);
      CREATE INDEX IF NOT EXISTS idx_photos_cheers     ON photos(cheer_count);
      CREATE INDEX IF NOT EXISTS idx_photos_comments   ON photos(comment_count);
      CREATE INDEX IF NOT EXISTS idx_photos_downloaded ON photos(downloaded);
      CREATE INDEX IF NOT EXISTS idx_photos_name       ON photos(image_name);

      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        data       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        data    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        data     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS image_comments (
        comment_id TEXT PRIMARY KEY,
        image_id   TEXT,
        player_id  TEXT,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_image ON image_comments(image_id);

      /* Tracks which images we have already attempted to fetch comments for,
         so the manual "fetch comments" pass can resume without re-querying. */
      CREATE TABLE IF NOT EXISTS comment_fetch_status (
        image_id   TEXT PRIMARY KEY,
        fetched_at TEXT,
        count      INTEGER DEFAULT 0
      );
    `);

    const existingVersion = this.getMetaNumber('schema_version');
    if (existingVersion === undefined) {
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }
  }

  /** Run `fn` inside a single transaction (one fsync for the whole batch). */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // meta
  // ---------------------------------------------------------------------------

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  getMetaNumber(key: string): number | undefined {
    const raw = this.getMeta(key);
    if (raw === undefined) {
      return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  // ---------------------------------------------------------------------------
  // photos
  // ---------------------------------------------------------------------------

  /**
   * Insert or update only the supplied photos. Existing rows keep their
   * `downloaded` / `local_file_path` columns (download status is owned by the
   * download step, not the metadata fetch). Returns counts of new vs updated.
   */
  upsertPhotos(photos: ImageDto[] | Photo[]): UpsertPhotosResult {
    if (!photos.length) {
      return { inserted: 0, updated: 0 };
    }

    const existsStmt = this.db.prepare(`SELECT 1 FROM photos WHERE id = ?`);
    const upsertStmt = this.db.prepare(
      `INSERT INTO photos
         (id, room_id, player_id, created_at, image_name, description,
          cheer_count, comment_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         room_id       = excluded.room_id,
         player_id     = excluded.player_id,
         created_at    = excluded.created_at,
         image_name    = excluded.image_name,
         description   = excluded.description,
         cheer_count   = excluded.cheer_count,
         comment_count = excluded.comment_count,
         data          = excluded.data`
    );

    let inserted = 0;
    let updated = 0;

    this.transaction(() => {
      for (const photo of photos) {
        const id = normalizeIdValue((photo as ImageDto).Id);
        if (!id) {
          continue;
        }
        const already = existsStmt.get(id);
        upsertStmt.run(
          id,
          normalizeIdValue(photo.RoomId),
          normalizeIdValue(photo.PlayerId),
          photo.CreatedAt ?? null,
          photo.ImageName ?? null,
          photo.Description ?? null,
          toNumber(photo.CheerCount),
          toNumber(photo.CommentCount),
          JSON.stringify(photo)
        );
        if (already) {
          updated++;
        } else {
          inserted++;
        }
      }
    });

    return { inserted, updated };
  }

  /** Mark a photo as downloaded and record its on-disk path. */
  setPhotoDownloaded(id: string, localFilePath?: string): void {
    const normalized = normalizeIdValue(id);
    if (!normalized) {
      return;
    }
    this.db
      .prepare(
        `UPDATE photos SET downloaded = 1, local_file_path = ? WHERE id = ?`
      )
      .run(localFilePath ?? null, normalized);
  }

  /** Bulk-mark downloaded photos in a single transaction. */
  setPhotosDownloaded(
    entries: Array<{ id: string; localFilePath?: string }>
  ): void {
    if (!entries.length) {
      return;
    }
    const stmt = this.db.prepare(
      `UPDATE photos SET downloaded = 1, local_file_path = ? WHERE id = ?`
    );
    this.transaction(() => {
      for (const entry of entries) {
        const id = normalizeIdValue(entry.id);
        if (!id) {
          continue;
        }
        stmt.run(entry.localFilePath ?? null, id);
      }
    });
  }

  hasPhoto(id: string): boolean {
    const normalized = normalizeIdValue(id);
    if (!normalized) {
      return false;
    }
    return Boolean(
      this.db.prepare(`SELECT 1 FROM photos WHERE id = ?`).get(normalized)
    );
  }

  isPhotoDownloaded(id: string): boolean {
    const normalized = normalizeIdValue(id);
    if (!normalized) {
      return false;
    }
    const row = this.db
      .prepare(`SELECT downloaded FROM photos WHERE id = ?`)
      .get(normalized) as { downloaded: number } | undefined;
    return row?.downloaded === 1;
  }

  /** Set of photo IDs already marked downloaded (for fast batch skip checks). */
  getDownloadedPhotoIds(): Set<string> {
    const rows = this.db
      .prepare(`SELECT id FROM photos WHERE downloaded = 1`)
      .all() as Array<{ id: string }>;
    return new Set(rows.map(r => r.id));
  }

  countPhotos(downloadedOnly = false): number {
    const sql = downloadedOnly
      ? `SELECT COUNT(*) AS c FROM photos WHERE downloaded = 1`
      : `SELECT COUNT(*) AS c FROM photos`;
    const row = this.db.prepare(sql).get() as { c: number };
    return toNumber(row?.c);
  }

  /**
   * Paged, sorted, optionally-searched photo query — replaces loading the whole
   * `*_photos.json` into renderer memory.
   */
  getPhotosPage(query: PhotoPageQuery): PhotoPage {
    const limit = Math.max(1, Math.floor(query.limit));
    const offset = Math.max(0, Math.floor(query.offset));
    const where: string[] = [];
    const args: Array<string | number> = [];

    if (query.downloadedOnly) {
      where.push('downloaded = 1');
    }
    if (query.searchQuery && query.searchQuery.trim()) {
      const like = `%${query.searchQuery.trim().toLowerCase()}%`;
      where.push('(LOWER(image_name) LIKE ? OR LOWER(description) LIKE ?)');
      args.push(like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let orderSql: string;
    switch (query.sortBy) {
      case 'newest-to-oldest':
        orderSql = 'ORDER BY created_at DESC, id DESC';
        break;
      case 'most-cheered':
        orderSql = 'ORDER BY cheer_count DESC, created_at DESC';
        break;
      case 'most-comments':
        orderSql = 'ORDER BY comment_count DESC, created_at DESC';
        break;
      case 'oldest-to-newest':
      default:
        orderSql = 'ORDER BY created_at ASC, id ASC';
        break;
    }

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM photos ${whereSql}`)
      .get(...args) as { c: number };
    const total = toNumber(totalRow?.c);

    const rows = this.db
      .prepare(
        `SELECT data FROM photos ${whereSql} ${orderSql} LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset) as Array<{ data: string }>;

    const photos = rows.map(r => this.hydratePhoto(r.data));
    return { photos, total, offset, limit };
  }

  /** All photos in stable order — used to regenerate the export JSON. */
  getAllPhotos(): Photo[] {
    const rows = this.db
      .prepare(`SELECT data FROM photos ORDER BY created_at ASC, id ASC`)
      .all() as Array<{ data: string }>;
    return rows.map(r => this.hydratePhoto(r.data));
  }

  private hydratePhoto(data: string): Photo {
    const parsed = JSON.parse(data) as Photo;
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // accounts / rooms / events
  // ---------------------------------------------------------------------------

  upsertAccounts(accounts: PlayerResult[]): void {
    if (!accounts.length) {
      return;
    }
    const stmt = this.db.prepare(
      `INSERT INTO accounts (account_id, data) VALUES (?, ?)
       ON CONFLICT(account_id) DO UPDATE SET data = excluded.data`
    );
    this.transaction(() => {
      for (const account of accounts) {
        const id = normalizeIdValue(account.accountId);
        if (!id) {
          continue;
        }
        stmt.run(id, JSON.stringify(account));
      }
    });
  }

  upsertRooms(rooms: RoomDto[]): void {
    if (!rooms.length) {
      return;
    }
    const stmt = this.db.prepare(
      `INSERT INTO rooms (room_id, data) VALUES (?, ?)
       ON CONFLICT(room_id) DO UPDATE SET data = excluded.data`
    );
    this.transaction(() => {
      for (const room of rooms) {
        const id = normalizeIdValue(room.RoomId);
        if (!id) {
          continue;
        }
        stmt.run(id, JSON.stringify(room));
      }
    });
  }

  upsertEvents(events: EventDto[]): void {
    if (!events.length) {
      return;
    }
    const stmt = this.db.prepare(
      `INSERT INTO events (event_id, data) VALUES (?, ?)
       ON CONFLICT(event_id) DO UPDATE SET data = excluded.data`
    );
    this.transaction(() => {
      for (const event of events) {
        const id = normalizeIdValue(event.PlayerEventId);
        if (!id) {
          continue;
        }
        stmt.run(id, JSON.stringify(event));
      }
    });
  }

  upsertImageComments(comments: ImageCommentDto[]): void {
    if (!comments.length) {
      return;
    }
    const stmt = this.db.prepare(
      `INSERT INTO image_comments (comment_id, image_id, player_id, data)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(comment_id) DO UPDATE SET
         image_id  = excluded.image_id,
         player_id = excluded.player_id,
         data      = excluded.data`
    );
    this.transaction(() => {
      for (const comment of comments) {
        const id = normalizeIdValue(comment.SavedImageCommentId);
        if (!id) {
          continue;
        }
        stmt.run(
          id,
          normalizeIdValue(comment.SavedImageId),
          normalizeIdValue(comment.PlayerId),
          JSON.stringify(comment)
        );
      }
    });
  }

  /** Record that an image's comments have been fetched (for resumable passes). */
  markCommentsFetched(imageId: string, count: number): void {
    const id = normalizeIdValue(imageId);
    if (!id) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO comment_fetch_status (image_id, fetched_at, count)
         VALUES (?, ?, ?)
         ON CONFLICT(image_id) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           count      = excluded.count`
      )
      .run(id, new Date().toISOString(), toNumber(count));
  }

  /** Image IDs that have comments (CommentCount > 0) but were never fetched. */
  getImageIdsNeedingComments(): string[] {
    const rows = this.db
      .prepare(
        `SELECT p.id AS id
           FROM photos p
           LEFT JOIN comment_fetch_status s ON s.image_id = p.id
          WHERE p.comment_count > 0 AND s.image_id IS NULL
          ORDER BY p.created_at ASC, p.id ASC`
      )
      .all() as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  getAllAccounts(): PlayerResult[] {
    const rows = this.db.prepare(`SELECT data FROM accounts`).all() as Array<{
      data: string;
    }>;
    return rows.map(r => JSON.parse(r.data) as PlayerResult);
  }

  getAllRooms(): RoomDto[] {
    const rows = this.db.prepare(`SELECT data FROM rooms`).all() as Array<{
      data: string;
    }>;
    return rows.map(r => JSON.parse(r.data) as RoomDto);
  }

  getAllEvents(): EventDto[] {
    const rows = this.db.prepare(`SELECT data FROM events`).all() as Array<{
      data: string;
    }>;
    return rows.map(r => JSON.parse(r.data) as EventDto);
  }

  getAllImageComments(): ImageCommentDto[] {
    const rows = this.db
      .prepare(`SELECT data FROM image_comments`)
      .all() as Array<{ data: string }>;
    return rows.map(r => JSON.parse(r.data) as ImageCommentDto);
  }

  // ---------------------------------------------------------------------------
  // incremental "which of these are missing?" lookups (O(batch), not O(total))
  // ---------------------------------------------------------------------------

  /**
   * Given a set of candidate IDs, return only those NOT already present in the
   * given table. Used by the capture path so each batch only fetches related
   * accounts/rooms/events it has never seen — without scanning the whole table.
   */
  private getMissingIds(
    table: 'accounts' | 'rooms' | 'events',
    column: 'account_id' | 'room_id' | 'event_id',
    ids: Iterable<string>
  ): string[] {
    const unique = new Map<string, string>();
    for (const raw of ids) {
      const id = normalizeIdValue(raw);
      if (id) {
        unique.set(id, id);
      }
    }
    if (unique.size === 0) {
      return [];
    }

    const present = new Set<string>();
    const all = Array.from(unique.keys());
    const CHUNK = 400; // stay well under SQLite's bound-variable limit
    for (let i = 0; i < all.length; i += CHUNK) {
      const chunk = all.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT ${column} AS id FROM ${table} WHERE ${column} IN (${placeholders})`
        )
        .all(...chunk) as Array<{ id: string }>;
      for (const row of rows) {
        present.add(normalizeIdValue(row.id));
      }
    }
    return all.filter(id => !present.has(id));
  }

  getMissingAccountIds(ids: Iterable<string>): string[] {
    return this.getMissingIds('accounts', 'account_id', ids);
  }

  getMissingRoomIds(ids: Iterable<string>): string[] {
    return this.getMissingIds('rooms', 'room_id', ids);
  }

  getMissingEventIds(ids: Iterable<string>): string[] {
    return this.getMissingIds('events', 'event_id', ids);
  }

  countAccounts(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get() as {
      c: number;
    };
    return toNumber(row?.c);
  }

  /** True once any photos have been imported — used to gate one-time migration. */
  isEmpty(): boolean {
    return this.countPhotos() === 0;
  }

  /** Image IDs whose comments have already been fetched (to skip on re-runs). */
  getImageIdsWithFetchedComments(): Set<string> {
    const rows = this.db
      .prepare(`SELECT image_id FROM comment_fetch_status`)
      .all() as Array<{ image_id: string }>;
    return new Set(rows.map(r => normalizeIdValue(r.image_id)));
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  /** Flush WAL back into the main DB file (call before exporting/closing). */
  checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* best effort */
    }
  }

  close(): void {
    this.checkpoint();
    this.db.close();
  }
}
