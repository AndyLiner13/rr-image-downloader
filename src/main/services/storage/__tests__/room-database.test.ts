/**
 * Tests for the RoomDatabase incremental SQLite store.
 *
 * These run on the system Node (>= 22.5) where `node:sqlite` is available, and
 * validate the behaviors that replace the legacy read-merge-rewrite JSON cycle:
 *   - incremental UPSERT (new vs updated, idempotent re-runs, no duplicates)
 *   - paging / sorting / searching without loading everything into memory
 *   - per-photo download status tracking
 *   - resumable comment-fetch bookkeeping
 *   - exact round-trip of the original metadata blob (for JSON export)
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import type { EventDto } from '../../../models/EventDto';
import type { ImageCommentDto } from '../../../models/ImageCommentDto';
import type { ImageDto } from '../../../models/ImageDto';
import type { PlayerResult } from '../../../models/PlayerDto';
import type { RoomDto } from '../../../models/RoomDto';
import { RoomDatabase } from '../room-database';

function makePhoto(overrides: Partial<ImageDto> & { Id: string }): ImageDto {
  return {
    Id: overrides.Id,
    Type: overrides.Type ?? 0,
    Accessibility: overrides.Accessibility ?? 0,
    AccessibilityLocked: overrides.AccessibilityLocked ?? false,
    ImageName: overrides.ImageName ?? `image_${overrides.Id}.jpg`,
    Description: overrides.Description ?? '',
    PlayerId: overrides.PlayerId ?? '100',
    TaggedPlayerIds: overrides.TaggedPlayerIds ?? [],
    RoomId: overrides.RoomId ?? '777',
    PlayerEventId: overrides.PlayerEventId ?? '0',
    CreatedAt: overrides.CreatedAt ?? '2026-01-01T00:00:00Z',
    CheerCount: overrides.CheerCount ?? 0,
    CommentCount: overrides.CommentCount ?? 0,
  };
}

describe('RoomDatabase', () => {
  let dir: string;
  let db: RoomDatabase;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roomdb-'));
    db = await RoomDatabase.open(dir);
  });

  afterEach(async () => {
    db.close();
    await fs.remove(dir);
  });

  it('creates the database file on disk', async () => {
    const dbPath = RoomDatabase.getDatabasePath(dir);
    expect(await fs.pathExists(dbPath)).toBe(true);
  });

  describe('incremental upsert', () => {
    it('counts new rows as inserted and existing rows as updated', () => {
      const first = db.upsertPhotos([
        makePhoto({ Id: '1' }),
        makePhoto({ Id: '2' }),
      ]);
      expect(first).toEqual({ inserted: 2, updated: 0 });

      const second = db.upsertPhotos([
        makePhoto({ Id: '2', Description: 'changed' }),
        makePhoto({ Id: '3' }),
      ]);
      expect(second).toEqual({ inserted: 1, updated: 1 });

      expect(db.countPhotos()).toBe(3);
    });

    it('is idempotent — re-upserting the same batch creates no duplicates', () => {
      const batch = [makePhoto({ Id: '1' }), makePhoto({ Id: '2' })];
      db.upsertPhotos(batch);
      db.upsertPhotos(batch);
      db.upsertPhotos(batch);
      expect(db.countPhotos()).toBe(2);
    });

    it('updates indexed columns when a photo is re-fetched', () => {
      db.upsertPhotos([makePhoto({ Id: '1', CheerCount: 1, CommentCount: 0 })]);
      db.upsertPhotos([makePhoto({ Id: '1', CheerCount: 9, CommentCount: 4 })]);
      const page = db.getPhotosPage({
        offset: 0,
        limit: 10,
        sortBy: 'most-cheered',
      });
      expect(page.total).toBe(1);
      expect(page.photos[0].CheerCount).toBe(9);
      expect(page.photos[0].CommentCount).toBe(4);
    });
  });

  describe('download status', () => {
    it('preserves downloaded flag across metadata re-upserts', () => {
      db.upsertPhotos([makePhoto({ Id: '1' })]);
      db.setPhotoDownloaded('1', '/tmp/1.jpg');
      expect(db.isPhotoDownloaded('1')).toBe(true);

      // A later metadata refresh must NOT clear the downloaded flag.
      db.upsertPhotos([makePhoto({ Id: '1', Description: 'refreshed' })]);
      expect(db.isPhotoDownloaded('1')).toBe(true);
      expect(db.getDownloadedPhotoIds()).toEqual(new Set(['1']));
    });

    it('bulk-marks downloaded photos', () => {
      db.upsertPhotos([
        makePhoto({ Id: '1' }),
        makePhoto({ Id: '2' }),
        makePhoto({ Id: '3' }),
      ]);
      db.setPhotosDownloaded([
        { id: '1', localFilePath: '/a/1.jpg' },
        { id: '3', localFilePath: '/a/3.jpg' },
      ]);
      expect(db.getDownloadedPhotoIds()).toEqual(new Set(['1', '3']));
      expect(db.countPhotos(true)).toBe(2);
    });
  });

  describe('paging / sorting / search', () => {
    beforeEach(() => {
      db.upsertPhotos([
        makePhoto({
          Id: '1',
          CreatedAt: '2026-01-01T00:00:00Z',
          CheerCount: 5,
          CommentCount: 1,
          ImageName: 'alpha.jpg',
        }),
        makePhoto({
          Id: '2',
          CreatedAt: '2026-02-01T00:00:00Z',
          CheerCount: 1,
          CommentCount: 9,
          ImageName: 'bravo.jpg',
        }),
        makePhoto({
          Id: '3',
          CreatedAt: '2026-03-01T00:00:00Z',
          CheerCount: 9,
          CommentCount: 3,
          ImageName: 'charlie.jpg',
        }),
      ]);
    });

    it('defaults to oldest-to-newest', () => {
      const page = db.getPhotosPage({ offset: 0, limit: 10 });
      expect(page.photos.map(p => p.Id)).toEqual(['1', '2', '3']);
    });

    it('sorts newest-to-oldest', () => {
      const page = db.getPhotosPage({
        offset: 0,
        limit: 10,
        sortBy: 'newest-to-oldest',
      });
      expect(page.photos.map(p => p.Id)).toEqual(['3', '2', '1']);
    });

    it('sorts most-cheered and most-comments', () => {
      expect(
        db
          .getPhotosPage({ offset: 0, limit: 10, sortBy: 'most-cheered' })
          .photos.map(p => p.Id)
      ).toEqual(['3', '1', '2']);
      expect(
        db
          .getPhotosPage({ offset: 0, limit: 10, sortBy: 'most-comments' })
          .photos.map(p => p.Id)
      ).toEqual(['2', '3', '1']);
    });

    it('pages with stable total', () => {
      const p1 = db.getPhotosPage({ offset: 0, limit: 2 });
      const p2 = db.getPhotosPage({ offset: 2, limit: 2 });
      expect(p1.total).toBe(3);
      expect(p2.total).toBe(3);
      expect(p1.photos).toHaveLength(2);
      expect(p2.photos).toHaveLength(1);
    });

    it('searches by image name (case-insensitive)', () => {
      const page = db.getPhotosPage({
        offset: 0,
        limit: 10,
        searchQuery: 'BRAVO',
      });
      expect(page.total).toBe(1);
      expect(page.photos[0].Id).toBe('2');
    });

    it('filters to favorites only (empty favorites -> nothing)', () => {
      const favs = db.getPhotosPage({
        offset: 0,
        limit: 10,
        favoriteIds: ['1', '3'],
      });
      expect(favs.total).toBe(2);
      expect(favs.photos.map(p => p.Id)).toEqual(['1', '3']);

      const none = db.getPhotosPage({ offset: 0, limit: 10, favoriteIds: [] });
      expect(none.total).toBe(0);
      expect(none.photos).toHaveLength(0);
    });

    it('attaches the stored local_file_path to paged photos', () => {
      db.setPhotosDownloaded([{ id: '2', localFilePath: '/imgs/2.jpg' }]);
      const downloaded = db.getPhotosPage({
        offset: 0,
        limit: 10,
        downloadedOnly: true,
      });
      expect(downloaded.total).toBe(1);
      expect(downloaded.photos[0].Id).toBe('2');
      expect(downloaded.photos[0].localFilePath).toBe('/imgs/2.jpg');
    });
  });

  describe('getPhotoIndex (anchor offset resolution)', () => {
    beforeEach(() => {
      db.upsertPhotos([
        makePhoto({ Id: '1', CreatedAt: '2026-01-01T00:00:00Z' }),
        makePhoto({ Id: '2', CreatedAt: '2026-02-01T00:00:00Z' }),
        makePhoto({ Id: '3', CreatedAt: '2026-03-01T00:00:00Z' }),
        makePhoto({ Id: '4', CreatedAt: '2026-04-01T00:00:00Z' }),
      ]);
    });

    it('returns the 0-based index in oldest-to-newest order', () => {
      expect(db.getPhotoIndex({ anchorId: '1' })).toBe(0);
      expect(db.getPhotoIndex({ anchorId: '3' })).toBe(2);
      expect(db.getPhotoIndex({ anchorId: '4' })).toBe(3);
    });

    it('returns the index in newest-to-oldest order', () => {
      expect(
        db.getPhotoIndex({ anchorId: '4', sortBy: 'newest-to-oldest' })
      ).toBe(0);
      expect(
        db.getPhotoIndex({ anchorId: '1', sortBy: 'newest-to-oldest' })
      ).toBe(3);
    });

    it('matches the offset a paged scan would land on', () => {
      const sorted = db
        .getPhotosPage({ offset: 0, limit: 100 })
        .photos.map(p => p.Id);
      const anchorId = sorted[2];
      const index = db.getPhotoIndex({ anchorId });
      expect(index).toBe(2);
      const page = db.getPhotosPage({ offset: index ?? 0, limit: 1 });
      expect(page.photos[0].Id).toBe(anchorId);
    });

    it('returns null when the anchor is filtered out or unknown', () => {
      expect(db.getPhotoIndex({ anchorId: 'nope' })).toBeNull();
      // Not downloaded -> excluded by downloadedOnly filter.
      expect(
        db.getPhotoIndex({ anchorId: '2', downloadedOnly: true })
      ).toBeNull();
    });
  });

  describe('related entities', () => {
    it('upserts and round-trips accounts/rooms/events', () => {
      const accounts = [
        { accountId: '100', username: 'a' },
      ] as unknown as PlayerResult[];
      const rooms = [{ RoomId: '777', Name: '^room' }] as unknown as RoomDto[];
      const events = [
        { PlayerEventId: '55', Name: 'evt' },
      ] as unknown as EventDto[];

      db.upsertAccounts(accounts);
      db.upsertRooms(rooms);
      db.upsertEvents(events);

      // idempotent
      db.upsertAccounts(accounts);
      db.upsertRooms(rooms);
      db.upsertEvents(events);

      expect(db.getAllAccounts()).toHaveLength(1);
      expect(db.getAllRooms()).toHaveLength(1);
      expect(db.getAllEvents()).toHaveLength(1);
    });
  });

  describe('comments (resumable second pass)', () => {
    it('reports image IDs that need comments and clears them once fetched', () => {
      db.upsertPhotos([
        makePhoto({ Id: '1', CommentCount: 2 }),
        makePhoto({ Id: '2', CommentCount: 0 }),
        makePhoto({ Id: '3', CommentCount: 5 }),
      ]);

      expect(db.getImageIdsNeedingComments()).toEqual(['1', '3']);

      const comments = [
        {
          SavedImageCommentId: 'c1',
          SavedImageId: '1',
          PlayerId: '9',
          Comment: 'hi',
        },
      ] as unknown as ImageCommentDto[];
      db.upsertImageComments(comments);
      db.markCommentsFetched('1', 2);

      expect(db.getImageIdsNeedingComments()).toEqual(['3']);
      expect(db.getAllImageComments()).toHaveLength(1);
    });

    it('tracks which images already have fetched comments (skip set)', () => {
      db.upsertPhotos([
        makePhoto({ Id: '1', CommentCount: 2 }),
        makePhoto({ Id: '2', CommentCount: 1 }),
      ]);
      expect(db.getImageIdsWithFetchedComments()).toEqual(new Set());
      db.markCommentsFetched('1', 2);
      expect(db.getImageIdsWithFetchedComments()).toEqual(new Set(['1']));
    });
  });

  describe('incremental missing-id lookups', () => {
    it('returns only IDs not already stored', () => {
      db.upsertAccounts([
        { accountId: '10' },
        { accountId: '20' },
      ] as unknown as PlayerResult[]);
      db.upsertRooms([{ RoomId: '777' }] as unknown as RoomDto[]);
      db.upsertEvents([{ PlayerEventId: '55' }] as unknown as EventDto[]);

      expect(db.getMissingAccountIds(['10', '20', '30', '40'])).toEqual([
        '30',
        '40',
      ]);
      expect(db.getMissingRoomIds(['777', '888'])).toEqual(['888']);
      expect(db.getMissingEventIds(['55', '66'])).toEqual(['66']);
      // de-dupes and ignores blanks
      expect(db.getMissingAccountIds(['30', '30', '', '10'])).toEqual(['30']);
    });

    it('handles batches larger than the SQL chunk size', () => {
      const stored = Array.from({ length: 500 }, (_, i) => ({
        accountId: String(i),
      })) as unknown as PlayerResult[];
      db.upsertAccounts(stored);
      const query = Array.from({ length: 1000 }, (_, i) => String(i));
      const missing = db.getMissingAccountIds(query);
      // 0..499 stored, 500..999 missing
      expect(missing).toHaveLength(500);
      expect(missing[0]).toBe('500');
      expect(missing[missing.length - 1]).toBe('999');
    });
  });

  it('round-trips the full original metadata blob for JSON export', () => {
    const original = makePhoto({
      Id: '42',
      TaggedPlayerIds: ['1', '2', '3'],
      PlayerEventId: '99',
      Description: 'keep me',
    });
    db.upsertPhotos([original]);
    const [restored] = db.getAllPhotos();
    expect(restored).toEqual(original);
  });
});
