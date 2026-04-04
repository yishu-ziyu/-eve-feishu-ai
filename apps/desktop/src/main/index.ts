import { dirname, join } from "node:path";
import icon from "../../resources/icon.png?asset";
import log from "electron-log/main";
import { app, type BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATUS,
  type AppSettings,
  type DesktopSnapshot,
  type DeviceInfo,
  type RecorderStatusSnapshot
} from "@eve/shared";
import {
  getMicrophonePermissionStatus,
  openMicrophonePrivacySettings,
  requestMicrophonePermission
} from "./permissions";
import { DesktopEngine } from "./desktop-engine";
import { TestDesktopEngine } from "./test-engine";
import {
  applyTheme,
  getSettings,
  setSettings
} from "./store";
import { listRecentRecordings } from "./recording-history";
import {
  destroyTray,
  getTrayBounds,
  initializeTray,
  setTrayLaunchAtLogin,
  setTrayStatus
} from "./tray";
import { initializeMainLogger } from "./logging";
import { createMainWindow, positionWindowForReveal } from "./window";
import {
  getAutoUpdateSnapshot,
  initializeAutoUpdates,
  installDownloadedUpdateIfReady,
  isAutoUpdateInstalling,
  shutdownAutoUpdates
} from "./updater";
import { FeishuService } from "./services/feishuService";
import { SentimentAnalyzer } from "./services/sentimentService";
import { DailyReportService } from "./services/dailyReportService";
import { getFeishuConfig, setFeishuConfig, type FeishuConfigInput, getSentimentConfig, setSentimentConfig, type SentimentConfigInput } from "./store";
import cron from "node-cron";

const isE2E = process.env.EVE_E2E_TEST === "1";
const REPOSITORY_URL = "https://github.com/nexmoe/eve";

type DesktopEngineLike = Pick<
  DesktopEngine,
  | "applySettings"
  | "getDevices"
  | "getReady"
  | "getStatus"
  | "updateDevices"
  | "reportCaptureError"
  | "startRecording"
  | "stopRecording"
  | "runTranscribe"
  | "pushAudioChunk"
>;

let mainWindow: BrowserWindow | null = null;
let engine: DesktopEngineLike | null = null;
let lastStatus: RecorderStatusSnapshot = DEFAULT_STATUS;
let isQuitting = false;
let isWindowPinned = false;
let quitAfterRecordingFinalize = false;
let cachedDevices: DesktopSnapshot["devices"] = [];
let cachedHistory: DesktopSnapshot["history"] = [];
let cachedPermission = isE2E
  ? {
      message: "E2E microphone permission granted.",
      state: "authorized" as const,
      supported: true
    }
  : getMicrophonePermissionStatus();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Failed to start recording.";

// ── Throttled snapshot emission ─────────────────────────────────────
// Audio-chunk status updates arrive many times per second.  Flooding the
// renderer with IPC messages for every single chunk wastes CPU on
// serialisation/deserialisation and forces React to re-render at an
// unsustainable rate.  We throttle to at most one emission per 100 ms
// during recording.
const SNAPSHOT_THROTTLE_MS = 100;
let snapshotThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotPending = false;

const scheduleSnapshotEmit = (): void => {
  snapshotPending = true;
  if (snapshotThrottleTimer) {
    return; // a flush is already scheduled
  }
  snapshotThrottleTimer = setTimeout(() => {
    snapshotThrottleTimer = null;
    if (snapshotPending) {
      snapshotPending = false;
      void emitSnapshot(buildSnapshot(), { force: true });
    }
  }, SNAPSHOT_THROTTLE_MS);
};

const hideDockIcon = (): void => {
  if (process.platform === "darwin" && !isE2E) {
    app.dock?.hide();
  }
};

const buildSnapshot = (): DesktopSnapshot => {
  const settings = getSettings();
  return {
    app: {
      name: app.getName(),
      repositoryUrl: REPOSITORY_URL,
      version: app.getVersion()
    },
    devices: cachedDevices,
    engineReady: engine?.getReady() ?? false,
    history: cachedHistory,
    permission: cachedPermission,
    settings,
    status: lastStatus,
    updater: getAutoUpdateSnapshot(),
    windowPinned: isWindowPinned
  };
};

