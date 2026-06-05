import {
    ArrowLeft,
    ArrowUpDown,
    Calendar,
    ChevronDown,
    ChevronUp,
    ChevronsLeft,
    ChevronsRight,
    Download,
    Filter,
    Heart,
    Image as ImageIcon,
    Search,
    Users,
} from 'lucide-react';
import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { DEFAULT_CDN_BASE } from '../../shared/cdnUrl';
import type { EventDownloadIntent, LibraryMode } from '../../shared/types';
import {
    AvailableAccount,
    AvailableEvent,
    AvailableEventCreator,
    AvailableRoom,
    EventDto,
    ImageCommentDto,
    Photo,
    PlayerResult,
    RoomDto,
} from '../../shared/types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../components/ui/select';
import { useFavorites } from '../hooks/useFavorites';
import { AccountSelect } from './AccountSelect';
import { EventCoverImage } from './EventCoverImage';
import { PhotoDetailModal } from './PhotoDetailModal';
import { PhotoGrid } from './PhotoGrid';
import { RoomSelect } from './RoomSelect';

interface PhotoViewerProps {
  filePath: string;
  accountId?: string;
  roomId?: string;
  eventCreatorId?: string;
  libraryMode?: LibraryMode;
  isDownloading?: boolean;
  /**
   * Cumulative number of images downloaded so far during the current run. Used
   * in room mode to refresh the viewer once every
   * {@link ROOM_PHOTO_REFRESH_IMAGE_INTERVAL} images instead of on a timer.
   */
  downloadedImageCount?: number;
  onAccountChange?: (accountId: string | undefined) => void;
  onRoomChange?: (roomId: string | undefined) => void;
  onEventCreatorChange?: (creatorAccountId: string | undefined) => void;
  onScrollPositionChange?: (scrollTop: number) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement>;
  headerMode?: 'full' | 'compact' | 'hidden';
  onOpenActivityMenu?: () => void;
  onOpenDownloadPanel?: (intent?: EventDownloadIntent) => void;
  myRoomsManifestPath?: string;
  myRoomsManifestRooms?: RoomDto[];
  selectedMyRoomIds?: string[];
  isAddingMyRoom?: boolean;
  onMyRoomsManifestPathChange?: (path: string) => void;
  onSelectMyRoomsManifest?: () => void;
  onLoadMyRoomsManifest?: () => void;
  onAddRoomToMyRooms?: (roomQuery: string) => Promise<boolean>;
  onToggleMyRoomSelection?: (roomId: string, checked: boolean) => void;
  onSelectAllMyRooms?: () => void;
  onClearMyRoomsSelection?: () => void;
  onDownloadMyRooms?: () => void;
  onDownloadSelectedMyRooms?: () => void;
  onRevealOutputFolder?: () => void;
  onPhotosLoadError?: (message: string) => void;
  onPhotosLoadSuccess?: () => void;
  cdnBase?: string;
  viewerOnlyMode?: boolean;
}

type PhotoSource = 'photos' | 'feed' | 'profile-history';
const PHOTO_VIEW_PAGE_SIZE = 100;

/**
 * While a room download is running, reload the viewer once for every this many
 * newly downloaded images (instead of on a fixed time interval). This keeps the
 * "Download Progress" view fresh without re-querying on every small batch.
 */
const ROOM_PHOTO_REFRESH_IMAGE_INTERVAL = 1000;

function formatCount(value: number): string {
  return value.toLocaleString();
}

