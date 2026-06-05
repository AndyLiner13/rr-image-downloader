import { ArrowUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_CDN_BASE } from '../shared/cdnUrl';
import {
    DEFAULT_DOWNLOAD_SOURCE_SELECTION,
    DownloadSourceSelection,
    getSelectedDownloadSources,
} from '../shared/download-sources';
import {
    BulkDataRefreshOptions,
    DownloadPreflightSummary,
    DownloadResult,
    EventDownloadIntent,
    EventDownloadPanelPrefill,
    EventPhotoBatchResult,
    LibraryMode,
    MetadataSyncState,
    Progress,
    RecNetSettings,
    RoomDto,
    RoomPhotoBatchResult,
    RoomPhotoQueueProgress,
    RoomPhotoSort,
    UserFacingIncident,
} from '../shared/types';
import {
    getViewerOnlyCutoffDate,
    isViewerOnlyMode,
} from '../shared/viewer-only-mode';
import { CustomTitleBar } from './components/CustomTitleBar';
import { DownloadPanel } from './components/DownloadPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ErrorRecoveryBanner } from './components/ErrorRecoveryBanner';
import { LibraryMoveDialog } from './components/LibraryMoveDialog';
import { PhotoViewer } from './components/PhotoViewer';
import { ProgressDisplay } from './components/ProgressDisplay';
import { StatsDialog } from './components/StatsDialog';
import { Button } from './components/ui/button';
import { FavoritesProvider } from './contexts/FavoritesContext';
import {
    buildDownloadProgressIncident,
    getDownloadProgressLogEntries,
} from './utils/downloadProgressFeedback';
import {
    classifyError,
    createOutputFolderUnavailableIncident,
    createUserIncident,
    toOperationErrorData,
} from './utils/errorPresentation';

interface DownloadRequestState {
  username: string;
  roomName: string;
  libraryMode: LibraryMode;
  token: string;
  filePath: string;
  downloadSources: DownloadSourceSelection;
  roomPhotoSort: RoomPhotoSort;
  eventIds?: string[];
  knownCreatorAccountId?: string;
  refreshOptions: BulkDataRefreshOptions;
}

interface PendingDownloadPreflight {
  accountId: string;
  request: DownloadRequestState;
  summary: DownloadPreflightSummary;
}

const EMPTY_DOWNLOAD_STEP = 'Nothing to download';
const CLEAN_DOWNLOAD_FOLLOW_UP =
  'If you take more photos in Rec Room, come back and run this download again. The app will only grab anything new.';
const VIEWER_ONLY_RECHECK_MS = 60 * 60 * 1000;
const DEFAULT_MYROOMS_MANIFEST_PATH = '';

/** Set to true to allow starting a library move from the debug menu. */
const LIBRARY_MOVE_ENABLED = false;