const getSnapshot = async ({
  refreshDevices = false,
  refreshHistory = false,
  refreshPermission = false
}: {
  refreshDevices?: boolean;
  refreshHistory?: boolean;
  refreshPermission?: boolean;
} = {}): Promise<DesktopSnapshot> => {
  const settings = getSettings();
  const [devices, history] = await Promise.all([
    refreshDevices
      ? Promise.resolve(engine?.getDevices() ?? cachedDevices)
      : Promise.resolve(cachedDevices),
    refreshHistory
      ? listRecentRecordings([
          settings.recording.outputDir,
          DEFAULT_SETTINGS.recording.outputDir
        ]).catch(() => cachedHistory)
      : Promise.resolve(cachedHistory)
  ]);
  if (refreshDevices) {
    cachedDevices = devices;
  }
  if (refreshHistory) {
    cachedHistory = history;
  }
  if (refreshPermission) {
    cachedPermission = getMicrophonePermissionStatus();
  }
  return buildSnapshot();
};

const emitSnapshot = async (
  snapshot = buildSnapshot(),
  { force = false }: { force?: boolean } = {}
): Promise<void> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (!force && !mainWindow.isVisible()) {
    return;
  }
  mainWindow.webContents.send("desktop:snapshot", snapshot);
};

const revealMainWindow = (): BrowserWindow => {
  mainWindow ??= createMainWindow(true);
  const windowRef = mainWindow;
  if (windowRef.isMinimized()) {
    windowRef.restore();
  }
  positionWindowForReveal(windowRef, getTrayBounds());
  if (process.platform === "darwin") {
    // Activate the app first so macOS brings it to the foreground.
    // Without this, the window may show but not receive focus when
    // the dock icon is hidden.
    app.show();
    windowRef.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    windowRef.show();
    windowRef.focus();
    windowRef.setVisibleOnAllWorkspaces(false);
    hideDockIcon();
  } else {
    windowRef.setVisibleOnAllWorkspaces(false);
    windowRef.show();
    windowRef.focus();
  }
  return windowRef;
};

const toggleMainWindow = (): void => {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  revealMainWindow();
  void getSnapshot({
    refreshDevices: true,
    refreshHistory: true,
    refreshPermission: true
  }).then((snapshot) => emitSnapshot(snapshot, { force: true }));
};

const openRendererDevTools = (): void => {
  revealMainWindow().webContents.openDevTools({ mode: "detach" });
};

const activateAppForPermissionPrompt = (): void => {
  revealMainWindow();
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
};

const applyLoginItemSettings = (enabled: boolean): void => {
  if (isE2E) {
    return;
  }
  if (!app.isPackaged) {
    log.info("[eve] skipped login item update in development");
    setTrayLaunchAtLogin(enabled);
    return;
  }
  try {
    app.setLoginItemSettings({
      enabled,
      openAsHidden: true
    });
  } catch (error) {
    log.warn("[eve] failed to update login item settings", error);
  }
  setTrayLaunchAtLogin(enabled);
};

const applyWindowPinnedState = (pinned: boolean): void => {
  isWindowPinned = pinned;
  mainWindow?.setAlwaysOnTop(pinned, pinned ? "floating" : "normal");
};

const startRecording = async (): Promise<void> => {
  if (!engine) {
    throw new Error("Recorder engine is unavailable.");
  }
  await engine.startRecording();
};

const captureStartRecordingError = (error: unknown): void => {
  engine?.reportCaptureError(errorMessage(error));
};

const finalizeRecordingBeforeQuit = async (): Promise<void> => {
  if (!engine || !lastStatus.recording) {
    return;
  }
  await engine.stopRecording();
};

const ensureMicrophonePermission = async (): Promise<void> => {
  if (isE2E || process.platform !== "darwin") {
    return;
  }
  if (cachedPermission.state !== "not-determined") {
    return;
  }
  activateAppForPermissionPrompt();
  cachedPermission = await requestMicrophonePermission();
  hideDockIcon();
};

