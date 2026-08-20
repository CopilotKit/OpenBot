import type { InputMessage } from "./screencast";
import type { ProfileSummary } from "./profiles";

export { VIEWPORT } from "./profiles";

export type BrowserElement = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  type?: string;
  disabled?: boolean;
  checked?: boolean;
};

export type PageRead = {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
};

export type BrowserSnapshot = {
  snapshotId: number;
  url: string;
  title: string;
  elements: BrowserElement[];
  truncated: boolean;
};

export type BrowserScreenshot = {
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
  url: string;
};

export type BrowserAction = {
  action: "click" | "type" | "key" | "scroll";
  ref?: string;
  characters?: number;
  submitted?: boolean;
  key?: string;
  deltaY?: number;
  url: string;
};

export type HumanAction = {
  action: "human_click" | "human_type" | "human_key" | "human_scroll";
  characters?: number;
  key?: string;
  deltaY?: number;
  url: string;
};

export type FrameMessage = {
  type: "frame";
  data: string;
  width: number;
  height: number;
  mimeType?: string;
};

export type BrowserStream = {
  stop: () => Promise<void>;
  send: (message: InputMessage) => Promise<void>;
};

export class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

export interface BrowserComputer {
  navigate(url: string, signal?: AbortSignal): Promise<PageRead>;
  read(): Promise<PageRead>;
  screenshot(): Promise<BrowserScreenshot>;
  snapshot(): Promise<BrowserSnapshot>;
  click(
    ref: string,
    snapshotId?: number,
    signal?: AbortSignal,
  ): Promise<BrowserAction>;
  type(
    ref: string,
    text: string,
    submit: boolean,
    snapshotId?: number,
    signal?: AbortSignal,
  ): Promise<BrowserAction>;
  key(
    key: string,
    ref?: string,
    snapshotId?: number,
    signal?: AbortSignal,
  ): Promise<BrowserAction>;
  scroll(deltaY: number, signal?: AbortSignal): Promise<BrowserAction>;
  enterSecret(
    ref: string,
    text: string,
  ): Promise<{ characters: number; url: string }>;
  humanClick(x: number, y: number): Promise<HumanAction>;
  humanType(text: string): Promise<HumanAction>;
  humanKey(key: string): Promise<HumanAction>;
  humanScroll(deltaY: number): Promise<HumanAction>;
  startStream(onFrame: (frame: FrameMessage) => void): Promise<BrowserStream>;
}

export interface BrowserManager {
  backend: "playwright" | "cua-driver";
  computer(botId: string): BrowserComputer;
  known(): Promise<string[]>;
  summary(botIds: string[]): ProfileSummary[];
  stop(botId: string): Promise<boolean>;
  reset(botId: string): Promise<void>;
  closeAll(): Promise<void>;
}
