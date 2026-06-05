/**
 * GlobalDatabase — a single SQLite store living at the root of the output
 * directory (`<outputRoot>/data.sqlite`).
 *
 * Why this exists
 * ---------------
 * Account/room/event metadata used to be cached as JSON files:
 *   - `<outputRoot>/metadata/accounts.json`          (central account records)
 *   - `<outputRoot>/metadata/accounts-metadata.json` (account image asset map)
 *   - `<folder>/<stem>_accounts.json` etc.           (per-folder bulk caches)
 *
 * Every capture re-read and rewrote those whole files to dedupe what had
 * already been fetched. That is the same O(N^2) JSON-as-database pattern the
 * room pipeline already replaced with SQLite.
 *
 * This database is the global, cross-folder dedup store / working cache for:
 *   - account records   (full PlayerResult blobs, keyed by accountId)
 *   - account assets     (downloaded profile/banner image manifest entries)
 *   - rooms              (full RoomDto blobs, keyed by RoomId)
 *   - events             (full EventDto blobs, keyed by PlayerEventId)
 *
 * JSON files are still emitted as the *final export* artifacts (per folder),
 * regenerated from this database — never used as the working cache.
 *
 * Uses the built-in `node:sqlite` module (no native addon). Requires Node
 * 22.5+ / Electron 35+. The app targets Electron 38 (Node 22.18).
 */

// eslint-disable-next-line import/no-unresolved
import * as fs from 'fs-extra';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'path';

import type { EventDto } from '../../models/EventDto';
import type { ImageCommentDto } from '../../models/ImageCommentDto';
import type { PlayerResult } from '../../models/PlayerDto';
import type { RoomDto } from '../../models/RoomDto';

/** A downloaded CDN image asset entry (mirrors recnet-service MetadataImageEntryV1). */
export interface AccountAssetEntry {
  imageName: string;
  relativePath: string;
  absolutePath: string;
}

/** Per-account profile/banner asset manifest entry. */
export interface AccountAssets {
  profile?: AccountAssetEntry;
  banner?: AccountAssetEntry;
}

const DB_FILE_NAME = 'data.sqlite';
const SCHEMA_VERSION = 2;

function normalizeIdValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

/**
 * Global, cross-folder SQLite store at the output root. One instance owns the
 * single `data.sqlite` file. All writes are synchronous (node:sqlite is sync).
 */
export class GlobalDatabase {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static getDatabasePath(outputRoot: string): string {
    return path.join(outputRoot, DB_FILE_NAME);
  }

  /** Open (creating if needed) the global database at the output root. */
  static async open(outputRoot: string): Promise<GlobalDatabase> {
    await fs.ensureDir(outputRoot);
    const dbPath = GlobalDatabase.getDatabasePath(outputRoot);
    const db = new DatabaseSync(dbPath);

    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = OFF;');

    const instance = new GlobalDatabase(db);
    instance.applySchema();
    return instance;
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at TEXT
      );

      /* Downloaded profile/banner image manifest per account. */
      CREATE TABLE IF NOT EXISTS account_assets (
        account_id TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        data    TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        data     TEXT NOT NULL,
        updated_at TEXT
      );