const bootstrapDesktop = async (): Promise<void> => {
  if (app.isPackaged) {
    initializeMainLogger();
  }
  hideDockIcon();
  const settings = getSettings() ?? DEFAULT_SETTINGS;
  engine = new (isE2E ? TestDesktopEngine : DesktopEngine)((status) => {
    lastStatus = status;
    setTrayStatus(lastStatus);
    // During recording, audio-chunk status updates arrive very frequently.
    // Throttle renderer emissions to avoid IPC and React re-render overhead.
    if (lastStatus.recording) {
      scheduleSnapshotEmit();
    } else {
      void emitSnapshot(buildSnapshot(), { force: true });
    }
  });
  await engine.applySettings(settings);
  lastStatus = engine.getStatus();
  // Always show window on launch for better UX
  const shouldShow = true;
  mainWindow = createMainWindow(shouldShow);
  await ensureMicrophonePermission();
  await getSnapshot({
    refreshDevices: true,
    refreshHistory: true,
    refreshPermission: true
  });
  applyLoginItemSettings(settings.desktop.launchAtLogin);
  applyTheme(settings.desktop.theme);
  if (process.env.EVE_SMOKE_TEST === "1") {
    mainWindow.webContents.once("did-finish-load", () => {
      void mainWindow?.webContents
        .executeJavaScript(
          "JSON.stringify({ eve: typeof window.eve, bootstrap: typeof window.eve?.bootstrap })"
        )
        .then((result) => {
          console.log(`[eve-smoke] bridge=${String(result)}`);
          app.quit();
        })
        .catch((error: unknown) => {
          console.error("[eve-smoke] renderer bridge check failed", error);
          app.exit(1);
        });
    });
  }
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    log.error("[eve] renderer failed to load", {
      errorCode,
      errorDescription,
      validatedURL
    });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log.error("[eve] renderer process gone", details);
  });
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      mainWindow?.webContents.openDevTools({ mode: "detach" });
    }
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
  });
  // DEV MODE: Disable blur hide for testing
  if (!isE2E && process.env.NODE_ENV !== "development") {
    mainWindow.on("blur", () => {
      if (!isQuitting && !isWindowPinned) {
        mainWindow?.hide();
      }
    });
  }
  if (!isE2E) {
    initializeTray({
      iconPath: icon,
      onOpen: toggleMainWindow,
      onOpenDevTools: openRendererDevTools,
      onQuit: () => app.quit(),
      onStartRecording: () => {
        void startRecording()
          .catch((error) => {
            captureStartRecordingError(error);
          })
          .then(() => getSnapshot({ refreshHistory: true }).then(emitSnapshot));
      },
      onStopRecording: () => {
        void engine?.stopRecording().then(() => {
          installDownloadedUpdateIfReady();
          return getSnapshot({ refreshHistory: true }).then(emitSnapshot);
        });
      },
      onToggleLaunchAtLogin: () => {
        const nextSettings: AppSettings = {
          ...getSettings(),
          desktop: {
            ...getSettings().desktop,
            launchAtLogin: !getSettings().desktop.launchAtLogin
          }
        };
        setSettings(nextSettings);
        applyLoginItemSettings(nextSettings.desktop.launchAtLogin);
        void emitSnapshot();
      }
    });
  }
  if (settings.desktop.startRecordingOnLaunch) {
    try {
      await startRecording();
    } catch (error) {
      captureStartRecordingError(error);
    }
  }
  if (!isE2E) {
    initializeAutoUpdates({
      deferInstallWhen: () => lastStatus.recording,
      onSnapshot: () => {
        void emitSnapshot(buildSnapshot(), { force: true });
      }
    });
  }
};

// ── Daily Report Scheduler ───────────────────────────────────────────
type CronJob = ReturnType<typeof cron.schedule>;
let dailyReportCronJob: CronJob | null = null;

