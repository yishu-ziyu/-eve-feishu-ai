import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  DesktopSnapshot,
  DeviceInfo,
  MicrophonePermissionStatus
} from "@eve/shared";

export interface FeishuConfigInput {
  enabled: boolean;
  appId: string;
  appSecret: string;
  receiveId: string;
  receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  notifyOnRecordingComplete: boolean;
  notifyOnReviewComplete: boolean;
}

export interface FeishuMessageResult {
  success: boolean;
  errorMessage?: string;
}

export interface FeishuCheckResult {
  configured: boolean;
  success?: boolean;
  errorMessage?: string;
}

export interface SentimentConfigInput {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface SentimentResult {
  score: number;
  label: "Positive" | "Neutral" | "Negative" | "Error";
}

export interface DailyReportResult {
  success: boolean;
  date: string;
  sourceFileCount: number;
  segmentCount: number;
  totalChars: number;
  moodScore: number;
  moodLabel: string;
  errorMessage?: string;
}

export interface DesktopBridgeApi {
  bootstrap: () => Promise<DesktopSnapshot>;
  captureError: (message: string) => Promise<DesktopSnapshot>;
  closeWindow: () => Promise<void>;
  minimizeWindow: () => Promise<void>;
  pushAudioChunk: (payload: {
    deviceId: string;
    deviceLabel: string;
    rms: number;
    sampleRate: number;
    samples: Float32Array;
  }) => void;
  openRecordingFolder: (target: string) => Promise<void>;
  pickDirectory: (defaultPath?: string) => Promise<string | null>;
  onSnapshot: (listener: (snapshot: DesktopSnapshot) => void) => () => void;
  openExternal: (target: string) => Promise<void>;
  openMicrophoneSettings: () => Promise<boolean>;
  requestMicrophonePermission: () => Promise<MicrophonePermissionStatus>;
  runTranscribe: (inputDir: string) => Promise<DesktopSnapshot>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  setWindowPinned: (pinned: boolean) => Promise<DesktopSnapshot>;
  startRecording: () => Promise<DesktopSnapshot>;
  stopRecording: () => Promise<DesktopSnapshot>;
  updateDevices: (devices: DeviceInfo[]) => Promise<DesktopSnapshot>;
  feishuGetConfig: () => Promise<FeishuConfigInput>;
  feishuSaveConfig: (config: FeishuConfigInput) => Promise<FeishuConfigInput>;
  feishuSendMessage: (receiveId: string, content: string) => Promise<FeishuMessageResult>;
  feishuSendCard: (receiveId: string, cardContent: Record<string, unknown>) => Promise<FeishuMessageResult>;
  feishuCheckConfig: () => Promise<FeishuCheckResult>;
  sentimentGetConfig: () => Promise<SentimentConfigInput>;
  sentimentSaveConfig: (config: SentimentConfigInput) => Promise<SentimentConfigInput>;
  sentimentAnalyze: (text: string) => Promise<SentimentResult>;
  dailyReportGenerate: (date: string) => Promise<DailyReportResult>;
  dailyReportSendNotification: (date: string) => Promise<{ success: boolean; errorMessage?: string }>;
}

const api: DesktopBridgeApi = {
  bootstrap: () => ipcRenderer.invoke("desktop:get-snapshot"),
  captureError: (message) => ipcRenderer.invoke("desktop:capture-error", message),
  closeWindow: () => ipcRenderer.invoke("desktop:close-window"),
  minimizeWindow: () => ipcRenderer.invoke("desktop:minimize-window"),
  pushAudioChunk: ({ samples, ...payload }) => {
    // Pass the underlying ArrayBuffer + byteOffset/length so Electron's
    // structured-clone transfers binary data instead of serialising to a
    // plain number[].  This cuts per-chunk IPC memory roughly in half and
    // avoids creating a temporary Array of boxed Numbers.
    ipcRenderer.send("desktop:audio-chunk", {
      ...payload,
      samplesBuffer: samples.buffer.slice(
        samples.byteOffset,
        samples.byteOffset + samples.byteLength
      ),
      samplesLength: samples.length
    });
  },
  openRecordingFolder: (target) => ipcRenderer.invoke("desktop:open-recording-folder", target),
  pickDirectory: (defaultPath) => ipcRenderer.invoke("desktop:pick-directory", defaultPath),
  onSnapshot: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on("desktop:snapshot", wrappedListener);
    return () => {
      ipcRenderer.removeListener("desktop:snapshot", wrappedListener);
    };
  },
  openExternal: (target) => ipcRenderer.invoke("desktop:open-external", target),
  openMicrophoneSettings: () => ipcRenderer.invoke("desktop:open-permission-settings"),
  requestMicrophonePermission: () => ipcRenderer.invoke("desktop:request-permission"),
  runTranscribe: (inputDir) => ipcRenderer.invoke("desktop:run-transcribe", inputDir),
  saveSettings: (settings) => ipcRenderer.invoke("desktop:save-settings", settings),
  setWindowPinned: (pinned) => ipcRenderer.invoke("desktop:set-window-pinned", pinned),
  startRecording: () => ipcRenderer.invoke("desktop:start-recording"),
  stopRecording: () => ipcRenderer.invoke("desktop:stop-recording"),
  updateDevices: (devices) => ipcRenderer.invoke("desktop:update-devices", devices),
  feishuGetConfig: () => ipcRenderer.invoke("feishu:get-config"),
  feishuSaveConfig: (config) => ipcRenderer.invoke("feishu:save-config", config),
  feishuSendMessage: (receiveId, content) => ipcRenderer.invoke("feishu:send-message", receiveId, content),
  feishuSendCard: (receiveId, cardContent) => ipcRenderer.invoke("feishu:send-card", receiveId, cardContent),
  feishuCheckConfig: () => ipcRenderer.invoke("feishu:check-config"),
  sentimentGetConfig: () => ipcRenderer.invoke("sentiment:get-config"),
  sentimentSaveConfig: (config) => ipcRenderer.invoke("sentiment:save-config", config),
  sentimentAnalyze: (text) => ipcRenderer.invoke("sentiment:analyze", text),
  dailyReportGenerate: (date) => ipcRenderer.invoke("daily-report:generate", date),
  dailyReportSendNotification: (date) => ipcRenderer.invoke("daily-report:send-notification", date)
};

contextBridge.exposeInMainWorld("eve", api);