      /* Image comments, keyed by comment id, indexed by their saved image. */
      CREATE TABLE IF NOT EXISTS image_comments (
        saved_image_comment_id TEXT PRIMARY KEY,
        saved_image_id         TEXT NOT NULL,
        data                   TEXT NOT NULL,
        updated_at             TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_image_comments_image
        ON image_comments (saved_image_id);
    `);

    const existingVersion = this.getMetaNumber('schema_version');
    if (existingVersion === undefined || existingVersion < SCHEMA_VERSION) {
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }
  }

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
  // accounts (records)
  // ---------------------------------------------------------------------------

  upsertAccounts(accounts: PlayerResult[]): void {
    if (!accounts.length) {
      return;
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO accounts (account_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`
    );
    this.transaction(() => {
      for (const account of accounts) {
        const id = normalizeIdValue(account.accountId);
        if (!id) {
          continue;
        }
        stmt.run(id, JSON.stringify(account), now);
      }
    });
  }

  /** Return the stored record for a single account, if present. */
  getAccount(accountId: string): PlayerResult | undefined {
    const id = normalizeIdValue(accountId);
    if (!id) {
      return undefined;
    }
    const row = this.db
      .prepare(`SELECT data FROM accounts WHERE account_id = ?`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as PlayerResult) : undefined;
  }

  /** Return stored records for the supplied account IDs (only those present). */
  getAccounts(ids: Iterable<string>): PlayerResult[] {
    return this.getRowsByIds('accounts', 'account_id', ids).map(
      data => JSON.parse(data) as PlayerResult
    );
  }

  getAllAccounts(): PlayerResult[] {
    const rows = this.db.prepare(`SELECT data FROM accounts`).all() as Array<{
      data: string;
    }>;
    return rows.map(r => JSON.parse(r.data) as PlayerResult);
  }

  /** Of the supplied IDs, return only those NOT already stored. */
  getMissingAccountIds(ids: Iterable<string>): string[] {
    return this.getMissingIds('accounts', 'account_id', ids);
  }

  // ---------------------------------------------------------------------------
  // account assets (downloaded profile/banner image manifest)
  // ---------------------------------------------------------------------------

  setAccountAssets(accountId: string, assets: AccountAssets): void {
    const id = normalizeIdValue(accountId);
    if (!id) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO account_assets (account_id, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at`
      )
      .run(id, JSON.stringify(assets), new Date().toISOString());
  }

  getAccountAssets(accountId: string): AccountAssets | undefined {
    const id = normalizeIdValue(accountId);
    if (!id) {
      return undefined;
    }
    const row = this.db
      .prepare(`SELECT data FROM account_assets WHERE account_id = ?`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as AccountAssets) : undefined;
  }

  getAllAccountAssets(): Record<string, AccountAssets> {
    const rows = this.db
      .prepare(`SELECT account_id, data FROM account_assets`)
      .all() as Array<{ account_id: string; data: string }>;
    const out: Record<string, AccountAssets> = {};
    for (const row of rows) {
      out[normalizeIdValue(row.account_id)] = JSON.parse(
        row.data
      ) as AccountAssets;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // rooms
  // ---------------------------------------------------------------------------

  upsertRooms(rooms: RoomDto[]): void {
    if (!rooms.length) {
      return;
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO rooms (room_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`
    );
    this.transaction(() => {
      for (const room of rooms) {
        const id = normalizeIdValue(room.RoomId);
        if (!id) {
          continue;
        }
        stmt.run(id, JSON.stringify(room), now);
      }
    });
  }

  getRooms(ids: Iterable<string>): RoomDto[] {
    return this.getRowsByIds('rooms', 'room_id', ids).map(
      data => JSON.parse(data) as RoomDto
    );
  }

  getMissingRoomIds(ids: Iterable<string>): string[] {
    return this.getMissingIds('rooms', 'room_id', ids);
  }

  // ---------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------

  upsertEvents(events: EventDto[]): void {
    if (!events.length) {
      return;
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO events (event_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`
    );
    this.transaction(() => {
      for (const event of events) {
        const id = normalizeIdValue(event.PlayerEventId);
        if (!id) {
          continue;
        }
        stmt.run(id, JSON.stringify(event), now);
      }
    });
  }

  getEvents(ids: Iterable<string>): EventDto[] {
    return this.getRowsByIds('events', 'event_id', ids).map(
      data => JSON.parse(data) as EventDto
    );
  }

  getMissingEventIds(ids: Iterable<string>): string[] {
    return this.getMissingIds('events', 'event_id', ids);
  }

  // ---------------------------------------------------------------------------
  // image comments (keyed by comment id, grouped by saved image id)
  // ---------------------------------------------------------------------------

  /** Insert/replace comments, keyed by SavedImageCommentId. */
  upsertImageComments(comments: ImageCommentDto[]): void {
    if (!comments.length) {
      return;
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO image_comments
         (saved_image_comment_id, saved_image_id, data, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(saved_image_comment_id) DO UPDATE SET
         saved_image_id = excluded.saved_image_id,
         data = excluded.data,
         updated_at = excluded.updated_at`
    );
    this.transaction(() => {
      for (const comment of comments) {
        const commentId = normalizeIdValue(comment.SavedImageCommentId);
        const imageId = normalizeIdValue(comment.SavedImageId);
        if (!commentId || !imageId) {
          continue;
        }
        stmt.run(commentId, imageId, JSON.stringify(comment), now);
      }
    });
  }

  /** Remove every stored comment belonging to the supplied saved-image IDs. */
  deleteImageCommentsForImageIds(imageIds: Iterable<string>): void {
    const unique = this.uniqueIds(imageIds);
    if (unique.length === 0) {
      return;
    }
    const CHUNK = 400;
    this.transaction(() => {
      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(', ');
        this.db
          .prepare(
            `DELETE FROM image_comments WHERE saved_image_id IN (${placeholders})`
          )
          .run(...chunk);
      }
    });
  }

  /** Count stored comments per saved-image ID for the supplied images. */
  getImageCommentCountsByImageId(
    imageIds: Iterable<string>
  ): Map<string, number> {
    const unique = this.uniqueIds(imageIds);
    const counts = new Map<string, number>();
    if (unique.length === 0) {
      return counts;
    }
    const CHUNK = 400;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT saved_image_id AS id, COUNT(*) AS count
             FROM image_comments
            WHERE saved_image_id IN (${placeholders})
            GROUP BY saved_image_id`
        )
        .all(...chunk) as Array<{ id: string; count: number }>;
      for (const row of rows) {
        counts.set(normalizeIdValue(row.id), Number(row.count) || 0);
      }
    }
    return counts;
  }

  /** Return all stored comments belonging to the supplied saved-image IDs. */
  getImageCommentsForImageIds(imageIds: Iterable<string>): ImageCommentDto[] {
    const unique = this.uniqueIds(imageIds);
    if (unique.length === 0) {
      return [];
    }
    const out: ImageCommentDto[] = [];
    const CHUNK = 400;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT data FROM image_comments
            WHERE saved_image_id IN (${placeholders})`
        )
        .all(...chunk) as Array<{ data: string }>;
      for (const row of rows) {
        out.push(JSON.parse(row.data) as ImageCommentDto);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // shared id helpers (chunked to stay under SQLite's bound-variable limit)
  // ---------------------------------------------------------------------------

  private getRowsByIds(
    table: 'accounts' | 'rooms' | 'events',
    column: 'account_id' | 'room_id' | 'event_id',
    ids: Iterable<string>
  ): string[] {
    const unique = this.uniqueIds(ids);
    if (unique.length === 0) {
      return [];
    }
    const out: string[] = [];
    const CHUNK = 400;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT data FROM ${table} WHERE ${column} IN (${placeholders})`
        )
        .all(...chunk) as Array<{ data: string }>;
      for (const row of rows) {
        out.push(row.data);
      }
    }
    return out;
  }

  private getMissingIds(
    table: 'accounts' | 'rooms' | 'events',
    column: 'account_id' | 'room_id' | 'event_id',
    ids: Iterable<string>
  ): string[] {
    const unique = this.uniqueIds(ids);
    if (unique.length === 0) {
      return [];
    }
    const present = new Set<string>();
    const CHUNK = 400;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
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
    return unique.filter(id => !present.has(id));
  }

  private uniqueIds(ids: Iterable<string>): string[] {
    const set = new Set<string>();
    for (const raw of ids) {
      const id = normalizeIdValue(raw);
      if (id) {
        set.add(id);
      }
    }
    return Array.from(set);
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

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