function App() {
  const [viewerOnlyMode, setViewerOnlyMode] = useState(() =>
    isViewerOnlyMode()
  );
  const [settings, setSettings] = useState<RecNetSettings>({
    outputRoot: '',
    cdnBase: DEFAULT_CDN_BASE,
    interPageDelayMs: 100,
    maxConcurrentDownloads: 3,
    backgroundMetadataSyncEnabled: true,
  });

  const [progress, setProgress] = useState<Progress>({
    isRunning: false,
    phase: 'complete',
    currentStep: 'Ready',
    progress: 0,
    total: 0,
    current: 0,
    statusLevel: 'info',
    issueCount: 0,
    retryAttempts: 0,
    failedItems: 0,
    recoveredAfterRetry: 0,
  });

  const [currentAccountId, setCurrentAccountId] = useState<string>('');
  const [currentRoomId, setCurrentRoomId] = useState<string>('');
  const [currentEventCreatorId, setCurrentEventCreatorId] =
    useState<string>('');
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('user');
  const [downloadPanelOpen, setDownloadPanelOpen] = useState(false);
  const [eventDownloadPanelPrefill, setEventDownloadPanelPrefill] =
    useState<EventDownloadPanelPrefill | null>(null);
  const [statsDialogOpen, setStatsDialogOpen] = useState(false);
  const [debugMenuOpen, setDebugMenuOpen] = useState(false);
  const [metadataSyncPhase, setMetadataSyncPhase] = useState<
    'idle' | 'running'
  >('idle');
  const [metadataSyncState, setMetadataSyncState] = useState<MetadataSyncState>(
    {
      phase: 'idle',
    }
  );
  const [myRoomsManifestPath, setMyRoomsManifestPath] = useState(
    DEFAULT_MYROOMS_MANIFEST_PATH
  );
  const [myRoomsManifestRooms, setMyRoomsManifestRooms] = useState<RoomDto[]>(
    []
  );
  const [additionalMyRooms, setAdditionalMyRooms] = useState<RoomDto[]>([]);
  const [selectedMyRoomIds, setSelectedMyRoomIds] = useState<string[]>([]);
  const [isAddingMyRoom, setIsAddingMyRoom] = useState(false);
  const combinedMyRoomRooms = useMemo(() => {
    const roomsById = new Map<string, RoomDto>();
    for (const room of [...myRoomsManifestRooms, ...additionalMyRooms]) {
      const roomId = String(room.RoomId ?? '').trim();
      if (roomId) {
        roomsById.set(roomId, room);
      }
    }
    return Array.from(roomsById.values()).sort((roomA, roomB) =>
      (roomA.Name || String(roomA.RoomId)).localeCompare(
        roomB.Name || String(roomB.RoomId)
      )
    );
  }, [additionalMyRooms, myRoomsManifestRooms]);
  const [libraryMoveDialogOpen, setLibraryMoveDialogOpen] = useState(false);
  const [resultsScrollRequestId, setResultsScrollRequestId] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [headerMode, setHeaderMode] = useState<'full' | 'compact' | 'hidden'>(
    'full'
  );
  const [showProgressPanel, setShowProgressPanel] = useState(true);
  const [hasScrolledDown, setHasScrolledDown] = useState(false);
  const [hasScrolledPhotos, setHasScrolledPhotos] = useState(false);
  const scrollPositionRef = useRef(0);
  const photoScrollRef = useRef<HTMLDivElement | null>(null);
  const previousProgressRef = useRef<Progress | null>(null);
  const stopRoomLoopRef = useRef(false);
  const roomPhotoQueueRef = useRef<RoomPhotoQueueProgress | null>(null);
  const [logs, setLogs] = useState<
    Array<{
      message: string;
      type: 'info' | 'success' | 'error' | 'warning';
      timestamp: string;
    }>
  >([]);
  const [results, setResults] = useState<
    Array<{
      operation: string;
      data: unknown;
      type: 'success' | 'error';
      timestamp: string;
    }>
  >([]);
  const [downloadDraft, setDownloadDraft] =
    useState<DownloadRequestState | null>(null);
  const [pendingPreflight, setPendingPreflight] =
    useState<PendingDownloadPreflight | null>(null);
  const [lastDownloadRequest, setLastDownloadRequest] =
    useState<DownloadRequestState | null>(null);
  const [activeIncident, setActiveIncident] =
    useState<UserFacingIncident | null>(null);

  useEffect(() => {
    loadSettings();
    setupProgressMonitoring();
  }, []);

  useEffect(() => {
    if (viewerOnlyMode) {
      setDownloadPanelOpen(false);
      setPendingPreflight(null);
      if (isDownloading) {
        void window.electronAPI?.cancelOperation?.();
      }
      return;
    }

    const delayMs = Math.min(
      Math.max(getViewerOnlyCutoffDate().getTime() - Date.now(), 0),
      VIEWER_ONLY_RECHECK_MS
    );
    const timeout = window.setTimeout(() => {
      setViewerOnlyMode(isViewerOnlyMode());
      setDownloadPanelOpen(false);
      setPendingPreflight(null);
    }, delayMs);

    return () => window.clearTimeout(timeout);
  }, [isDownloading, viewerOnlyMode]);

  useEffect(() => {
    if (!window.electronAPI?.onMetadataSyncState) {
      return;
    }
    const handler = (_event: unknown, state: MetadataSyncState) => {
      setMetadataSyncPhase(state.phase);
      setMetadataSyncState(previous =>
        state.phase === 'running' ? { ...previous, ...state } : state
      );
    };
    window.electronAPI.onMetadataSyncState(handler);
    return () => {
      window.electronAPI.removeMetadataSyncStateListener(handler);
    };
  }, []);

  useEffect(() => {
    if (progress.isRunning) {
      setShowProgressPanel(true);
    }
  }, [progress.isRunning]);

  useEffect(() => {
    if (currentAccountId) {
      loadPhotosForAccount(currentAccountId);
    }
  }, [currentAccountId, settings.outputRoot]);

  const loadSettings = async () => {
    try {
      if (window.electronAPI) {
        const loadedSettings = await window.electronAPI.getSettings();
        setSettings(loadedSettings);
        if (loadedSettings.outputRootUnavailableMessage) {
          addLog(
            `Saved output folder unavailable: ${loadedSettings.outputRootUnavailableMessage}`,
            'warning'
          );
          setActiveIncident(
            createOutputFolderUnavailableIncident(
              loadedSettings.outputRoot,
              loadedSettings.outputRootUnavailableMessage
            )
          );
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      addLog(`Failed to load settings: ${msg}`, 'error');
      setActiveIncident(createUserIncident('settings', msg));
    }
  };

  const setupProgressMonitoring = () => {
    if (window.electronAPI) {
      window.electronAPI.onProgress((event, progressData) => {
        setProgress(() => {
          const queue = roomPhotoQueueRef.current;
          if (
            queue &&
            progressData.isRunning &&
            progressData.currentSource === 'room-photos'
          ) {
            const enhancedQueue: RoomPhotoQueueProgress = {
              ...queue,
              currentBatchCurrent: progressData.current,
              currentBatchTotal: progressData.total,
              currentBatchProgress: progressData.progress,
              currentBatchLabel:
                progressData.phase === 'metadata'
                  ? progressData.pageLabel || 'Scanning pages'
                  : 'Downloading images',
            };
            return {
              ...progressData,
              currentStep: queue.message || progressData.currentStep,
              total: queue.totalRooms,
              current: queue.roomsCompleted,
              progress:
                queue.totalRooms > 0
                  ? Math.round((queue.roomsCompleted / queue.totalRooms) * 100)
                  : progressData.progress,
              pageLabel: progressData.pageLabel,
              activeItemLabel:
                queue.currentRoomName || progressData.activeItemLabel,
              recentActivity: queue.message || progressData.recentActivity,
              roomPhotoQueue: enhancedQueue,
            };
          }
          return progressData;
        });
        if (
          progressData.statusLevel !== 'info' ||
          progressData.issueCount > 0
        ) {
          setShowProgressPanel(true);
        }
      });
    }
  };

  const loadPhotosForAccount = async (accountId: string) => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.loadPhotos(accountId);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      addLog(`Failed to load photos for account ${accountId}: ${msg}`, 'error');
      setActiveIncident(createUserIncident('photos', msg));
    }
  };

  const updateSettings = async (newSettings: Partial<RecNetSettings>) => {
    try {
      if (window.electronAPI) {
        const updatedSettings =
          await window.electronAPI.updateSettings(newSettings);
        setSettings(updatedSettings);
        if (!updatedSettings.outputRootUnavailableMessage) {
          setActiveIncident(prev =>
            prev?.title === 'Saved output folder unavailable' ? null : prev
          );
        }
        addLog('Settings updated', 'success');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addLog(`Failed to update settings: ${msg}`, 'error');
      setActiveIncident(createUserIncident('updateSettings', msg));
    }
  };

  const addLog = useCallback(
    (
      message: string,
      type: 'info' | 'success' | 'error' | 'warning' = 'info'
    ) => {
      const timestamp = new Date().toLocaleTimeString();
      setLogs(prev => [...prev.slice(-99), { message, type, timestamp }]);
    },
    []
  );

  const handleForceMetadataSync = useCallback(async () => {
    if (!window.electronAPI?.syncMetadataAssets) {
      return;
    }
    addLog('Running metadata image sync (force)...', 'info');
    try {
      const result = await window.electronAPI.syncMetadataAssets({
        force: true,
      });
      if (result.success && result.data) {
        addLog(
          `Metadata sync finished: ${result.data.accountsProcessed} user library folder(s), ${result.data.creatorsProcessed} event creator(s), ${result.data.eventsProcessed} event album(s), ${result.data.roomsProcessed} room folder(s).`,
          'success'
        );
      } else {
        addLog(result.error ?? 'Metadata sync failed', 'error');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addLog(`Metadata sync failed: ${msg}`, 'error');
    }
  }, [addLog]);

  const dismissIncident = useCallback(() => setActiveIncident(null), []);

  const clearPhotosIncident = useCallback(() => {
    setActiveIncident(prev => (prev?.source === 'photos' ? null : prev));
  }, []);

  const handleOpenPathInExplorer = useCallback(async (folderPath: string) => {
    if (!window.electronAPI?.openPathInExplorer) {
      return;
    }
    const r = await window.electronAPI.openPathInExplorer(folderPath);
    if (!r.success) {
      const timestamp = new Date().toLocaleTimeString();
      setLogs(prev => [
        ...prev.slice(-99),
        {
          message: r.error ?? 'Could not open folder',
          type: 'error' as const,
          timestamp,
        },
      ]);
    }
  }, []);

  const addResult = useCallback(
    (operation: string, data: unknown, type: 'success' | 'error') => {
      const timestamp = new Date().toLocaleString();
      setResults(prev => [
        { operation, data, type, timestamp },
        ...prev.slice(0, 9),
      ]);
    },
    []
  );

  const reportDownloadResult = useCallback(
    (params: {
      operation: string;
      label: string;
      result: DownloadResult;
      directoryPath?: string;
      directoryLabel?: string;
      manifestPath?: string;
    }) => {
      const {
        directoryLabel,
        directoryPath,
        label,
        manifestPath,
        operation,
        result,
      } = params;
      const stats = result.downloadStats;

      addLog(
        stats.failedDownloads > 0
          ? `${label} complete with warnings: ${stats.newDownloads} new, ${stats.alreadyDownloaded} existing, ${stats.failedDownloads} missed after retries`
          : `${label} complete: ${stats.newDownloads} new, ${stats.alreadyDownloaded} existing, ${stats.failedDownloads} failed`,
        stats.failedDownloads > 0 ? 'warning' : 'success'
      );

      if (stats.retryAttempts > 0) {
        addLog(
          stats.failedDownloads > 0
            ? `Retried ${label.toLowerCase()} ${stats.retryAttempts} time(s) across failed attempts. ${stats.recoveredAfterRetry} file(s) recovered automatically.`
            : `Retried ${label.toLowerCase()} ${stats.retryAttempts} time(s) and recovered ${stats.recoveredAfterRetry} file(s) automatically.`,
          stats.failedDownloads > 0 ? 'warning' : 'info'
        );
      }

      if (directoryPath && directoryLabel) {
        addLog(`${directoryLabel}: ${directoryPath}`, 'info');
      }
      if (manifestPath) {
        addLog(`Profile history manifest saved to: ${manifestPath}`, 'info');
      }

      result.guidance?.forEach(message => addLog(message, 'warning'));
      addResult(operation, result, 'success');
    },
    [addLog, addResult]
  );

  const setCleanCompletionProgress = useCallback(
    (currentStep: string, recentActivity = CLEAN_DOWNLOAD_FOLLOW_UP) => {
      setProgress(prev => ({
        ...prev,
        isRunning: false,
        phase: 'complete',
        currentStep,
        progress: 100,
        total: 0,
        current: 0,
        statusLevel: 'info',
        issueCount: 0,
        retryAttempts: 0,
        failedItems: 0,
        recoveredAfterRetry: 0,
        currentSource: undefined,
        pageLabel: undefined,
        activeItemLabel: undefined,
        recentActivity,
        lastIssue: undefined,
        confirmation: undefined,
        roomPhotoQueue: undefined,
      }));
    },
    []
  );

  const setConfirmationProgress = useCallback(
    (summary: DownloadPreflightSummary) => {
      setProgress(prev => ({
        ...prev,
        isRunning: false,
        phase: 'confirm',
        currentStep:
          'Metadata is ready. Review this download before continuing.',
        progress: 100,
        total: summary.totalRemainingToDownload,
        current: 0,
        statusLevel: 'info',
        issueCount: 0,
        retryAttempts: 0,
        failedItems: 0,
        recoveredAfterRetry: 0,
        currentSource: undefined,
        pageLabel: undefined,
        activeItemLabel: undefined,
        recentActivity: undefined,
        lastIssue: undefined,
        confirmation: summary,
        roomPhotoQueue: undefined,
      }));
    },
    []
  );

  const clearLogs = () => {
    setLogs([]);
    setResults([]);
    setActiveIncident(null);
  };

  const applyRoomPhotoQueueProgress = useCallback(
    (queue: RoomPhotoQueueProgress) => {
      roomPhotoQueueRef.current = queue;
      setProgress(prev => ({
        ...prev,
        isRunning: true,
        phase: 'download',
        currentStep: queue.message || 'Downloading room photo queue...',
        progress:
          queue.totalRooms > 0
            ? Math.round((queue.roomsCompleted / queue.totalRooms) * 100)
            : 0,
        total: queue.totalRooms,
        current: queue.roomsCompleted,
        statusLevel:
          queue.failedDownloads > 0 || prev.statusLevel === 'error'
            ? 'warning'
            : 'info',
        currentSource: 'room-photos',
        pageLabel: queue.currentBatch
          ? `Batch ${queue.currentBatch}`
          : 'Room queue',
        activeItemLabel: queue.currentRoomName,
        recentActivity: queue.message,
        confirmation: undefined,
        roomPhotoQueue: queue,
      }));
    },
    []
  );

  const openOperationResults = useCallback(() => {
    setDebugMenuOpen(true);
    setResultsScrollRequestId(prev => prev + 1);
  }, []);

  const handleDownloadDraftChange = useCallback(
    (draft: DownloadRequestState) => {
      setDownloadDraft(draft);
    },
    []
  );

  const retryRequest = downloadDraft ?? lastDownloadRequest;
  const canRetryDownload = Boolean(
    !viewerOnlyMode &&
      retryRequest?.filePath.trim() &&
      (() => {
        const r = retryRequest;
        if (!r) return false;
        if (r.libraryMode === 'event') {
          return (
            (r.eventIds?.length ?? 0) > 0 &&
            (!!r.username.trim() || !!r.knownCreatorAccountId?.trim())
          );
        }
        return r.username.trim().length > 0;
      })()
  );

  const isProgressIdle =
    !progress.isRunning &&
    Math.min(Math.max(Math.round(progress.progress ?? 0), 0), 100) === 0 &&
    (!progress.currentStep || progress.currentStep === 'Ready');

  useEffect(() => {
    const previousProgress = previousProgressRef.current;

    if (previousProgress) {
      getDownloadProgressLogEntries(previousProgress, progress).forEach(
        entry => {
          addLog(entry.message, entry.type);
        }
      );

      const progressChanged =
        progress.issueCount !== previousProgress.issueCount ||
        progress.retryAttempts !== previousProgress.retryAttempts ||
        progress.failedItems !== previousProgress.failedItems ||
        progress.recoveredAfterRetry !== previousProgress.recoveredAfterRetry ||
        progress.lastIssue !== previousProgress.lastIssue ||
        progress.isRunning !== previousProgress.isRunning ||
        progress.currentStep !== previousProgress.currentStep;
      const hasRetryDrivenState =
        progress.retryAttempts > 0 ||
        progress.recoveredAfterRetry > 0 ||
        previousProgress.retryAttempts > 0 ||
        previousProgress.recoveredAfterRetry > 0;

      if (progressChanged && hasRetryDrivenState) {
        const incident = buildDownloadProgressIncident(progress);
        if (incident) {
          setActiveIncident(incident);
        } else {
          setActiveIncident(prev =>
            prev?.source === 'download' ? null : prev
          );
        }
      }
    }

    previousProgressRef.current = progress;
  }, [addLog, progress]);

  const handleDownload = async (
    username: string,
    token: string,
    filePath: string,
    downloadSources: DownloadSourceSelection,
    refreshOptions: BulkDataRefreshOptions = {},
    roomPhotoSort: RoomPhotoSort = 0,
    eventIds: string[] = [],
    knownCreatorAccountId?: string
  ) => {
    if (viewerOnlyMode) {
      return;
    }

    const selectedSources = getSelectedDownloadSources(downloadSources);
    const trimmedUser = username.trim();
    const trimmedCreator = knownCreatorAccountId?.trim();
    if (!filePath.trim()) {
      return;
    }
    if (libraryMode === 'user' && selectedSources.length === 0) {
      return;
    }
    if (libraryMode === 'event') {
      if (eventIds.length === 0) {
        return;
      }
      if (!trimmedUser && !trimmedCreator) {
        return;
      }
    } else if (!trimmedUser) {
      return;
    }

    setActiveIncident(null);
    setPendingPreflight(null);

    const {
      forceAccountsRefresh = false,
      forceRoomsRefresh = false,
      forceEventsRefresh = false,
      forceImageCommentsRefresh = false,
    } = refreshOptions;
    const requestState: DownloadRequestState = {
      username,
      roomName: libraryMode === 'room' ? username : '',
      libraryMode,
      token,
      filePath,
      downloadSources,
      roomPhotoSort,
      eventIds,
      knownCreatorAccountId: trimmedCreator,
      refreshOptions: {
        forceAccountsRefresh,
        forceRoomsRefresh,
        forceEventsRefresh,
        forceImageCommentsRefresh,
      },
    };

    setLastDownloadRequest(requestState);

    roomPhotoQueueRef.current = null;
    setIsDownloading(true);
    addLog(
      libraryMode === 'room'
        ? `Starting room photo collection for room: ${username}`
        : libraryMode === 'event' && trimmedCreator
          ? `Starting event photo download${trimmedUser ? ` for @${trimmedUser}` : ''}...`
          : `Starting metadata collection for username: ${username}`,
      'info'
    );
    setProgress({
      isRunning: true,
      phase: 'metadata',
      currentStep: 'Starting metadata collection...',
      progress: 0,
      total: 0,
      current: 0,
      statusLevel: 'info',
      issueCount: 0,
      retryAttempts: 0,
      failedItems: 0,
      recoveredAfterRetry: 0,
      currentSource: undefined,
      pageLabel: undefined,
      activeItemLabel: undefined,
      recentActivity: 'Preparing download metadata...',
      confirmation: undefined,
      roomPhotoQueue: undefined,
    });

    try {
      // Update settings with new file path
      if (window.electronAPI) {
        const updatedSettings = await window.electronAPI.updateSettings({
          outputRoot: filePath,
        });
        setSettings(updatedSettings);
        addLog(`Output path set to: ${filePath}`, 'info');

        if (libraryMode === 'event') {
          if (eventIds.length === 0) {
            throw new Error('Choose at least one event to download.');
          }

          let usernameForDiscover = trimmedUser;
          if (!usernameForDiscover && trimmedCreator) {
            const lookup =
              await window.electronAPI.lookupAccountById(trimmedCreator);
            if (lookup.success && lookup.data?.username) {
              usernameForDiscover = lookup.data.username.trim();
            }
          }
          if (!usernameForDiscover) {
            throw new Error(
              'Could not resolve a username to save event metadata. Enter a username or try again.'
            );
          }

          addLog(`Saving event list for @${usernameForDiscover}...`, 'info');
          const discoveryResult =
            await window.electronAPI.discoverEventsForUsername({
              username: usernameForDiscover,
              token: token.trim() || undefined,
              persist: true,
            });
          if (!discoveryResult.success || !discoveryResult.data) {
            throw new Error(
              discoveryResult.error || 'Could not load events for this user'
            );
          }

          const creatorAccountId = discoveryResult.data.creatorAccountId;
          addLog(
            `Found ${discoveryResult.data.events.length} event(s) for @${discoveryResult.data.username}.`,
            'success'
          );

          setCurrentEventCreatorId(creatorAccountId);

          const eventResult: {
            success: boolean;
            data?: EventPhotoBatchResult;
            error?: string;
          } = await window.electronAPI.downloadEventPhotos({
            creatorAccountId,
            eventIds,
            token: token.trim() || undefined,
          });
          if (!eventResult.success || !eventResult.data) {
            throw new Error(
              eventResult.error || 'Failed to download event photos'
            );
          }

          addResult('Event Photos', eventResult.data, 'success');
          addLog(
            `Event photo download complete: ${eventResult.data.downloadStats.newDownloads} downloaded, ${eventResult.data.downloadStats.alreadyDownloaded} already on disk.`,
            eventResult.data.downloadStats.failedDownloads > 0
              ? 'warning'
              : 'success'
          );
          setCleanCompletionProgress('Completed event photo download');
          return;
        }

        if (libraryMode === 'room') {
          stopRoomLoopRef.current = false;
          const roomPhotoSortLabel =
            roomPhotoSort === 1 ? 'most cheered first' : 'newest first';
          addLog(`Searching for room: ${username}`, 'info');
          const roomResult = await window.electronAPI.lookupRoomByName({
            roomName: username,
            token: token.trim() || undefined,
          });
          if (!roomResult.success || !roomResult.data) {
            throw new Error(roomResult.error || 'Room not found');
          }

          const room = roomResult.data;
          const roomId = room.RoomId.toString();
          setCurrentRoomId(roomId);
          addLog(
            `Found room: ${room.Name} (ID: ${roomId}). Fetching ${roomPhotoSortLabel}.`,
            'success'
          );

          let startSkip: number | undefined = undefined;
          let batchIndex = 0;
          let latestBatch: RoomPhotoBatchResult | null = null;
          while (!stopRoomLoopRef.current) {
            batchIndex++;
            addLog(`Collecting room photo batch ${batchIndex}...`, 'info');
            const batchResult: {
              success: boolean;
              data?: RoomPhotoBatchResult;
              error?: string;
            } = await window.electronAPI.downloadRoomPhotoBatch({
              roomName: username,
              token: token.trim() || undefined,
              startSkip,
              batchPages: 10,
              pageSize: 100,
              sort: roomPhotoSort,
              forceAccountsRefresh,
              forceRoomsRefresh,
              forceEventsRefresh,
              forceImageCommentsRefresh,
            });

            if (!batchResult.success || !batchResult.data) {
              throw new Error(
                batchResult.error || 'Failed to download room photo batch'
              );
            }

            const batchData = batchResult.data;
            latestBatch = batchData;
            startSkip = batchData.nextSkip;
            addResult('Room Photos Batch', batchData, 'success');
            const skippedPreviouslyScanned =
              batchData.previouslyScannedPhotosSkipped ?? 0;
            const headPhotosChecked = batchData.headPhotosChecked ?? 0;
            const resumeDetails =
              skippedPreviouslyScanned > 0
                ? ` Checked ${headPhotosChecked} latest image(s), then skipped ${skippedPreviouslyScanned} already-scanned image(s) to resume older photos.`
                : headPhotosChecked > 0
                  ? ` Checked ${headPhotosChecked} latest image(s) before continuing.`
                  : '';
            addLog(
              `Room batch ${batchIndex} complete: started at skip ${batchData.startSkip.toLocaleString()}, ${batchData.newPhotosAdded} new metadata record(s), ${batchData.downloadStats.newDownloads} downloaded.${resumeDetails}`,
              batchData.downloadStats.failedDownloads > 0
                ? 'warning'
                : 'success'
            );

            if (!batchData.hasMore) {
              break;
            }
          }

          if (latestBatch) {
            addLog(
              stopRoomLoopRef.current
                ? 'Room photo gathering stopped.'
                : 'Room photo gathering complete.',
              stopRoomLoopRef.current ? 'warning' : 'success'
            );
            setCleanCompletionProgress(
              stopRoomLoopRef.current
                ? 'Stopped room photo gathering'
                : 'Completed room photo gathering'
            );
          }
          return;
        }

        // Search for account by username
        addLog(`Searching for account: ${username}`, 'info');
        const searchResult = await window.electronAPI.lookupAccountByUsername(
          username,
          token.trim() || undefined
        );
        if (!searchResult.success || !searchResult.data) {
          throw new Error('Account not found');
        }

        const account = searchResult.data;
        const accountId = account.accountId.toString();
        setCurrentAccountId(accountId);
        addLog(
          `Found account: ${account.displayName} (ID: ${accountId})`,
          'success'
        );
        if (
          downloadSources.downloadUserFeed ||
          downloadSources.downloadUserPhotos
        ) {
          addLog(
            forceAccountsRefresh
              ? 'Forcing refresh of user data for this download'
              : 'Using existing user data if present',
            'info'
          );
          addLog(
            forceRoomsRefresh
              ? 'Forcing refresh of room data for this download'
              : 'Using existing room data if present',
            'info'
          );
          addLog(
            forceEventsRefresh
              ? 'Forcing refresh of event data for this download'
              : 'Using existing event data if present',
            'info'
          );
          addLog(
            forceImageCommentsRefresh
              ? 'Forcing refresh of image comment data for this download'
              : 'Using existing image comment data if present',
            'info'
          );
        }

        for (const source of selectedSources) {
          if (source === 'user-feed') {
            addLog('Collecting feed photos metadata...', 'info');
            const collectFeedResult =
              await window.electronAPI.collectFeedPhotos({
                accountId,
                token: token.trim() || undefined,
                incremental: true,
                forceAccountsRefresh,
                forceRoomsRefresh,
                forceEventsRefresh,
                forceImageCommentsRefresh,
              });

            if (!collectFeedResult.success) {
              throw new Error(
                collectFeedResult.error || 'Failed to collect feed photos'
              );
            }

            const totalFeedPhotos = collectFeedResult.data?.totalPhotos || 0;
            addLog(
              `Collected feed metadata for ${totalFeedPhotos} image(s).`,
              'success'
            );
            continue;
          }

          if (source === 'user-photos') {
            addLog('Collecting user photos metadata...', 'info');
            const collectPhotosResult = await window.electronAPI.collectPhotos({
              accountId,
              token: token.trim() || undefined,
              forceAccountsRefresh,
              forceRoomsRefresh,
              forceEventsRefresh,
              forceImageCommentsRefresh,
            });

            if (!collectPhotosResult.success) {
              throw new Error(
                collectPhotosResult.error || 'Failed to collect photos'
              );
            }

            const totalPhotos = collectPhotosResult.data?.totalPhotos || 0;
            addLog(
              `Collected user photo metadata for ${totalPhotos} image(s).`,
              'success'
            );
            continue;
          }

          if (source === 'profile-history') {
            if (!token.trim()) {
              throw new Error(
                'Profile picture history requires a valid access token.'
              );
            }

            addLog('Collecting profile picture history metadata...', 'info');
            const collectProfileHistoryResult =
              await window.electronAPI.collectProfileHistoryManifest({
                accountId,
                token: token.trim(),
              });

            if (
              !collectProfileHistoryResult.success ||
              !collectProfileHistoryResult.data
            ) {
              throw new Error(
                collectProfileHistoryResult.error ||
                  'Failed to collect profile picture history metadata'
              );
            }

            addLog(
              `Collected profile picture history metadata for ${
                collectProfileHistoryResult.data.totalPhotos || 0
              } image(s).`,
              'success'
            );
          }
        }

        const preflightResult = await window.electronAPI.buildDownloadPreflight(
          {
            accountId,
            downloadSources,
          }
        );

        if (!preflightResult.success || !preflightResult.data) {
          throw new Error(
            preflightResult.error || 'Failed to prepare the download summary'
          );
        }

        const summary = preflightResult.data;
        setShowProgressPanel(true);
        setActiveIncident(null);

        if (summary.totalRemainingToDownload === 0) {
          addLog(
            'Metadata saved. Everything selected is already on disk.',
            'success'
          );
          setCleanCompletionProgress(
            'Metadata saved. No new images need downloading.'
          );
          return;
        }

        setPendingPreflight({
          accountId,
          request: requestState,
          summary,
        });
        setConfirmationProgress(summary);
        addLog(
          `Metadata saved. Review ${summary.totalRemainingToDownload} new image(s) before downloading.`,
          'info'
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Download failed';
      const classifiedError = classifyError(errorMessage, 'download');

      if (errorMessage === 'Operation cancelled') {
        addLog('Download cancelled by user.', 'warning');
        setProgress(prev => ({
          ...prev,
          isRunning: false,
          phase: 'cancelled',
          currentStep: 'Cancelled',
          total: 0,
          current: 0,
          statusLevel: 'info',
          issueCount: 0,
          failedItems: 0,
          confirmation: undefined,
          lastIssue: undefined,
        }));
        setActiveIncident(
          createUserIncident('download', errorMessage, { severity: 'warning' })
        );
      } else if (classifiedError.category === 'empty') {
        addLog(classifiedError.detail, 'warning');
        setShowProgressPanel(true);
        setProgress(prev => ({
          ...prev,
          isRunning: false,
          phase: 'complete',
          currentStep: EMPTY_DOWNLOAD_STEP,
          progress: 100,
          total: 0,
          current: 0,
          statusLevel: 'info',
          issueCount: 0,
          failedItems: 0,
          confirmation: undefined,
          lastIssue: classifiedError.detail,
        }));
        setActiveIncident(null);
      } else {
        addLog(`Download failed: ${errorMessage}`, 'error');
        classifiedError.guidance.forEach(message => addLog(message, 'warning'));
        setShowProgressPanel(true);
        setProgress(prev => ({
          ...prev,
          isRunning: false,
          phase: 'failed',
          currentStep: 'Failed',
          progress: 100,
          total: 0,
          current: 0,
          statusLevel: 'error',
          issueCount: Math.max(prev.issueCount, 1),
          failedItems: Math.max(prev.failedItems, 1),
          confirmation: undefined,
          lastIssue: errorMessage,
        }));
        setActiveIncident(createUserIncident('download', errorMessage));
        addResult(
          'Download',
          toOperationErrorData(errorMessage, 'download'),
          'error'
        );
      }
    } finally {
      setIsDownloading(false);
    }
  };

  const handleConfirmDownload = useCallback(async () => {
    if (viewerOnlyMode || !pendingPreflight || !window.electronAPI) {
      return;
    }

    const { accountId, request, summary } = pendingPreflight;
    const selectedSources = getSelectedDownloadSources(request.downloadSources);
    let failedDownloads = 0;
    let ranPhotoDownloads = false;

    setPendingPreflight(null);
    setActiveIncident(null);
    setIsDownloading(true);
    setShowProgressPanel(true);
    addLog('Image download confirmed. Starting file downloads...', 'info');

    try {
      for (const source of selectedSources) {
        const sourceSummary = summary.sourceSummaries.find(
          item => item.source === source
        );
        if (!sourceSummary || sourceSummary.totalImages === 0) {
          continue;
        }

        if (source === 'user-feed') {
          addLog('Downloading feed photos...', 'info');
          const downloadFeedResult =
            await window.electronAPI.downloadFeedPhotos({
              accountId,
              token: request.token.trim() || undefined,
            });

          if (!downloadFeedResult.success || !downloadFeedResult.data) {
            throw new Error(
              downloadFeedResult.error || 'Failed to download feed photos'
            );
          }

          ranPhotoDownloads = true;
          failedDownloads +=
            downloadFeedResult.data.downloadStats.failedDownloads;
          reportDownloadResult({
            operation: 'User Feed Download',
            label: 'Feed download',
            result: downloadFeedResult.data,
            directoryPath: downloadFeedResult.data.feedPhotosDirectory,
            directoryLabel: 'Feed photos saved to',
          });
          continue;
        }

        if (source === 'user-photos') {
          addLog('Downloading user photos...', 'info');
          const downloadPhotosResult = await window.electronAPI.downloadPhotos({
            accountId,
            token: request.token.trim() || undefined,
          });

          if (!downloadPhotosResult.success || !downloadPhotosResult.data) {
            throw new Error(
              downloadPhotosResult.error || 'Failed to download photos'
            );
          }

          ranPhotoDownloads = true;
          failedDownloads +=
            downloadPhotosResult.data.downloadStats.failedDownloads;
          reportDownloadResult({
            operation: 'User Photos Download',
            label: 'User photos download',
            result: downloadPhotosResult.data,
            directoryPath: downloadPhotosResult.data.photosDirectory,
            directoryLabel: 'User photos saved to',
          });
          continue;
        }

        if (source === 'profile-history') {
          addLog('Downloading profile picture history...', 'info');
          const downloadProfileHistoryResult =
            await window.electronAPI.downloadProfileHistory({
              accountId,
              token: request.token.trim(),
            });

          if (
            !downloadProfileHistoryResult.success ||
            !downloadProfileHistoryResult.data
          ) {
            throw new Error(
              downloadProfileHistoryResult.error ||
                'Failed to download profile picture history'
            );
          }

          ranPhotoDownloads = true;
          failedDownloads +=
            downloadProfileHistoryResult.data.downloadStats.failedDownloads;
          reportDownloadResult({
            operation: 'Profile Picture History Download',
            label: 'Profile picture history download',
            result: downloadProfileHistoryResult.data,
            directoryPath:
              downloadProfileHistoryResult.data.profileHistoryDirectory,
            directoryLabel: 'Profile picture history saved to',
            manifestPath:
              downloadProfileHistoryResult.data.profileHistoryManifestPath,
          });
        }
      }

      if (
        request.downloadSources.downloadUserFeed ||
        request.downloadSources.downloadUserPhotos
      ) {
        loadPhotosForAccount(accountId);
      }

      if (!ranPhotoDownloads) {
        setCleanCompletionProgress(
          'Metadata saved. No new images needed downloading.'
        );
      } else if (failedDownloads === 0) {
        setActiveIncident(null);
        setCleanCompletionProgress('Completed download');
        addLog(
          'Download complete. Run this again later to pick up anything new from Rec Room.',
          'success'
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Download failed';
      addLog(`Download failed: ${errorMessage}`, 'error');
      setProgress(prev => ({
        ...prev,
        isRunning: false,
        phase: 'failed',
        currentStep: 'Failed',
        progress: 100,
        total: 0,
        current: 0,
        statusLevel: 'error',
        issueCount: Math.max(prev.issueCount, 1),
        failedItems: Math.max(prev.failedItems, 1),
        confirmation: undefined,
        lastIssue: errorMessage,
      }));
      setActiveIncident(createUserIncident('download', errorMessage));
      addResult(
        'Download',
        toOperationErrorData(errorMessage, 'download'),
        'error'
      );
    } finally {
      setIsDownloading(false);
    }
  }, [
    addLog,
    addResult,
    loadPhotosForAccount,
    pendingPreflight,
    reportDownloadResult,
    setCleanCompletionProgress,
    viewerOnlyMode,
  ]);

  const handleSkipDownload = useCallback(() => {
    if (!pendingPreflight) {
      return;
    }

    addLog('Metadata saved. Image download skipped.', 'info');
    setPendingPreflight(null);
    setActiveIncident(null);
    setCleanCompletionProgress(
      'Metadata saved. Image download was skipped for now.'
    );
  }, [addLog, pendingPreflight, setCleanCompletionProgress]);

  const handleDownloadMyRooms = useCallback(
    async (
      token: string,
      filePath: string,
      refreshOptions: BulkDataRefreshOptions = {},
      roomPhotoSort: RoomPhotoSort = 0,
      manifestPath?: string,
      selectedRoomIds?: string[]
    ) => {
      if (viewerOnlyMode || !window.electronAPI || isDownloading) {
        return;
      }
      if (!filePath.trim()) {
        return;
      }

      const {
        forceAccountsRefresh = false,
        forceRoomsRefresh = false,
        forceEventsRefresh = false,
        forceImageCommentsRefresh = false,
      } = refreshOptions;
      const roomPhotoSortLabel =
        roomPhotoSort === 1 ? 'most cheered first' : 'newest first';

      setLibraryMode('room');
      stopRoomLoopRef.current = false;
      roomPhotoQueueRef.current = null;
      setActiveIncident(null);
      setPendingPreflight(null);
      setIsDownloading(true);
      setCurrentAccountId('');
      setCurrentEventCreatorId('');
      addLog('Loading myrooms.json...', 'info');
      setProgress({
        isRunning: true,
        phase: 'metadata',
        currentStep: 'Loading myrooms.json...',
        progress: 0,
        total: 0,
        current: 0,
        statusLevel: 'info',
        issueCount: 0,
        retryAttempts: 0,
        failedItems: 0,
        recoveredAfterRetry: 0,
        currentSource: 'room-photos',
        pageLabel: undefined,
        activeItemLabel: undefined,
        recentActivity: 'Preparing my rooms download...',
        confirmation: undefined,
        roomPhotoQueue: undefined,
      });

      try {
        const updatedSettings = await window.electronAPI.updateSettings({
          outputRoot: filePath,
        });
        setSettings(updatedSettings);
        addLog(`Output path set to: ${filePath}`, 'info');

        const requestedManifestPath =
          manifestPath?.trim() || myRoomsManifestPath.trim() || undefined;
        const manifestResult = await window.electronAPI.loadMyRoomsManifest({
          sourcePath: requestedManifestPath,
        });
        if (!manifestResult.success || !manifestResult.data) {
          throw new Error(
            manifestResult.error || 'Could not load myrooms.json'
          );
        }

        setMyRoomsManifestPath(manifestResult.data.sourcePath);

        const manifestRooms = manifestResult.data.rooms.filter(room =>
          String(room.RoomId ?? '').trim()
        );
        const allRoomsById = new Map<string, RoomDto>();
        for (const room of [...manifestRooms, ...additionalMyRooms]) {
          const roomId = String(room.RoomId ?? '').trim();
          if (roomId) {
            allRoomsById.set(roomId, room);
          }
        }
        const allRooms = Array.from(allRoomsById.values());
        setMyRoomsManifestRooms(manifestRooms);
        if (selectedMyRoomIds.length === 0) {
          setSelectedMyRoomIds(allRooms.map(room => String(room.RoomId)));
        }

        const selectedRoomIdSet =
          selectedRoomIds !== undefined
            ? new Set(selectedRoomIds.map(id => id.trim()).filter(Boolean))
            : null;
        if (selectedRoomIdSet && selectedRoomIdSet.size === 0) {
          throw new Error('Choose at least one room.');
        }

        const rooms = selectedRoomIdSet
          ? allRooms.filter(room =>
              selectedRoomIdSet.has(String(room.RoomId ?? '').trim())
            )
          : allRooms;
        if (rooms.length === 0) {
          throw new Error(
            selectedRoomIdSet
              ? 'None of the selected rooms were found in the room download list.'
              : 'The room download list did not contain any rooms.'
          );
        }

        addLog(
          `Loaded ${manifestRooms.length} room(s) from ${manifestResult.data.sourcePath} and ${additionalMyRooms.length} added room(s). Downloading ${rooms.length} room(s), fetching ${roomPhotoSortLabel}.`,
          'success'
        );

        let roomsProcessed = 0;
        let totalBatches = 0;
        let totalPhotosFetched = 0;
        let totalNewDownloads = 0;
        let totalAlreadyDownloaded = 0;
        let totalFailedDownloads = 0;
        let roomPhotoQueue: RoomPhotoQueueProgress = {
          totalRooms: rooms.length,
          roomsCompleted: 0,
          batchesCompleted: 0,
          photosDiscovered: 0,
          newDownloads: 0,
          alreadyDownloaded: 0,
          failedDownloads: 0,
          message: `Queued ${rooms.length} room${rooms.length === 1 ? '' : 's'} for room photo download.`,
        };
        applyRoomPhotoQueueProgress(roomPhotoQueue);

        for (let roomIndex = 0; roomIndex < rooms.length; roomIndex++) {
          if (stopRoomLoopRef.current) {
            break;
          }

          const room = rooms[roomIndex];
          const roomId = String(room.RoomId ?? '').trim();
          const roomName = (room.Name || roomId).trim();
          setCurrentRoomId(roomId);
          roomPhotoQueue = {
            ...roomPhotoQueue,
            currentRoomIndex: roomIndex + 1,
            currentRoomName: roomName,
            currentRoomId: roomId,
            currentBatch: undefined,
            currentBatchFetched: undefined,
            currentBatchCurrent: undefined,
            currentBatchTotal: undefined,
            currentBatchProgress: undefined,
            currentBatchLabel: undefined,
            currentRoomPhotosDiscovered: 0,
            hasMoreForCurrentRoom: undefined,
            message: `Room ${roomIndex + 1} of ${rooms.length}: preparing ^${roomName}.`,
          };
          applyRoomPhotoQueueProgress(roomPhotoQueue);
          addLog(
            `[${roomIndex + 1}/${rooms.length}] Downloading room photos for ^${roomName} (ID: ${roomId}).`,
            'info'
          );

          let startSkip: number | undefined = undefined;
          let batchIndex = 0;
          let currentRoomPhotosDiscovered = 0;
          let latestBatch: RoomPhotoBatchResult | null = null;

          while (!stopRoomLoopRef.current) {
            batchIndex++;
            totalBatches++;
            roomPhotoQueue = {
              ...roomPhotoQueue,
              batchesCompleted: totalBatches - 1,
              currentBatch: batchIndex,
              currentBatchFetched: 0,
              currentBatchCurrent: 0,
              currentBatchTotal: 0,
              currentBatchProgress: 0,
              currentBatchLabel: `Batch ${batchIndex}`,
              currentRoomPhotosDiscovered,
              message: `Room ${roomIndex + 1} of ${rooms.length}: scanning ^${roomName}; ${totalPhotosFetched.toLocaleString()} photo record(s) discovered so far.`,
            };
            applyRoomPhotoQueueProgress(roomPhotoQueue);
            addLog(
              `[${roomIndex + 1}/${rooms.length}] Collecting ^${roomName} batch ${batchIndex}...`,
              'info'
            );

            const batchResult = await window.electronAPI.downloadRoomPhotoBatch(
              {
                roomId,
                roomName,
                room,
                token: token.trim() || undefined,
                startSkip,
                batchPages: 10,
                pageSize: 100,
                sort: roomPhotoSort,
                forceAccountsRefresh,
                forceRoomsRefresh,
                forceEventsRefresh,
                forceImageCommentsRefresh,
              }
            );

            if (!batchResult.success || !batchResult.data) {
              const errorMessage =
                batchResult.error || 'Failed to download room photo batch';
              if (
                stopRoomLoopRef.current &&
                /operation cancelled|cancelled/i.test(errorMessage)
              ) {
                break;
              }
              throw new Error(errorMessage);
            }

            const batchData = batchResult.data;
            latestBatch = batchData;
            startSkip = batchData.nextSkip;
            totalPhotosFetched += batchData.photosFetched;
            currentRoomPhotosDiscovered += batchData.photosFetched;
            totalNewDownloads += batchData.downloadStats.newDownloads;
            totalAlreadyDownloaded += batchData.downloadStats.alreadyDownloaded;
            totalFailedDownloads += batchData.downloadStats.failedDownloads;
            roomPhotoQueue = {
              ...roomPhotoQueue,
              batchesCompleted: totalBatches,
              currentBatch: batchIndex,
              currentBatchFetched: batchData.photosFetched,
              currentBatchCurrent: batchData.photosFetched,
              currentBatchTotal: batchData.photosFetched,
              currentBatchProgress: 100,
              currentBatchLabel: `Batch ${batchIndex} complete`,
              currentRoomPhotosDiscovered,
              photosDiscovered: totalPhotosFetched,
              newDownloads: totalNewDownloads,
              alreadyDownloaded: totalAlreadyDownloaded,
              failedDownloads: totalFailedDownloads,
              hasMoreForCurrentRoom: batchData.hasMore,
              message: `Room ${roomIndex + 1} of ${rooms.length}: ^${roomName} has ${batchData.hasMore ? 'more photos to scan' : 'finished scanning'}; ${totalPhotosFetched.toLocaleString()} photo record(s) discovered across the queue.`,
            };
            applyRoomPhotoQueueProgress(roomPhotoQueue);
            addResult(`Room Photos: ${roomName}`, batchData, 'success');
            addLog(
              `^${roomName} batch ${batchIndex} complete: started at skip ${batchData.startSkip.toLocaleString()}, ${batchData.newPhotosAdded} new metadata record(s), ${batchData.downloadStats.newDownloads} downloaded.`,
              batchData.downloadStats.failedDownloads > 0
                ? 'warning'
                : 'success'
            );

            if (!batchData.hasMore) {
              break;
            }
          }

          if (latestBatch) {
            roomsProcessed++;
            roomPhotoQueue = {
              ...roomPhotoQueue,
              roomsCompleted: roomsProcessed,
              currentBatch: undefined,
              currentBatchFetched: undefined,
              currentBatchCurrent: undefined,
              currentBatchTotal: undefined,
              currentBatchProgress: undefined,
              currentBatchLabel: undefined,
              currentRoomPhotosDiscovered,
              hasMoreForCurrentRoom: false,
              message: stopRoomLoopRef.current
                ? `Stopped while downloading ^${roomName}. ${roomsProcessed} of ${rooms.length} room(s) completed.`
                : `Finished ^${roomName}. ${roomsProcessed} of ${rooms.length} room(s) completed.`,
            };
            applyRoomPhotoQueueProgress(roomPhotoQueue);
            addLog(
              stopRoomLoopRef.current
                ? `Stopped while downloading ^${roomName}.`
                : `Finished ^${roomName}: ${latestBatch.totalPhotos} total photo metadata record(s).`,
              stopRoomLoopRef.current ? 'warning' : 'success'
            );
          }
        }

        addLog(
          stopRoomLoopRef.current
            ? `My rooms photo download stopped after ${roomsProcessed}/${rooms.length} room(s).`
            : `My rooms photo download complete: ${roomsProcessed} room(s), ${totalBatches} batch(es), ${totalPhotosFetched} photo record(s) fetched, ${totalNewDownloads} downloaded, ${totalAlreadyDownloaded} already on disk, ${totalFailedDownloads} failed.`,
          stopRoomLoopRef.current || totalFailedDownloads > 0
            ? 'warning'
            : 'success'
        );
        setCleanCompletionProgress(
          stopRoomLoopRef.current
            ? 'Stopped my rooms photo gathering'
            : 'Completed my rooms photo gathering'
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Download failed';
        addLog(`Download failed: ${errorMessage}`, 'error');
        setProgress(prev => ({
          ...prev,
          isRunning: false,
          phase: 'failed',
          currentStep: 'Failed',
          progress: 100,
          total: 0,
          current: 0,
          statusLevel: 'error',
          issueCount: Math.max(prev.issueCount, 1),
          failedItems: Math.max(prev.failedItems, 1),
          confirmation: undefined,
          lastIssue: errorMessage,
        }));
        setActiveIncident(createUserIncident('download', errorMessage));
        addResult(
          'My Rooms Download',
          toOperationErrorData(errorMessage, 'download'),
          'error'
        );
      } finally {
        roomPhotoQueueRef.current = null;
        setIsDownloading(false);
      }
    },
    [
      addLog,
      addResult,
      additionalMyRooms,
      applyRoomPhotoQueueProgress,
      isDownloading,
      myRoomsManifestPath,
      selectedMyRoomIds.length,
      setCleanCompletionProgress,
      viewerOnlyMode,
    ]
  );

  const handleRetryDownload = useCallback(async () => {
    if (viewerOnlyMode || !retryRequest || isDownloading) {
      return;
    }

    setLibraryMode(retryRequest.libraryMode);
    await handleDownload(
      retryRequest.username,
      retryRequest.token,
      retryRequest.filePath,
      retryRequest.downloadSources,
      retryRequest.refreshOptions,
      retryRequest.roomPhotoSort,
      retryRequest.eventIds ?? [],
      retryRequest.knownCreatorAccountId
    );
  }, [handleDownload, isDownloading, retryRequest, viewerOnlyMode]);

  const openDownloadPanelPlain = useCallback(() => {
    if (viewerOnlyMode) {
      return;
    }
    setEventDownloadPanelPrefill(null);
    setDownloadPanelOpen(true);
  }, [viewerOnlyMode]);

  const handleDownloadPanelOpenChange = useCallback(
    (nextOpen: boolean) => {
      setDownloadPanelOpen(viewerOnlyMode ? false : nextOpen);
      if (!nextOpen) {
        setEventDownloadPanelPrefill(null);
      }
    },
    [viewerOnlyMode]
  );

  const startQuickEventPhotoDownload = useCallback(
    async (intent: EventDownloadIntent) => {
      if (
        viewerOnlyMode ||
        !window.electronAPI ||
        intent.kind !== 'eventAlbum'
      ) {
        return;
      }
      const filePath = settings.outputRoot || '';
      if (!filePath.trim() || !settings.outputPathConfiguredForDownload) {
        return;
      }
      const d = downloadDraft;
      await handleDownload(
        (intent.username?.trim() || d?.username?.trim() || '').trim(),
        d?.token ?? '',
        filePath,
        d?.downloadSources ?? DEFAULT_DOWNLOAD_SOURCE_SELECTION,
        d?.refreshOptions ?? {
          forceAccountsRefresh: false,
          forceRoomsRefresh: false,
          forceEventsRefresh: false,
          forceImageCommentsRefresh: false,
        },
        d?.roomPhotoSort ?? 0,
        [intent.eventId],
        intent.creatorAccountId
      );
    },
    [
      downloadDraft,
      handleDownload,
      settings.outputPathConfiguredForDownload,
      settings.outputRoot,
      viewerOnlyMode,
    ]
  );

  const handleOpenDownloadPanelFromViewer = useCallback(
    (intent?: EventDownloadIntent) => {
      if (viewerOnlyMode) {
        return;
      }
      if (intent?.kind === 'eventAlbum') {
        if (settings.outputPathConfiguredForDownload) {
          void startQuickEventPhotoDownload(intent);
        } else {
          setEventDownloadPanelPrefill({
            creatorAccountId: intent.creatorAccountId,
            eventIds: [intent.eventId],
            usernameHint: intent.username,
          });
          setDownloadPanelOpen(true);
        }
        return;
      }
      openDownloadPanelPlain();
    },
    [
      openDownloadPanelPlain,
      settings.outputPathConfiguredForDownload,
      startQuickEventPhotoDownload,
      viewerOnlyMode,
    ]
  );

  const handleViewerAccountChange = useCallback(
    (accountId?: string) => {
      // Only update if not downloading (to avoid conflicts)
      if (!isDownloading) {
        setCurrentAccountId(accountId || '');
      }
    },
    [isDownloading]
  );

  const handleViewerRoomChange = useCallback(
    (roomId?: string) => {
      if (!isDownloading) {
        setCurrentRoomId(roomId || '');
      }
    },
    [isDownloading]
  );

  const handleOpenActivityMenu = useCallback(() => {
    setDebugMenuOpen(true);
  }, []);

  const effectiveOutputExplorerPath =
    (settings.resolvedOutputRoot ?? '').trim() || settings.outputRoot.trim();

  const handleLoadMyRoomsManifest = useCallback(
    async (pathOverride?: string) => {
      if (!window.electronAPI?.loadMyRoomsManifest) {
        return;
      }
      try {
        const result = await window.electronAPI.loadMyRoomsManifest({
          sourcePath:
            pathOverride?.trim() || myRoomsManifestPath.trim() || undefined,
        });
        if (!result.success || !result.data) {
          throw new Error(result.error || 'Could not load myrooms.json');
        }
        const rooms = result.data.rooms.filter(room =>
          String(room.RoomId ?? '').trim()
        );
        const selectedRoomIds = Array.from(
          new Set(
            [...rooms, ...additionalMyRooms]
              .map(room => String(room.RoomId ?? '').trim())
              .filter(Boolean)
          )
        );
        setMyRoomsManifestPath(result.data.sourcePath);
        setMyRoomsManifestRooms(rooms);
        setSelectedMyRoomIds(selectedRoomIds);
        addLog(`Loaded ${rooms.length} room(s) from myrooms.json.`, 'success');
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Could not load myrooms.json';
        addLog(message, 'error');
        setActiveIncident(createUserIncident('download', message));
      }
    },
    [addLog, additionalMyRooms, myRoomsManifestPath]
  );

  const handleSelectMyRoomsManifest = useCallback(async () => {
    if (!window.electronAPI?.selectMyRoomsJson) {
      return;
    }
    const selectedPath = await window.electronAPI.selectMyRoomsJson();
    if (selectedPath) {
      setMyRoomsManifestPath(selectedPath);
      await handleLoadMyRoomsManifest(selectedPath);
    }
  }, [handleLoadMyRoomsManifest]);

  const handleToggleMyRoomSelection = useCallback(
    (roomId: string, checked: boolean) => {
      setSelectedMyRoomIds(current => {
        const next = new Set(current);
        if (checked) {
          next.add(roomId);
        } else {
          next.delete(roomId);
        }
        return Array.from(next);
      });
    },
    []
  );

  const handleAddRoomToMyRooms = useCallback(
    async (roomQuery: string): Promise<boolean> => {
      if (!window.electronAPI || isAddingMyRoom) {
        return false;
      }

      const cleanedRoomQuery = roomQuery.trim().replace(/^\^+/, '').trim();
      if (!cleanedRoomQuery) {
        return false;
      }

      setIsAddingMyRoom(true);
      try {
        const token = downloadDraft?.token?.trim() || undefined;
        const result = /^\d+$/.test(cleanedRoomQuery)
          ? await window.electronAPI.lookupRoomById({
              roomId: cleanedRoomQuery,
              token,
            })
          : await window.electronAPI.lookupRoomByName({
              roomName: cleanedRoomQuery,
              token,
            });
        if (!result.success || !result.data) {
          throw new Error(result.error || 'Could not find that room.');
        }

        const room = result.data;
        const roomId = String(room.RoomId ?? '').trim();
        if (!roomId) {
          throw new Error('Rec.net returned a room without a room ID.');
        }
        const roomName = (room.Name || roomId).trim();
        const alreadyInManifest = myRoomsManifestRooms.some(
          manifestRoom => String(manifestRoom.RoomId ?? '').trim() === roomId
        );

        if (!alreadyInManifest) {
          setAdditionalMyRooms(current => {
            if (
              current.some(
                additionalRoom =>
                  String(additionalRoom.RoomId ?? '').trim() === roomId
              )
            ) {
              return current;
            }
            return [...current, room];
          });
        }
        setSelectedMyRoomIds(current =>
          Array.from(new Set([...current, roomId]))
        );
        addLog(`Added ^${roomName} to the room download list.`, 'success');
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Could not add that room.';
        addLog(message, 'error');
        setActiveIncident(createUserIncident('download', message));
        return false;
      } finally {
        setIsAddingMyRoom(false);
      }
    },
    [addLog, downloadDraft?.token, isAddingMyRoom, myRoomsManifestRooms]
  );

  const handleSelectAllMyRooms = useCallback(() => {
    setSelectedMyRoomIds(
      combinedMyRoomRooms.map(room => String(room.RoomId)).filter(Boolean)
    );
  }, [combinedMyRoomRooms]);

  const handleClearMyRoomsSelection = useCallback(() => {
    setSelectedMyRoomIds([]);
  }, []);

  const handleDownloadMyRoomsFromViewer = useCallback(async () => {
    const outputPath = settings.outputRoot || effectiveOutputExplorerPath;
    await handleDownloadMyRooms(
      downloadDraft?.token ?? '',
      outputPath,
      downloadDraft?.refreshOptions ?? {
        forceAccountsRefresh: false,
        forceRoomsRefresh: false,
        forceEventsRefresh: false,
        forceImageCommentsRefresh: false,
      },
      downloadDraft?.roomPhotoSort ?? 0,
      myRoomsManifestPath
    );
  }, [
    downloadDraft,
    effectiveOutputExplorerPath,
    handleDownloadMyRooms,
    myRoomsManifestPath,
    settings.outputRoot,
  ]);

  const handleDownloadSelectedMyRoomsFromViewer = useCallback(async () => {
    const outputPath = settings.outputRoot || effectiveOutputExplorerPath;
    await handleDownloadMyRooms(
      downloadDraft?.token ?? '',
      outputPath,
      downloadDraft?.refreshOptions ?? {
        forceAccountsRefresh: false,
        forceRoomsRefresh: false,
        forceEventsRefresh: false,
        forceImageCommentsRefresh: false,
      },
      downloadDraft?.roomPhotoSort ?? 0,
      myRoomsManifestPath,
      selectedMyRoomIds
    );
  }, [
    downloadDraft,
    effectiveOutputExplorerPath,
    handleDownloadMyRooms,
    myRoomsManifestPath,
    selectedMyRoomIds,
    settings.outputRoot,
  ]);

  const handleRevealOutputFolder = useCallback(() => {
    if (!effectiveOutputExplorerPath) {
      return;
    }
    void handleOpenPathInExplorer(effectiveOutputExplorerPath);
  }, [handleOpenPathInExplorer, effectiveOutputExplorerPath]);

  const handlePhotosLoadError = useCallback((message: string) => {
    setActiveIncident(createUserIncident('photos', message));
  }, []);

  const handleCancelDownload = async () => {
    stopRoomLoopRef.current = true;
    try {
      if (window.electronAPI) {
        const cancelled = await window.electronAPI.cancelOperation();
        if (cancelled) {
          addLog('Download cancelled', 'warning');
          setProgress(prev => ({
            ...prev,
            isRunning: false,
            phase: 'cancelled',
            currentStep: 'Cancelled',
            progress: 0,
            total: 0,
            current: 0,
          }));
        }
      }
    } catch (error) {
      addLog(`Failed to cancel download: ${error}`, 'error');
    }
  };

  const handlePhotoScroll = useCallback(
    (scrollTop: number) => {
      const last = scrollPositionRef.current;
      const delta = scrollTop - last;
      const isScrollingDown = delta > 6;
      const isScrollingUp = delta < -6;

      if (scrollTop < 24) {
        setHeaderMode('full');
        setHasScrolledPhotos(false);
        setHasScrolledDown(false);
        scrollPositionRef.current = scrollTop;
        return;
      }

      setHasScrolledPhotos(true);
      setHasScrolledDown(true);

      if (isScrollingDown && scrollTop > 48) {
        setHeaderMode('hidden');
      } else if (isScrollingUp && hasScrolledDown) {
        setHeaderMode('compact');
      }

      scrollPositionRef.current = scrollTop;
    },
    [hasScrolledDown]
  );

  const scrollPhotosToTop = useCallback(() => {
    if (photoScrollRef.current) {
      photoScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  return (
    <FavoritesProvider>
      <div className="min-h-screen bg-background">
        {/* Custom Title Bar */}
        <LibraryMoveDialog
          open={libraryMoveDialogOpen}
          onOpenChange={setLibraryMoveDialogOpen}
          settings={settings}
          onCompleted={loadSettings}
        />

        <CustomTitleBar
          onDownloadClick={viewerOnlyMode ? undefined : openDownloadPanelPlain}
          onStatsClick={() => setStatsDialogOpen(true)}
          settings={settings}
          onUpdateSettings={updateSettings}
          logs={logs}
          results={results}
          onClearLogs={clearLogs}
          currentAccountId={currentAccountId}
          debugMenuOpen={debugMenuOpen}
          onDebugMenuOpenChange={setDebugMenuOpen}
          resultsScrollRequestId={resultsScrollRequestId}
          onRetryDownload={viewerOnlyMode ? undefined : handleRetryDownload}
          canRetryDownload={!viewerOnlyMode && canRetryDownload}
          isRetryingDownload={isDownloading}
          onOpenDownloadPanel={
            viewerOnlyMode ? undefined : openDownloadPanelPlain
          }
          onOpenOutputFolder={handleOpenPathInExplorer}
          outputExplorerPath={effectiveOutputExplorerPath}
          libraryMode={libraryMode}
          onLibraryModeChange={setLibraryMode}
          libraryMoveEnabled={LIBRARY_MOVE_ENABLED}
          onOpenLibraryMove={() => setLibraryMoveDialogOpen(true)}
          viewerOnlyMode={viewerOnlyMode}
          metadataSyncPhase={metadataSyncPhase}
          metadataSyncState={metadataSyncState}
          onForceMetadataSync={
            viewerOnlyMode ? undefined : handleForceMetadataSync
          }
        />

        <div className="container mx-auto px-4 py-4 max-w-7xl h-screen flex flex-col overflow-hidden pt-14">
          <ErrorRecoveryBanner
            incident={activeIncident}
            outputExplorerPath={effectiveOutputExplorerPath}
            onDismiss={dismissIncident}
            onRetryDownload={viewerOnlyMode ? undefined : handleRetryDownload}
            canRetryDownload={!viewerOnlyMode && canRetryDownload}
            isRetrying={isDownloading}
            onOpenDownloadPanel={
              viewerOnlyMode ? undefined : openDownloadPanelPlain
            }
            onOpenOperationResults={openOperationResults}
            onOpenPathInExplorer={handleOpenPathInExplorer}
          />
          {/* Header space removed - using custom title bar instead */}

          {/* Download Panel Modal */}
          {!viewerOnlyMode && (
            <ErrorBoundary sectionName="Download panel">
              <DownloadPanel
                open={downloadPanelOpen}
                onOpenChange={handleDownloadPanelOpenChange}
                onDownload={handleDownload}
                onDownloadMyRooms={handleDownloadMyRooms}
                onDraftChange={handleDownloadDraftChange}
                onCancel={handleCancelDownload}
                isDownloading={isDownloading}
                showCancel={isDownloading}
                settings={settings}
                libraryMode={libraryMode}
                onUpdateSettings={updateSettings}
                eventDownloadPrefill={eventDownloadPanelPrefill}
                onEventDownloadPrefillConsumed={() =>
                  setEventDownloadPanelPrefill(null)
                }
              />
            </ErrorBoundary>
          )}

          {/* Stats Dialog */}
          <ErrorBoundary sectionName="Stats">
            <StatsDialog
              open={statsDialogOpen}
              onOpenChange={setStatsDialogOpen}
              accountId={currentAccountId}
              filePath={effectiveOutputExplorerPath}
            />
          </ErrorBoundary>

          {/* Progress Display */}
          {!isProgressIdle && showProgressPanel && (
            <div className="mb-4 max-h-[38vh] shrink-0 overflow-auto">
              <ProgressDisplay
                progress={progress}
                onClose={() => setShowProgressPanel(false)}
                onOpenOperationResults={openOperationResults}
                onOpenDownloadPanel={
                  viewerOnlyMode ? undefined : openDownloadPanelPlain
                }
                onCancelDownload={handleCancelDownload}
                onConfirmDownload={
                  viewerOnlyMode ? undefined : handleConfirmDownload
                }
                onSkipDownload={handleSkipDownload}
                onRetryDownload={
                  viewerOnlyMode ? undefined : handleRetryDownload
                }
                canRetryDownload={!viewerOnlyMode && canRetryDownload}
                isRetrying={isDownloading}
              />
            </div>
          )}

          {/* Photo Viewer */}
          <div className="flex-1 min-h-0 relative">
            {hasScrolledDown && headerMode === 'hidden' && (
              <div
                className="absolute left-0 right-0 top-0 z-30 h-3"
                onMouseEnter={() => setHeaderMode('compact')}
              />
            )}
            <ErrorBoundary sectionName="Photo viewer">
              <PhotoViewer
                filePath={effectiveOutputExplorerPath}
                accountId={
                  libraryMode === 'user' && isDownloading
                    ? currentAccountId
                    : undefined
                }
                roomId={
                  libraryMode === 'room' && isDownloading
                    ? currentRoomId
                    : undefined
                }
                eventCreatorId={
                  libraryMode === 'event' && isDownloading
                    ? currentEventCreatorId
                    : undefined
                }
                libraryMode={libraryMode}
                isDownloading={isDownloading}
                completedBatchCount={
                  progress.roomPhotoQueue?.batchesCompleted ?? 0
                }
                onAccountChange={handleViewerAccountChange}
                onRoomChange={handleViewerRoomChange}
                onScrollPositionChange={handlePhotoScroll}
                scrollContainerRef={photoScrollRef}
                headerMode={headerMode}
                onOpenActivityMenu={handleOpenActivityMenu}
                onOpenDownloadPanel={
                  viewerOnlyMode ? undefined : handleOpenDownloadPanelFromViewer
                }
                myRoomsManifestPath={myRoomsManifestPath}
                myRoomsManifestRooms={combinedMyRoomRooms}
                selectedMyRoomIds={selectedMyRoomIds}
                isAddingMyRoom={isAddingMyRoom}
                onMyRoomsManifestPathChange={setMyRoomsManifestPath}
                onSelectMyRoomsManifest={handleSelectMyRoomsManifest}
                onLoadMyRoomsManifest={() => void handleLoadMyRoomsManifest()}
                onAddRoomToMyRooms={handleAddRoomToMyRooms}
                onToggleMyRoomSelection={handleToggleMyRoomSelection}
                onSelectAllMyRooms={handleSelectAllMyRooms}
                onClearMyRoomsSelection={handleClearMyRoomsSelection}
                onDownloadMyRooms={handleDownloadMyRoomsFromViewer}
                onDownloadSelectedMyRooms={
                  handleDownloadSelectedMyRoomsFromViewer
                }
                onRevealOutputFolder={handleRevealOutputFolder}
                onPhotosLoadError={handlePhotosLoadError}
                onPhotosLoadSuccess={clearPhotosIncident}
                cdnBase={settings.cdnBase}
                viewerOnlyMode={viewerOnlyMode}
              />
            </ErrorBoundary>
          </div>

          {/* Scroll To Top */}
          {hasScrolledPhotos && (
            <Button
              variant="secondary"
              size="icon"
              className="fixed bottom-16 right-4 shadow-lg"
              onClick={scrollPhotosToTop}
              aria-label="Scroll to top"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </FavoritesProvider>
  );
}

export default App;