const initializeDailyReportScheduler = (): void => {
  if (isE2E) {
    log.info("[daily-report] Skipping scheduler in E2E mode");
    return;
  }

  const settings = getSettings();
  const outputDir = settings.recording.outputDir;
  const reportService = new DailyReportService(outputDir);

  // Schedule daily at 22:00 (10 PM) local time
  dailyReportCronJob = cron.schedule("0 22 * * *", async () => {
    log.info("[daily-report] Starting scheduled daily report generation");

    // Generate report for yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split("T")[0]; // YYYY-MM-DD format

    try {
      const result = await reportService.generateReport(dateStr);

      if (result.success) {
        const reportPath = join(outputDir, dateStr, "_processed", `daily_report_${dateStr}.md`);
        await reportService.sendFeishuNotification(result, reportPath);
        log.info(`[daily-report] Daily report completed for ${dateStr}`);
      } else {
        log.warn(`[daily-report] Report generation failed: ${result.errorMessage}`);
      }
    } catch (error) {
      log.error("[daily-report] Scheduled report error:", error);
    }
  });

  log.info("[daily-report] Scheduler initialized for 22:00 daily");
};

const shutdownDailyReportScheduler = (): void => {
  if (dailyReportCronJob) {
    dailyReportCronJob.stop();
    dailyReportCronJob = null;
    log.info("[daily-report] Scheduler stopped");
  }
};