export const PhotoViewer: React.FC<PhotoViewerProps> = ({
  filePath,
  accountId: propAccountId,
  roomId: propRoomId,
  eventCreatorId: propEventCreatorId,
  libraryMode = 'user',
  isDownloading = false,
  downloadedImageCount = 0,
  onAccountChange,
  onRoomChange,
  onEventCreatorChange,
  onScrollPositionChange,
  scrollContainerRef,
  headerMode = 'full',
  onOpenActivityMenu,
  onOpenDownloadPanel,
  myRoomsManifestPath = '',
  myRoomsManifestRooms = [],
  selectedMyRoomIds = [],
  isAddingMyRoom = false,
  onMyRoomsManifestPathChange,
  onSelectMyRoomsManifest,
  onLoadMyRoomsManifest,
  onAddRoomToMyRooms,
  onToggleMyRoomSelection,
  onSelectAllMyRooms,
  onClearMyRoomsSelection,
  onDownloadMyRooms,
  onDownloadSelectedMyRooms,
  onRevealOutputFolder,
  onPhotosLoadError,
  onPhotosLoadSuccess,
  cdnBase = DEFAULT_CDN_BASE,
  viewerOnlyMode = false,
}) => {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [roomAddQuery, setRoomAddQuery] = useState('');
  const [isRoomDownloadListCollapsed, setIsRoomDownloadListCollapsed] =
    useState(false);
  const [groupBy, setGroupBy] = useState<
    'none' | 'room' | 'user' | 'date' | 'event'
  >('none');
  const [sortBy, setSortBy] = useState<
    'oldest-to-newest' | 'newest-to-oldest' | 'most-cheered' | 'most-comments'
  >('oldest-to-newest');
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [availableAccounts, setAvailableAccounts] = useState<
    AvailableAccount[]
  >([]);
  const [availableRooms, setAvailableRooms] = useState<AvailableRoom[]>([]);
  const [availableEvents, setAvailableEvents] = useState<AvailableEvent[]>([]);
  const [availableEventCreators, setAvailableEventCreators] = useState<
    AvailableEventCreator[]
  >([]);
  const [selectedEvent, setSelectedEvent] = useState<AvailableEvent | null>(
    null
  );
  const [selectedAccountId, setSelectedAccountId] = useState<
    string | undefined
  >(propAccountId);
  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(
    propRoomId
  );
  const [selectedEventCreatorId, setSelectedEventCreatorId] = useState<
    string | undefined
  >(propEventCreatorId);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [roomMap, setRoomMap] = useState<Map<string, string>>(new Map());
  const [accountMap, setAccountMap] = useState<Map<string, string>>(new Map());
  const [usernameMap, setUsernameMap] = useState<Map<string, string>>(
    new Map()
  );
  const [accountProfileImageMap, setAccountProfileImageMap] = useState<
    Map<string, string>
  >(new Map());
  const [eventMap, setEventMap] = useState<Map<string, string>>(new Map());
  const [imageComments, setImageComments] = useState<ImageCommentDto[]>([]);
  const [feedPhotos, setFeedPhotos] = useState<Photo[]>([]);
  const [profileHistoryPhotos, setProfileHistoryPhotos] = useState<Photo[]>([]);
  const [photoTotalCount, setPhotoTotalCount] = useState(0);
  const [photoSource, setPhotoSource] = useState<PhotoSource>('photos');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [eventAlbumScrollTop, setEventAlbumScrollTop] = useState(0);
  const [photoPageIndex, setPhotoPageIndex] = useState(0);
  const [eventAlbumGridSize, setEventAlbumGridSize] = useState({
    width: 0,
    height: 700,
  });
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const wasDownloadingRef = useRef(false);
  // Tracks the `downloadedImageCount` value at the last room-mode refresh so we
  // can reload once per ROOM_PHOTO_REFRESH_IMAGE_INTERVAL images downloaded.
  const lastRefreshImageCountRef = useRef(0);
  const photoLoadInFlightRef = useRef(false);
  const roomVisiblePhotosRef = useRef<Photo[]>([]);
  const roomPageWasManuallyChangedRef = useRef(false);
  const onPhotosLoadErrorRef = useRef(onPhotosLoadError);
  const onPhotosLoadSuccessRef = useRef(onPhotosLoadSuccess);
  const activeScrollRef = scrollContainerRef ?? internalScrollRef;
  const { favorites } = useFavorites();
  const electronAPI = (window as unknown as { electronAPI?: any }).electronAPI;
  const isHeaderVisible = headerMode !== 'hidden';
  const showFullControls = headerMode === 'full';

  useEffect(() => {
    onPhotosLoadErrorRef.current = onPhotosLoadError;
  }, [onPhotosLoadError]);

  useEffect(() => {
    onPhotosLoadSuccessRef.current = onPhotosLoadSuccess;
  }, [onPhotosLoadSuccess]);

  // Use propAccountId if provided, otherwise use selectedAccountId
  const accountId = propAccountId || selectedAccountId;
  const roomId = propRoomId || selectedRoomId;
  const eventCreatorId = propEventCreatorId || selectedEventCreatorId;
  const activeLibraryId =
    libraryMode === 'room'
      ? roomId
      : libraryMode === 'event'
        ? selectedEvent?.eventId
        : accountId;
  const basePhotos =
    libraryMode === 'room' || libraryMode === 'event'
      ? photos
      : photoSource === 'feed'
        ? feedPhotos
        : photoSource === 'profile-history'
          ? profileHistoryPhotos
          : photos;

  // Filter photos based on favorites filter
  const activePhotos = useMemo(() => {
    if (libraryMode === 'room') return basePhotos;
    if (!showFavoritesOnly) return basePhotos;
    return basePhotos.filter(photo => favorites.has(photo.Id.toString()));
  }, [basePhotos, showFavoritesOnly, favorites, libraryMode]);
  const totalPhotoPages = Math.max(
    1,
    Math.ceil(
      (libraryMode === 'room' ? photoTotalCount : activePhotos.length) /
        PHOTO_VIEW_PAGE_SIZE
    )
  );
  const clampedPhotoPageIndex = Math.min(photoPageIndex, totalPhotoPages - 1);
  const photoPageStart = clampedPhotoPageIndex * PHOTO_VIEW_PAGE_SIZE;
  const activePhotoTotalCount =
    libraryMode === 'room' ? photoTotalCount : activePhotos.length;
  const visiblePhotoPage = useMemo(
    () =>
      libraryMode === 'room'
        ? activePhotos
        : activePhotos.slice(
            photoPageStart,
            photoPageStart + PHOTO_VIEW_PAGE_SIZE
          ),
    [activePhotos, libraryMode, photoPageStart]
  );

  useEffect(() => {
    if (libraryMode === 'room') {
      roomVisiblePhotosRef.current = visiblePhotoPage;
    }
  }, [libraryMode, visiblePhotoPage]);

  const activeViewLabel =
    libraryMode === 'room'
      ? 'room photos'
      : libraryMode === 'event'
        ? 'event photos'
        : photoSource === 'feed'
          ? 'feed photos'
          : photoSource === 'profile-history'
            ? 'profile picture history'
            : 'photos';
  const hasUserPhotos = photos.length > 0;
  const hasFeedPhotos = feedPhotos.length > 0;
  const hasProfileHistoryPhotos = profileHistoryPhotos.length > 0;
  const hasPhotoSections =
    libraryMode === 'room'
      ? hasUserPhotos
      : libraryMode === 'event'
        ? hasUserPhotos
        : hasUserPhotos || hasFeedPhotos || hasProfileHistoryPhotos;
  const selectedMyRoomIdSet = useMemo(
    () => new Set(selectedMyRoomIds),
    [selectedMyRoomIds]
  );

  useEffect(() => {
    roomPageWasManuallyChangedRef.current = false;
    roomVisiblePhotosRef.current = [];
    setPhotoPageIndex(0);
    activeScrollRef.current?.scrollTo({ top: 0 });
  }, [
    activeLibraryId,
    groupBy,
    libraryMode,
    photoSource,
    searchQuery,
    showFavoritesOnly,
    sortBy,
  ]);

  useEffect(() => {
    if (photoPageIndex > totalPhotoPages - 1) {
      setPhotoPageIndex(totalPhotoPages - 1);
    }
  }, [photoPageIndex, totalPhotoPages]);

  const loadAvailableAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      if (electronAPI) {
        const result = await electronAPI.listAvailableAccounts();
        if (result.success && result.data) {
          setAvailableAccounts(result.data);
          // If no account is selected and accounts are available, select the first one
          if (!selectedAccountId && !propAccountId && result.data.length > 0) {
            const firstAccountId = result.data[0].accountId;
            setSelectedAccountId(firstAccountId);
            setPhotoSource('photos');
            if (onAccountChange) {
              onAccountChange(firstAccountId);
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to load available accounts:', error);
    } finally {
      setLoadingAccounts(false);
    }
  }, [electronAPI, selectedAccountId, propAccountId, onAccountChange]);

  const loadAvailableRooms = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      if (electronAPI) {
        const result = await electronAPI.listAvailableRooms();
        if (result.success && result.data) {
          setAvailableRooms(result.data);
          if (!selectedRoomId && !propRoomId && result.data.length > 0) {
            const firstRoomId = result.data[0].roomId;
            setSelectedRoomId(firstRoomId);
            setPhotoSource('photos');
            onRoomChange?.(firstRoomId);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load available rooms:', error);
    } finally {
      setLoadingAccounts(false);
    }
  }, [electronAPI, onRoomChange, propRoomId, selectedRoomId]);

  const loadAvailableEventCreators = useCallback(async () => {
    try {
      if (electronAPI) {
        const result = await electronAPI.listAvailableEventCreators();
        if (result.success && result.data) {
          setAvailableEventCreators(result.data);
          if (
            libraryMode === 'event' &&
            !selectedEventCreatorId &&
            !propEventCreatorId &&
            result.data.length > 0
          ) {
            const firstCreatorId = result.data[0].creatorAccountId;
            setSelectedEventCreatorId(firstCreatorId);
            onEventCreatorChange?.(firstCreatorId);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load available event creators:', error);
      setAvailableEventCreators([]);
    }
  }, [
    electronAPI,
    libraryMode,
    onEventCreatorChange,
    propEventCreatorId,
    selectedEventCreatorId,
  ]);

  const loadAvailableEvents = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      if (electronAPI) {
        const creatorId = eventCreatorId || selectedEventCreatorId;
        const result = creatorId
          ? await electronAPI.loadEventAlbumsForCreator(creatorId)
          : await electronAPI.listAvailableEvents();
        if (result.success && result.data) {
          setAvailableEvents(result.data);
        }
      }
    } catch (error) {
      console.error('Failed to load available events:', error);
      setAvailableEvents([]);
    } finally {
      setLoadingAccounts(false);
    }
  }, [electronAPI, eventCreatorId, selectedEventCreatorId]);

  const loadRoomData = useCallback(async () => {
    if (libraryMode === 'event') {
      if (!selectedEvent) {
        setRoomMap(new Map());
        return;
      }
      try {
        if (electronAPI) {
          const result = await electronAPI.loadEventAlbumRoomsData({
            creatorAccountId: selectedEvent.creatorAccountId,
            eventId: selectedEvent.eventId,
          });
          if (result.success && result.data) {
            const rooms = result.data as RoomDto[];
            const roomMapping = new Map<string, string>();
            rooms.forEach(room => {
              if (room.RoomId) {
                const roomId = String(room.RoomId);
                const roomName = room.Name || roomId;
                roomMapping.set(roomId, roomName);
              }
            });
            setRoomMap(roomMapping);
          }
        }
      } catch (error) {
        console.error('Failed to load room data:', error);
        setRoomMap(new Map());
      }
      return;
    }
    if (!activeLibraryId) {
      setRoomMap(new Map());
      return;
    }

    try {
      if (electronAPI) {
        const result =
          libraryMode === 'room'
            ? await electronAPI.loadRoomRoomsData(activeLibraryId)
            : await electronAPI.loadRoomsData(activeLibraryId);
        if (result.success && result.data) {
          const rooms = result.data as RoomDto[];
          const roomMapping = new Map<string, string>();
          rooms.forEach(room => {
            if (room.RoomId) {
              const roomId = String(room.RoomId);
              const roomName = room.Name || roomId;
              roomMapping.set(roomId, roomName);
            }
          });
          setRoomMap(roomMapping);
        }
      }
    } catch (error) {
      console.error('Failed to load room data:', error);
      setRoomMap(new Map());
    }
  }, [activeLibraryId, electronAPI, libraryMode, selectedEvent]);

  const loadAccountData = useCallback(async () => {
    if (libraryMode === 'event') {
      if (!selectedEvent) {
        setAccountMap(new Map());
        setUsernameMap(new Map());
        setAccountProfileImageMap(new Map());
        return;
      }
      try {
        if (electronAPI) {
          const result = await electronAPI.loadEventAlbumAccountsData({
            creatorAccountId: selectedEvent.creatorAccountId,
            eventId: selectedEvent.eventId,
          });
          if (result.success && result.data) {
            const accounts = result.data as PlayerResult[];
            const accountMapping = new Map<string, string>();
            const usernameMapping = new Map<string, string>();
            const profileImageMapping = new Map<string, string>();
            accounts.forEach(account => {
              const id = String(account.accountId);
              const displayName = account.displayName || account.username || id;
              accountMapping.set(id, displayName);
              usernameMapping.set(id, account.username || '');
              profileImageMapping.set(id, account.localProfileImagePath || '');
            });
            setAccountMap(accountMapping);
            setUsernameMap(usernameMapping);
            setAccountProfileImageMap(profileImageMapping);
          }
        }
      } catch (error) {
        console.error('Failed to load account data:', error);
        setAccountMap(new Map());
        setUsernameMap(new Map());
        setAccountProfileImageMap(new Map());
      }
      return;
    }
    if (!activeLibraryId) {
      setAccountMap(new Map());
      setUsernameMap(new Map());
      setAccountProfileImageMap(new Map());
      return;
    }

    try {
      if (electronAPI) {
        const result =
          libraryMode === 'room'
            ? await electronAPI.loadRoomAccountsData(activeLibraryId)
            : await electronAPI.loadAccountsData(activeLibraryId);
        if (result.success && result.data) {
          const accounts = result.data as PlayerResult[];
          const accountMapping = new Map<string, string>();
          const usernameMapping = new Map<string, string>();
          const profileImageMapping = new Map<string, string>();
          accounts.forEach(account => {
            const id = String(account.accountId);
            const displayName = account.displayName || account.username || id;
            accountMapping.set(id, displayName);
            usernameMapping.set(id, account.username || '');
            profileImageMapping.set(id, account.localProfileImagePath || '');
          });
          setAccountMap(accountMapping);
          setUsernameMap(usernameMapping);
          setAccountProfileImageMap(profileImageMapping);
        }
      }
    } catch (error) {
      console.error('Failed to load account data:', error);
      setAccountMap(new Map());
      setUsernameMap(new Map());
      setAccountProfileImageMap(new Map());
    }
  }, [activeLibraryId, electronAPI, libraryMode, selectedEvent]);

  const loadEventData = useCallback(async () => {
    if (libraryMode === 'event') {
      const eventMapping = new Map<string, string>();
      availableEvents.forEach(event => {
        eventMapping.set(event.eventId, event.name);
      });
      if (selectedEvent && electronAPI) {
        try {
          const result = await electronAPI.loadEventAlbumEventsData({
            creatorAccountId: selectedEvent.creatorAccountId,
            eventId: selectedEvent.eventId,
          });
          if (result.success && result.data) {
            const events = result.data as EventDto[];
            events.forEach(ev => {
              if (ev.PlayerEventId) {
                const id = String(ev.PlayerEventId);
                eventMapping.set(id, ev.Name || id);
              }
            });
          }
        } catch (error) {
          console.error('Failed to load event album events data:', error);
        }
      }
      setEventMap(eventMapping);
      return;
    }
    if (!activeLibraryId) {
      setEventMap(new Map());
      return;
    }

    try {
      if (electronAPI) {
        const result =
          libraryMode === 'room'
            ? await electronAPI.loadRoomEventsData(activeLibraryId)
            : await electronAPI.loadEventsData(activeLibraryId);
        if (result.success && result.data) {
          const eventMapping = new Map<string, string>();
          const events = result.data as EventDto[];
          events.forEach(event => {
            if (event.PlayerEventId) {
              const eventId = String(event.PlayerEventId);
              const eventName = event.Name || eventId;
              eventMapping.set(eventId, eventName);
            }
          });
          setEventMap(eventMapping);
        } else {
          setEventMap(new Map());
        }
      }
    } catch (error) {
      console.error('Failed to load event data:', error);
      setEventMap(new Map());
    }
  }, [
    activeLibraryId,
    availableEvents,
    electronAPI,
    libraryMode,
    selectedEvent,
  ]);

  const loadImageCommentsData = useCallback(async () => {
    if (libraryMode === 'event') {
      if (!selectedEvent) {
        setImageComments([]);
        return;
      }
      try {
        if (electronAPI) {
          const result = await electronAPI.loadEventAlbumImageCommentsData({
            creatorAccountId: selectedEvent.creatorAccountId,
            eventId: selectedEvent.eventId,
          });
          if (result.success && result.data) {
            setImageComments(result.data as ImageCommentDto[]);
          } else {
            setImageComments([]);
          }
        }
      } catch (error) {
        console.error('Failed to load image comments data:', error);
        setImageComments([]);
      }
      return;
    }
    if (!activeLibraryId) {
      setImageComments([]);
      return;
    }

    try {
      if (electronAPI) {
        const result =
          libraryMode === 'room'
            ? await electronAPI.loadRoomImageCommentsData(activeLibraryId)
            : await electronAPI.loadImageCommentsData(activeLibraryId);
        if (result.success && result.data) {
          setImageComments(result.data as ImageCommentDto[]);
        } else {
          setImageComments([]);
        }
      }
    } catch (error) {
      console.error('Failed to load image comments data:', error);
      setImageComments([]);
    }
  }, [activeLibraryId, electronAPI, libraryMode, selectedEvent]);

  const loadPhotos = useCallback(async () => {
    if (photoLoadInFlightRef.current) {
      return;
    }
    if (!filePath || (!activeLibraryId && libraryMode !== 'event')) {
      setPhotos([]);
      setFeedPhotos([]);
      setProfileHistoryPhotos([]);
      setPhotoTotalCount(0);
      return;
    }

    photoLoadInFlightRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      if (electronAPI) {
        if (libraryMode === 'event') {
          if (!selectedEvent) {
            setPhotos([]);
            setFeedPhotos([]);
            setProfileHistoryPhotos([]);
            return;
          }

          const eventPhotosResult = await electronAPI.loadEventAlbumPhotos({
            creatorAccountId: selectedEvent.creatorAccountId,
            eventId: selectedEvent.eventId,
          });
          setPhotos(
            eventPhotosResult.success && eventPhotosResult.data
              ? eventPhotosResult.data
              : []
          );
          setFeedPhotos([]);
          setProfileHistoryPhotos([]);
          setPhotoTotalCount(
            eventPhotosResult.success && eventPhotosResult.data
              ? eventPhotosResult.data.length
              : 0
          );
          onPhotosLoadSuccessRef.current?.();
          return;
        }

        if (libraryMode === 'room') {
          const currentRoomPage = roomVisiblePhotosRef.current;
          const shouldAnchorRoomPage =
            isDownloading &&
            roomPageWasManuallyChangedRef.current &&
            photoPageIndex > 0;
          const isOnLatestImagePage =
            sortBy === 'newest-to-oldest'
              ? photoPageIndex === 0
              : sortBy === 'oldest-to-newest'
                ? photoPageIndex >= totalPhotoPages - 1
                : false;
          const anchorPhoto =
            shouldAnchorRoomPage && !isOnLatestImagePage
              ? currentRoomPage[0]
              : undefined;
          const roomPhotosResult = await electronAPI.loadRoomPhotos({
            roomId: activeLibraryId,
            offset:
              roomPageWasManuallyChangedRef.current || photoPageIndex > 0
                ? photoPageIndex * PHOTO_VIEW_PAGE_SIZE
                : 0,
            limit: PHOTO_VIEW_PAGE_SIZE,
            sortBy,
            searchQuery,
            favoriteIds: showFavoritesOnly ? Array.from(favorites) : undefined,
            anchorPhotoId: anchorPhoto?.Id?.toString(),
            anchorIndexInPage: anchorPhoto ? 0 : undefined,
            preferLatest: shouldAnchorRoomPage && isOnLatestImagePage,
          });
          const pageData = roomPhotosResult.success
            ? roomPhotosResult.data
            : undefined;
          setPhotos(pageData?.photos ?? []);
          setPhotoTotalCount(pageData?.total ?? 0);
          if (pageData && (anchorPhoto || shouldAnchorRoomPage)) {
            const resolvedPageIndex = Math.floor(
              pageData.offset / PHOTO_VIEW_PAGE_SIZE
            );
            if (resolvedPageIndex !== photoPageIndex) {
              setPhotoPageIndex(resolvedPageIndex);
            }
          }
          setFeedPhotos([]);
          setProfileHistoryPhotos([]);
          onPhotosLoadSuccessRef.current?.();
          return;
        }

        const [photosResult, feedPhotosResult, profileHistoryResult] =
          await Promise.all([
            electronAPI.loadPhotos(activeLibraryId),
            electronAPI.loadFeedPhotos(activeLibraryId),
            electronAPI.loadProfileHistoryPhotos(activeLibraryId),
          ]);

        if (photosResult.success && photosResult.data) {
          setPhotos(photosResult.data);
        } else {
          setPhotos([]);
        }

        if (feedPhotosResult.success && feedPhotosResult.data) {
          setFeedPhotos(feedPhotosResult.data);
        } else {
          setFeedPhotos([]);
        }
        if (profileHistoryResult.success && profileHistoryResult.data) {
          setProfileHistoryPhotos(profileHistoryResult.data);
        } else {
          setProfileHistoryPhotos([]);
        }
        setPhotoTotalCount(
          photoSource === 'feed'
            ? (feedPhotosResult.data?.length ?? 0)
            : photoSource === 'profile-history'
              ? (profileHistoryResult.data?.length ?? 0)
              : (photosResult.data?.length ?? 0)
        );
        onPhotosLoadSuccessRef.current?.();
      } else {
        setPhotos([]);
        setFeedPhotos([]);
        setProfileHistoryPhotos([]);
        setPhotoTotalCount(0);
      }
    } catch (error) {
      const msg = `Failed to load photos: ${error instanceof Error ? error.message : 'Unknown error'}. Check that your output folder is accessible.`;
      setLoadError(msg);
      onPhotosLoadErrorRef.current?.(msg);
      setPhotos([]);
      setFeedPhotos([]);
      setProfileHistoryPhotos([]);
      setPhotoTotalCount(0);
    } finally {
      photoLoadInFlightRef.current = false;
      setLoading(false);
    }
  }, [
    filePath,
    activeLibraryId,
    electronAPI,
    libraryMode,
    photoPageIndex,
    photoSource,
    searchQuery,
    selectedEvent,
    showFavoritesOnly,
    sortBy,
    totalPhotoPages,
    isDownloading,
    favorites,
  ]);

  // Load available accounts on mount and when filePath changes
  useEffect(() => {
    if (filePath) {
      if (libraryMode === 'room') {
        loadAvailableRooms();
      } else if (libraryMode === 'event') {
        loadAvailableEventCreators();
        loadAvailableEvents();
      } else if (libraryMode === 'user') {
        loadAvailableAccounts();
      }
    }
  }, [
    filePath,
    libraryMode,
    loadAvailableAccounts,
    loadAvailableEventCreators,
    loadAvailableEvents,
    loadAvailableRooms,
  ]);

  // Update selectedAccountId when propAccountId changes
  useEffect(() => {
    if (propAccountId !== undefined) {
      setSelectedAccountId(propAccountId);
      setPhotoSource('photos');
    }
  }, [propAccountId]);

  useEffect(() => {
    if (propRoomId !== undefined) {
      setSelectedRoomId(propRoomId);
      setPhotoSource('photos');
    }
  }, [propRoomId]);

  useEffect(() => {
    if (propEventCreatorId !== undefined) {
      setSelectedEventCreatorId(propEventCreatorId);
      setSelectedEvent(null);
      setPhotoSource('photos');
    }
  }, [propEventCreatorId]);

  useEffect(() => {
    if (libraryMode !== 'event' || selectedEvent) {
      return;
    }

    const node = activeScrollRef.current;
    if (!node) {
      return;
    }

    const updateSize = () => {
      setEventAlbumGridSize({
        width: node.clientWidth,
        height: node.clientHeight || 700,
      });
    };
    const handleScroll = () => {
      setEventAlbumScrollTop(node.scrollTop);
      onScrollPositionChange?.(node.scrollTop);
    };

    updateSize();
    handleScroll();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(node);
    node.addEventListener('scroll', handleScroll);
    return () => {
      resizeObserver.disconnect();
      node.removeEventListener('scroll', handleScroll);
    };
  }, [
    activeScrollRef,
    libraryMode,
    onScrollPositionChange,
    selectedEvent,
    availableEvents.length,
  ]);

  useEffect(() => {
    if (filePath && activeLibraryId) {
      loadPhotos();
      loadRoomData();
      loadAccountData();
      loadEventData();
      loadImageCommentsData();
    } else {
      setPhotos([]);
      setFeedPhotos([]);
      setProfileHistoryPhotos([]);
      setPhotoTotalCount(0);
      setRoomMap(new Map());
      setAccountMap(new Map());
      setEventMap(new Map());
      setImageComments([]);
    }
  }, [
    filePath,
    activeLibraryId,
    selectedEvent?.creatorAccountId,
    selectedEvent?.eventId,
    loadPhotos,
    loadRoomData,
    loadAccountData,
    loadEventData,
    loadImageCommentsData,
  ]);

  useEffect(() => {
    if (!activeLibraryId) {
      return;
    }

    if (libraryMode === 'room' || libraryMode === 'event') {
      setPhotoSource('photos');
      return;
    }
    if (photoSource === 'photos' && photos.length > 0) {
      return;
    }
    if (photoSource === 'feed' && feedPhotos.length > 0) {
      return;
    }
    if (photoSource === 'profile-history' && profileHistoryPhotos.length > 0) {
      return;
    }

    if (photos.length > 0) {
      setPhotoSource('photos');
      return;
    }
    if (feedPhotos.length > 0) {
      setPhotoSource('feed');
      return;
    }
    if (profileHistoryPhotos.length > 0) {
      setPhotoSource('profile-history');
    }
  }, [
    activeLibraryId,
    feedPhotos.length,
    libraryMode,
    photoSource,
    photos.length,
    profileHistoryPhotos.length,
  ]);

  // Reload photos + metadata periodically during download so names resolve.
  // Room mode uses a count-based trigger instead (see the effect below), so the
  // timer here only covers user/event libraries.
  useEffect(() => {
    if (!isDownloading || !activeLibraryId || !filePath) {
      return;
    }

    if (libraryMode === 'room') {
      return;
    }

    const interval = setInterval(() => {
      void loadPhotos();
      void loadRoomData();
      void loadAccountData();
      void loadEventData();
      void loadImageCommentsData();
      if (libraryMode === 'event') {
        void loadAvailableEvents();
      }
    }, 5000);

    return () => {
      clearInterval(interval);
    };
  }, [
    isDownloading,
    activeLibraryId,
    filePath,
    loadPhotos,
    loadRoomData,
    loadAccountData,
    loadEventData,
    loadImageCommentsData,
    loadAvailableEvents,
    libraryMode,
  ]);

  // Room mode: refresh the viewer once for every ROOM_PHOTO_REFRESH_IMAGE_INTERVAL
  // images downloaded, rather than on a fixed timer. `downloadedImageCount` is the
  // cumulative count shown as "Downloaded" in the Download Progress panel.
  useEffect(() => {
    if (libraryMode !== 'room') {
      return;
    }

    if (!isDownloading || !activeLibraryId || !filePath) {
      // Reset the baseline so the next run starts counting from zero.
      lastRefreshImageCountRef.current = downloadedImageCount;
      return;
    }

    // A new run restarts the cumulative counter; re-baseline if it went backwards.
    if (downloadedImageCount < lastRefreshImageCountRef.current) {
      lastRefreshImageCountRef.current = downloadedImageCount;
    }

    if (
      downloadedImageCount - lastRefreshImageCountRef.current >=
      ROOM_PHOTO_REFRESH_IMAGE_INTERVAL
    ) {
      lastRefreshImageCountRef.current = downloadedImageCount;
      void loadPhotos();
    }
  }, [
    libraryMode,
    isDownloading,
    activeLibraryId,
    filePath,
    downloadedImageCount,
    loadPhotos,
  ]);

  useEffect(() => {
    const wasDownloading = wasDownloadingRef.current;
    wasDownloadingRef.current = isDownloading;

    if (wasDownloading && !isDownloading && activeLibraryId && filePath) {
      void loadPhotos();
      void loadRoomData();
      void loadAccountData();
      void loadEventData();
      void loadImageCommentsData();
      if (libraryMode === 'event') {
        void loadAvailableEvents();
      }
    }
  }, [
    isDownloading,
    activeLibraryId,
    filePath,
    loadPhotos,
    loadRoomData,
    loadAccountData,
    loadEventData,
    loadImageCommentsData,
    loadAvailableEvents,
    libraryMode,
  ]);

  const handlePhotoClick = useCallback((photo: Photo) => {
    setSelectedPhoto(photo);
    setIsModalOpen(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const handleAccountChange = (newAccountId: string) => {
    setSelectedAccountId(newAccountId);
    setPhotoSource('photos');
    if (onAccountChange) {
      onAccountChange(newAccountId);
    }
  };

  const handleRoomChange = (newRoomId: string) => {
    setSelectedRoomId(newRoomId);
    setPhotoSource('photos');
    onRoomChange?.(newRoomId);
  };

  const handleEventCreatorChange = (newCreatorId: string) => {
    setSelectedEventCreatorId(newCreatorId);
    setSelectedEvent(null);
    setAvailableEvents([]);
    setPhotos([]);
    setEventAlbumScrollTop(0);
    onEventCreatorChange?.(newCreatorId);
  };

  const handleEventOpen = (event: AvailableEvent) => {
    if (!event.isDownloaded) {
      return;
    }
    setSelectedEvent(event);
    setSelectedEventCreatorId(event.creatorAccountId);
    onEventCreatorChange?.(event.creatorAccountId);
  };

  const handleBackToEvents = () => {
    setSelectedEvent(null);
    setPhotos([]);
  };

  const formatEventDate = (event: AvailableEvent): string => {
    if (!event.startTime) {
      return 'Date unknown';
    }
    return new Date(event.startTime).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const EVENT_ALBUM_MIN_WIDTH = 260;
  const EVENT_ALBUM_ROW_HEIGHT = 360;
  const EVENT_ALBUM_GAP = 16;
  const eventAlbumColumns = Math.max(
    1,
    Math.floor(
      (eventAlbumGridSize.width + EVENT_ALBUM_GAP) /
        (EVENT_ALBUM_MIN_WIDTH + EVENT_ALBUM_GAP)
    )
  );
  const eventAlbumRows = Math.ceil(availableEvents.length / eventAlbumColumns);
  const eventAlbumStartRow = Math.max(
    0,
    Math.floor(
      eventAlbumScrollTop / (EVENT_ALBUM_ROW_HEIGHT + EVENT_ALBUM_GAP)
    ) - 1
  );
  const eventAlbumEndRow = Math.min(
    eventAlbumRows,
    Math.ceil(
      (eventAlbumScrollTop + eventAlbumGridSize.height) /
        (EVENT_ALBUM_ROW_HEIGHT + EVENT_ALBUM_GAP)
    ) + 1
  );
  const visibleEventAlbums = useMemo(
    () =>
      availableEvents.slice(
        eventAlbumStartRow * eventAlbumColumns,
        Math.min(availableEvents.length, eventAlbumEndRow * eventAlbumColumns)
      ),
    [availableEvents, eventAlbumColumns, eventAlbumEndRow, eventAlbumStartRow]
  );
  const eventAlbumPaddingTop =
    eventAlbumStartRow * (EVENT_ALBUM_ROW_HEIGHT + EVENT_ALBUM_GAP);
  const eventAlbumPaddingBottom = Math.max(
    0,
    (eventAlbumRows - eventAlbumEndRow) *
      (EVENT_ALBUM_ROW_HEIGHT + EVENT_ALBUM_GAP)
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <div
        className={`sticky top-0 z-10 space-y-3 overflow-y-auto overscroll-contain bg-background/95 px-3 py-3 backdrop-blur transition-[transform,opacity,max-height] duration-300 sm:px-4 lg:px-6 ${
          isHeaderVisible
            ? 'max-h-[40vh] translate-y-0 opacity-100'
            : 'pointer-events-none max-h-0 -translate-y-full opacity-0'
        }`}
      >
        {libraryMode === 'room' && !viewerOnlyMode && (
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">Room photo download list</p>
                <p className="text-xs text-muted-foreground">
                  {myRoomsManifestRooms.length > 0
                    ? `${selectedMyRoomIds.length}/${myRoomsManifestRooms.length} selected`
                    : 'Choose myrooms.json or add rooms manually.'}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={
                  isRoomDownloadListCollapsed
                    ? 'Expand room photo download list'
                    : 'Collapse room photo download list'
                }
                onClick={() =>
                  setIsRoomDownloadListCollapsed(collapsed => !collapsed)
                }
              >
                {isRoomDownloadListCollapsed ? (
                  <ChevronDown className="mr-2 h-4 w-4" />
                ) : (
                  <ChevronUp className="mr-2 h-4 w-4" />
                )}
                {isRoomDownloadListCollapsed ? 'Show' : 'Hide'}
              </Button>
            </div>
            {!isRoomDownloadListCollapsed && (
              <>
                <div className="mt-3 flex flex-col gap-3 border-t pt-3 lg:flex-row lg:items-end">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Choose the myrooms.json file, add any other rooms, then
                      download every room album or only the rooms you select.
                    </p>
                    <Input
                      value={myRoomsManifestPath}
                      onChange={event =>
                        onMyRoomsManifestPathChange?.(event.target.value)
                      }
                      placeholder="Path to myrooms.json or its containing folder"
                      disabled={isDownloading}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isDownloading}
                      onClick={onSelectMyRoomsManifest}
                    >
                      Choose myrooms.json
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isDownloading}
                      onClick={onLoadMyRoomsManifest}
                    >
                      Load room list
                    </Button>
                    <Button
                      type="button"
                      disabled={isDownloading || !filePath.trim()}
                      onClick={onDownloadMyRooms}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Download all room photos
                    </Button>
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-medium">Add another room</p>
                    <Input
                      value={roomAddQuery}
                      onChange={event => setRoomAddQuery(event.target.value)}
                      placeholder="^RoomName or room ID"
                      disabled={isDownloading || isAddingMyRoom}
                      onKeyDown={event => {
                        if (event.key !== 'Enter') {
                          return;
                        }
                        event.preventDefault();
                        const query = roomAddQuery.trim();
                        if (!query || !onAddRoomToMyRooms) {
                          return;
                        }
                        void onAddRoomToMyRooms(query).then(added => {
                          if (added) {
                            setRoomAddQuery('');
                          }
                        });
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      isDownloading ||
                      isAddingMyRoom ||
                      !roomAddQuery.trim() ||
                      !onAddRoomToMyRooms
                    }
                    onClick={() => {
                      const query = roomAddQuery.trim();
                      if (!query || !onAddRoomToMyRooms) {
                        return;
                      }
                      void onAddRoomToMyRooms(query).then(added => {
                        if (added) {
                          setRoomAddQuery('');
                        }
                      });
                    }}
                  >
                    {isAddingMyRoom ? 'Adding...' : 'Add room'}
                  </Button>
                </div>
                {myRoomsManifestRooms.length > 0 && (
                  <div className="mt-3 space-y-2 border-t pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {selectedMyRoomIds.length}/{myRoomsManifestRooms.length}{' '}
                        selected
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isDownloading}
                        onClick={onSelectAllMyRooms}
                      >
                        Select all
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isDownloading}
                        onClick={onClearMyRoomsSelection}
                      >
                        Clear
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          isDownloading ||
                          !filePath.trim() ||
                          selectedMyRoomIds.length === 0
                        }
                        onClick={onDownloadSelectedMyRooms}
                      >
                        <Download className="mr-2 h-4 w-4" />
                        Download selected rooms
                      </Button>
                    </div>
                    <div className="grid max-h-44 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
                      {myRoomsManifestRooms.map(room => {
                        const roomId = String(room.RoomId ?? '').trim();
                        const roomName = (room.Name || roomId).trim();
                        const checked = selectedMyRoomIdSet.has(roomId);
                        return (
                          <label
                            key={roomId}
                            className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md border bg-background/70 p-2 text-sm"
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
                              checked={checked}
                              disabled={isDownloading}
                              onChange={event =>
                                onToggleMyRoomSelection?.(
                                  roomId,
                                  event.target.checked
                                )
                              }
                            />
                            <span className="min-w-0">
                              <span className="block truncate font-medium">
                                ^{roomName}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {roomId}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
                {!filePath.trim() && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                    Choose an output folder in Settings before downloading.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {showFullControls && (
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            {libraryMode === 'user' && availableAccounts.length > 0 && (
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <AccountSelect
                  availableAccounts={availableAccounts}
                  value={accountId}
                  accountMap={accountMap}
                  usernameMap={usernameMap}
                  onValueChange={handleAccountChange}
                  disabled={!!propAccountId}
                />
                {propAccountId && (
                  <span className="text-sm text-muted-foreground">
                    (Downloading...)
                  </span>
                )}
              </div>
            )}
            {libraryMode === 'room' && availableRooms.length > 0 && (
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <RoomSelect
                  availableRooms={availableRooms}
                  value={roomId}
                  onValueChange={handleRoomChange}
                  disabled={!!propRoomId}
                />
                {propRoomId && (
                  <span className="text-sm text-muted-foreground">
                    (Downloading...)
                  </span>
                )}
              </div>
            )}
            {libraryMode === 'event' && availableEventCreators.length > 0 && (
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Select
                  value={eventCreatorId}
                  onValueChange={handleEventCreatorChange}
                  disabled={!!propEventCreatorId}
                >
                  <SelectTrigger className="w-full sm:w-[280px]">
                    <SelectValue placeholder="Choose event creator" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableEventCreators.map(creator => (
                      <SelectItem
                        key={creator.creatorAccountId}
                        value={creator.creatorAccountId}
                      >
                        {creator.displayLabel} ({creator.downloadedEventCount}/
                        {creator.eventCount})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {propEventCreatorId && (
                  <span className="text-sm text-muted-foreground">
                    (Downloading...)
                  </span>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 md:justify-end">
              {hasPhotoSections && (
                <>
                  <span className="text-sm text-muted-foreground">Viewing</span>
                  {libraryMode === 'room' && hasUserPhotos && (
                    <Button size="sm" variant="default">
                      Room Photos ({photos.length})
                    </Button>
                  )}
                  {libraryMode === 'user' && hasUserPhotos && (
                    <Button
                      size="sm"
                      variant={photoSource === 'photos' ? 'default' : 'outline'}
                      onClick={() => setPhotoSource('photos')}
                    >
                      My Photos ({photos.length})
                    </Button>
                  )}
                  {libraryMode === 'user' && hasFeedPhotos && (
                    <Button
                      size="sm"
                      variant={photoSource === 'feed' ? 'default' : 'outline'}
                      onClick={() => setPhotoSource('feed')}
                    >
                      Feed ({feedPhotos.length})
                    </Button>
                  )}
                  {libraryMode === 'user' && hasProfileHistoryPhotos && (
                    <Button
                      size="sm"
                      variant={
                        photoSource === 'profile-history'
                          ? 'default'
                          : 'outline'
                      }
                      onClick={() => setPhotoSource('profile-history')}
                    >
                      Profile History ({profileHistoryPhotos.length})
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={showFavoritesOnly ? 'default' : 'outline'}
                    onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                    className={
                      showFavoritesOnly
                        ? 'bg-red-500 text-white hover:bg-red-600'
                        : ''
                    }
                  >
                    <Heart
                      className={`mr-2 h-4 w-4 ${showFavoritesOnly ? 'fill-current' : ''}`}
                    />
                    Favorites
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {(showFullControls || headerMode === 'compact') &&
          !(libraryMode === 'event' && !selectedEvent) && (
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-muted-foreground" />
                <Input
                  placeholder="Search photos..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select
                value={groupBy}
                onValueChange={(
                  value: 'none' | 'room' | 'user' | 'date' | 'event'
                ) => setGroupBy(value)}
              >
                <SelectTrigger className="w-full sm:w-[180px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Group by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Grouping</SelectItem>
                  <SelectItem value="room">Group by Room</SelectItem>
                  <SelectItem value="user">Group by User</SelectItem>
                  <SelectItem value="date">Group by Date</SelectItem>
                  <SelectItem value="event">Group by Event</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={sortBy}
                onValueChange={(
                  value:
                    | 'oldest-to-newest'
                    | 'newest-to-oldest'
                    | 'most-cheered'
                    | 'most-comments'
                ) => setSortBy(value)}
              >
                <SelectTrigger className="w-full sm:w-[200px]">
                  <ArrowUpDown className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="oldest-to-newest">
                    Oldest to Newest
                  </SelectItem>
                  <SelectItem value="newest-to-oldest">
                    Newest to Oldest
                  </SelectItem>
                  <SelectItem value="most-cheered">Most Cheered</SelectItem>
                  <SelectItem value="most-comments">Most Comments</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
      </div>

      <div className="flex-1 min-h-0">
        {libraryMode === 'event' && !selectedEvent ? (
          loadingAccounts ? (
            <div className="text-center py-12 text-muted-foreground">
              <p>Loading events...</p>
            </div>
          ) : availableEvents.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p>
                {viewerOnlyMode
                  ? 'No local event photo albums found.'
                  : 'No event albums found. Download event photos to get started.'}
              </p>
            </div>
          ) : (
            <div
              ref={activeScrollRef}
              className="h-full overflow-auto px-3 pb-4 sm:px-4 lg:px-6"
            >
              <div
                style={{
                  paddingTop: eventAlbumPaddingTop,
                  paddingBottom: eventAlbumPaddingBottom,
                }}
              >
                <div
                  className="grid gap-4"
                  style={{
                    gridTemplateColumns: `repeat(${eventAlbumColumns}, minmax(0, 1fr))`,
                  }}
                >
                  {visibleEventAlbums.map(event => (
                    <div
                      key={`${event.creatorAccountId}-${event.eventId}`}
                      className={`overflow-hidden rounded-md border bg-card transition ${
                        event.isDownloaded
                          ? 'cursor-pointer hover:shadow-md'
                          : 'border-dashed opacity-65'
                      }`}
                      onClick={() => handleEventOpen(event)}
                    >
                      <div className="aspect-video bg-muted">
                        <EventCoverImage
                          event={event}
                          cdnBase={cdnBase}
                          allowRemoteFallback={false}
                        />
                      </div>
                      <div className="space-y-3 p-4">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            {event.name}
                          </p>
                          {event.isDownloaded && event.photoCount > 0 ? (
                            <p className="text-xs text-muted-foreground">
                              Album downloaded
                            </p>
                          ) : !event.isDownloaded ? (
                            <p className="text-xs text-muted-foreground">
                              Photos not downloaded
                            </p>
                          ) : null}
                        </div>
                        <div className="grid grid-cols-1 gap-1 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3.5 w-3.5" />
                            {formatEventDate(event)}
                          </span>
                          <span className="flex items-center gap-1">
                            <Users className="h-3.5 w-3.5" />
                            {event.attendeeCount} attending
                          </span>
                          <span className="flex items-center gap-1">
                            <ImageIcon className="h-3.5 w-3.5" />
                            {!event.isDownloaded && event.photoCount === 0
                              ? 'Photo count unknown'
                              : event.photoCount > 0
                                ? `${event.downloadedPhotoCount}/${event.photoCount} photos`
                                : '0 photos'}
                          </span>
                        </div>
                        {!viewerOnlyMode && !event.isDownloaded && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full"
                            onClick={clickEvent => {
                              clickEvent.stopPropagation();
                              const creator = availableEventCreators.find(
                                c =>
                                  c.creatorAccountId === event.creatorAccountId
                              );
                              onOpenDownloadPanel?.({
                                kind: 'eventAlbum',
                                creatorAccountId: event.creatorAccountId,
                                eventId: event.eventId,
                                username: creator?.username,
                              });
                            }}
                          >
                            <Download className="mr-2 h-4 w-4" />
                            Download
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )
        ) : loadingAccounts ? (
          <div className="text-center py-12 text-muted-foreground">
            <p>Loading accounts...</p>
          </div>
        ) : libraryMode === 'user' &&
          !accountId &&
          availableAccounts.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p>
              {viewerOnlyMode
                ? 'No local account photo libraries found.'
                : 'No accounts with metadata found. Download photos to get started.'}
            </p>
          </div>
        ) : libraryMode === 'room' && !roomId && availableRooms.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p>
              {viewerOnlyMode
                ? 'No local room photo libraries found.'
                : 'No rooms with metadata found. Download room photos to get started.'}
            </p>
          </div>
        ) : loading ? (
          <div className="text-center py-12 text-muted-foreground">
            <p>Loading photos...</p>
          </div>
        ) : loadError ? (
          <div className="mx-auto max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-sm font-medium text-destructive">
              Could not load photos
            </p>
            <p className="mt-2 text-sm text-muted-foreground break-words">
              {loadError}
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button size="sm" onClick={() => void loadPhotos()}>
                Try again
              </Button>
              {onRevealOutputFolder && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onRevealOutputFolder}
                >
                  Open output folder
                </Button>
              )}
              {onOpenActivityMenu && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onOpenActivityMenu}
                >
                  Open activity and settings
                </Button>
              )}
            </div>
          </div>
        ) : activePhotoTotalCount === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            {libraryMode === 'event' && selectedEvent && (
              <Button
                size="sm"
                variant="outline"
                className="mb-4"
                onClick={handleBackToEvents}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to events
              </Button>
            )}
            <p>
              No {activeViewLabel} available for this{' '}
              {libraryMode === 'room'
                ? 'room'
                : libraryMode === 'event'
                  ? 'event'
                  : 'account'}
            </p>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col gap-3">
            {libraryMode === 'event' && selectedEvent && (
              <div className="px-3 sm:px-4 lg:px-6">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBackToEvents}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to events
                </Button>
              </div>
            )}
            {activePhotoTotalCount > PHOTO_VIEW_PAGE_SIZE && (
              <div className="flex flex-col gap-2 px-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-4 lg:px-6">
                <span>
                  Showing {formatCount(photoPageStart + 1)}-
                  {formatCount(
                    Math.min(
                      photoPageStart + PHOTO_VIEW_PAGE_SIZE,
                      activePhotoTotalCount
                    )
                  )}{' '}
                  of {formatCount(activePhotoTotalCount)}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={clampedPhotoPageIndex === 0}
                    onClick={() => {
                      roomPageWasManuallyChangedRef.current = false;
                      setPhotoPageIndex(0);
                      activeScrollRef.current?.scrollTo({ top: 0 });
                    }}
                    aria-label="First page"
                  >
                    <ChevronsLeft className="mr-2 h-4 w-4" />
                    First
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={clampedPhotoPageIndex === 0}
                    onClick={() => {
                      setPhotoPageIndex(pageIndex => {
                        const nextPageIndex = Math.max(0, pageIndex - 1);
                        roomPageWasManuallyChangedRef.current =
                          nextPageIndex > 0;
                        return nextPageIndex;
                      });
                      activeScrollRef.current?.scrollTo({ top: 0 });
                    }}
                  >
                    Previous 100
                  </Button>
                  <span className="text-xs">
                    Page {formatCount(clampedPhotoPageIndex + 1)} /{' '}
                    {formatCount(totalPhotoPages)}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={clampedPhotoPageIndex >= totalPhotoPages - 1}
                    onClick={() => {
                      setPhotoPageIndex(pageIndex => {
                        const nextPageIndex = Math.min(
                          totalPhotoPages - 1,
                          pageIndex + 1
                        );
                        roomPageWasManuallyChangedRef.current =
                          nextPageIndex > 0;
                        return nextPageIndex;
                      });
                      activeScrollRef.current?.scrollTo({ top: 0 });
                    }}
                  >
                    Next 100
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={clampedPhotoPageIndex >= totalPhotoPages - 1}
                    onClick={() => {
                      roomPageWasManuallyChangedRef.current =
                        totalPhotoPages - 1 > 0;
                      setPhotoPageIndex(totalPhotoPages - 1);
                      activeScrollRef.current?.scrollTo({ top: 0 });
                    }}
                    aria-label="Last page"
                  >
                    Last
                    <ChevronsRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
            <PhotoGrid
              photos={visiblePhotoPage}
              onPhotoClick={handlePhotoClick}
              groupBy={groupBy}
              searchQuery={libraryMode === 'room' ? '' : searchQuery}
              sortBy={libraryMode === 'room' ? undefined : sortBy}
              roomMap={roomMap}
              accountMap={accountMap}
              eventMap={eventMap}
              cdnBase={cdnBase}
              allowRemoteImages={false}
              onScrollPositionChange={onScrollPositionChange}
              scrollContainerRef={activeScrollRef}
              accountId={accountId}
              useProvidedOrder={libraryMode === 'room'}
            />
          </div>
        )}
      </div>

      <PhotoDetailModal
        photo={selectedPhoto}
        open={isModalOpen}
        onClose={handleCloseModal}
        roomMap={roomMap}
        accountMap={accountMap}
        usernameMap={usernameMap}
        accountProfileImageMap={accountProfileImageMap}
        eventMap={eventMap}
        cdnBase={cdnBase}
        imageComments={imageComments}
        allowRemoteImages={false}
      />
    </div>
  );
};