ipcMain.handle("desktop:get-snapshot", () =>
  getSnapshot({
    refreshDevices: true,
    refreshHistory: true,
    refreshPermission: true
  })
);
ipcMain.handle("desktop:pick-directory", async (_event, defaultPath?: string) => {
  const options: OpenDialogOptions = {
    defaultPath: defaultPath && defaultPath.trim().length > 0 ? defaultPath : dirname(process.cwd()),
    properties: ["createDirectory", "openDirectory"]
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle("desktop:minimize-window", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.minimize();
});
ipcMain.handle("desktop:close-window", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.close();
});
ipcMain.handle("desktop:open-external", (_event, target: string) => shell.openExternal(target));
ipcMain.handle("desktop:open-recording-folder", async (_event, target: string) => {
  await shell.openPath(target);
});
ipcMain.handle("desktop:request-permission", async () => {
  activateAppForPermissionPrompt();
  const permission = isE2E
    ? cachedPermission
    : await requestMicrophonePermission().finally(() => {
        hideDockIcon();
      });
  cachedPermission = permission;
  await emitSnapshot(buildSnapshot());
  return permission;
});
ipcMain.handle("desktop:save-settings", async (_event, settings: AppSettings) => {
  const saved = setSettings(settings);
  applyLoginItemSettings(saved.desktop.launchAtLogin);
  applyTheme(saved.desktop.theme);
  await engine?.applySettings(saved);
  await emitSnapshot(
    await getSnapshot({
      refreshDevices: true,
      refreshHistory: true
    })
  );
  return saved;
});
ipcMain.handle("desktop:open-permission-settings", openMicrophonePrivacySettings);
ipcMain.handle("desktop:start-recording", async () => {
  await startRecording();
  return getSnapshot({ refreshHistory: true });
});
ipcMain.handle("desktop:stop-recording", async () => {
  await engine?.stopRecording();
  installDownloadedUpdateIfReady();
  return getSnapshot({ refreshHistory: true });
});
ipcMain.handle("desktop:run-transcribe", async (_event, inputDir: string) => {
  await engine?.runTranscribe(inputDir);
  return getSnapshot({ refreshHistory: true });
});
ipcMain.handle("desktop:set-window-pinned", async (_event, pinned: boolean) => {
  applyWindowPinnedState(Boolean(pinned));
  const snapshot = buildSnapshot();
  await emitSnapshot(snapshot);
  return snapshot;
});
ipcMain.handle("desktop:update-devices", async (_event, devices: DeviceInfo[]) => {
  cachedDevices = devices;
  engine?.updateDevices(devices);
  const snapshot = buildSnapshot();
  await emitSnapshot(snapshot, { force: true });
  return snapshot;
});
ipcMain.handle("desktop:capture-error", async (_event, message: string) => {
  engine?.reportCaptureError(message);
  const snapshot = buildSnapshot();
  await emitSnapshot(snapshot, { force: true });
  return snapshot;
});
ipcMain.on("desktop:audio-chunk", (_event, payload: {
  deviceId: string;
  deviceLabel: string;
  rms: number;
  sampleRate: number;
  samplesBuffer: ArrayBuffer;
  samplesLength: number;
}) => {
  const { samplesBuffer, samplesLength, ...rest } = payload;
  const samples = new Float32Array(samplesBuffer, 0, samplesLength);
  void engine?.pushAudioChunk({ ...rest, samples });
});

// Feishu IPC handlers
ipcMain.handle("feishu:get-config", () => {
  return getFeishuConfig();
});

ipcMain.handle("feishu:save-config", (_event, config: FeishuConfigInput) => {
  return setFeishuConfig(config);
});

ipcMain.handle("feishu:send-message", async (_event, receiveId: string, content: string) => {
  const config = getFeishuConfig();
  if (!config.enabled || !config.appId || !config.appSecret) {
    return { success: false, errorMessage: "Feishu is not configured" };
  }
  const service = new FeishuService(config.appId, config.appSecret);
  return service.sendTextMessage(receiveId || config.receiveId, content, config.receiveIdType);
});

ipcMain.handle("feishu:send-card", async (_event, receiveId: string, cardContent: Record<string, unknown>) => {
  const config = getFeishuConfig();
  if (!config.enabled || !config.appId || !config.appSecret) {
    return { success: false, errorMessage: "Feishu is not configured" };
  }
  const service = new FeishuService(config.appId, config.appSecret);
  return service.sendInteractiveCard(receiveId || config.receiveId, cardContent, config.receiveIdType);
});

ipcMain.handle("feishu:check-config", async () => {
  const config = getFeishuConfig();
  if (!config.enabled || !config.appId || !config.appSecret) {
    return { configured: false };
  }
  try {
    const service = new FeishuService(config.appId, config.appSecret);
    const result = await service.sendTextMessage(config.receiveId, "EVE 语音助手连接测试", config.receiveIdType);
    return { configured: true, success: result.success, errorMessage: result.errorMessage };
  } catch (error) {
    return { configured: true, success: false, errorMessage: String(error) };
  }
});

// Sentiment IPC handlers
ipcMain.handle("sentiment:get-config", () => {
  return getSentimentConfig();
});

ipcMain.handle("sentiment:save-config", (_event, config: SentimentConfigInput) => {
  return setSentimentConfig(config);
});

ipcMain.handle("sentiment:analyze", async (_event, text: string) => {
  const config = getSentimentConfig();
  if (!config.enabled || !config.apiKey || !config.baseUrl) {
    return { score: 0.0, label: "Error" as const };
  }
  const analyzer = new SentimentAnalyzer({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model
  });
  return analyzer.analyze(text);
});

// Daily Report IPC handlers
ipcMain.handle("daily-report:generate", async (_event, date: string) => {
  const settings = getSettings();
  const reportService = new DailyReportService(settings.recording.outputDir);
  return reportService.generateReport(date);
});

ipcMain.handle("daily-report:send-notification", async (_event, date: string) => {
  const settings = getSettings();
  const reportService = new DailyReportService(settings.recording.outputDir);
  const result = await reportService.generateReport(date);
  if (!result.success) {
    return { success: false, errorMessage: result.errorMessage };
  }
  const reportPath = join(settings.recording.outputDir, date, "_processed", `daily_report_${date}.md`);
  const sent = await reportService.sendFeishuNotification(result, reportPath);
  return { success: sent };
});

if (!isE2E && !app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  try {
    app.setName("Eve Recorder");
    if (process.platform === "win32") {
      app.setAppUserModelId("build.nexmoe.everecorder.desktop");
    }
    await bootstrapDesktop();
    initializeDailyReportScheduler();
  } catch (error) {
    console.error("[eve] failed to bootstrap desktop", error);
    app.exit(1);
  }
});

app.on("second-instance", () => {
  revealMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  isQuitting = true;
  shutdownDailyReportScheduler();
  if (!isE2E) {
    destroyTray();
    shutdownAutoUpdates();
  }
  if (isAutoUpdateInstalling()) {
    return;
  }
  if (quitAfterRecordingFinalize || !lastStatus.recording) {
    return;
  }
  event.preventDefault();
  quitAfterRecordingFinalize = true;
  void finalizeRecordingBeforeQuit()
    .catch((error) => {
      log.error("[eve] failed to finalize recording before quit", error);
    })
    .finally(() => {
      app.quit();
    });
});
