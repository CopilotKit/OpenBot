/*
 * The contract between the workbench page and the app frame: the types and the checks that both
 * the desktop package and the app package type-check. Apart from types, it imports only the
 * app's own constants from shared/, so the workbench never keeps a copy of them.
 */
import {
  SIDEBAR_STORAGE_KEY,
  SKIN_STORAGE_KEY,
} from "../../shared/app-storage-keys";
import { SKIN_IDS, type SkinId } from "../../shared/user-preferences";
import type { Answer } from "../src/fakeNative/control";
import type { Os } from "./frameConfig";

/** Where the app runs: inside OpenBot Desktop, or in a plain browser tab. */
export type AppHost = "desktop" | "browser";

/** Every skin OpenBot ships: the app's own list (`SKIN_IDS`), never a copy of it. */
export const APP_SKINS = SKIN_IDS;
export type AppSkin = SkinId;

/** Whether the app's sidebar starts open or closed. */
export const APP_SIDEBARS = ["open", "closed"] as const;
export type AppSidebar = (typeof APP_SIDEBARS)[number];

/** The browser keys the app reads its skin and its sidebar from before the first paint. */
export { SIDEBAR_STORAGE_KEY, SKIN_STORAGE_KEY };

/** The person's preferences route: the account's skin wins over the stored one (SkinAccountSync). */
export const PREFERENCES_ROUTE =
  "GET /api/v2/organizations/:organizationId/people/:personId/preferences";

export type Role = "member" | "admin" | "owner";

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "ALL",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** An MSW path pattern with a method: "GET /api/v2/organizations/:organizationId/bots", "ALL /api/*". */
export type ApiRoute = `${HttpMethod} /api/${string}`;

export type ApiAnswer =
  /** `status` defaults to 200. */
  | { mode: "value"; status?: number; body: unknown }
  | { mode: "never" }
  /** `body` defaults to `{ detail: "The request failed." }`. */
  | { mode: "fail"; status: number; body?: unknown }
  | { mode: "delay"; ms: number; status?: number; body: unknown }
  /** `fetch` rejects with `TypeError("Failed to fetch")`. */
  | { mode: "offline" };

/** Which part of the fake API answered a request. */
export type ApiSource = "answer" | "stream" | "extra" | "spec" | "none";

/** One request to `/api`. `at` is in browser performance milliseconds. */
export type ApiRecord = {
  id: number;
  method: string;
  path: string;
  at: number;
  source: ApiSource;
  route: ApiRoute | null;
  status: number | null;
  state: "pending" | "answered" | "failed";
};

export type ApiChange =
  | { kind: "request"; record: ApiRecord }
  | { kind: "settled"; record: ApiRecord }
  | { kind: "answer"; route: ApiRoute };

/** The sentence of the fake API's 404 for a request that nothing answers. */
export const NO_ANSWER_DETAIL = "The workbench has no answer for this request.";

export interface ApiControl {
  setAnswer(route: ApiRoute, answer: ApiAnswer): void;
  clearAnswer(route: ApiRoute): void;
  answers(): ReadonlyMap<ApiRoute, ApiAnswer>;
  /**
   * The set answer that a request (its method and path with the query) gets now, newest first,
   * by the fake API's own route matching. Null when no answer matches.
   */
  answerFor(request: {
    method: string;
    path: string;
  }): { route: ApiRoute; answer: ApiAnswer } | null;
  requests(): readonly ApiRecord[];
  onChange(listener: (change: ApiChange) => void): () => void;
}

export type AgUiEventLike = { type: string } & Record<string, unknown>;

export type StreamRecord = {
  id: number;
  agent: string;
  path: string;
  open: boolean;
  sent: number;
};

export interface StreamControl {
  streams(): readonly StreamRecord[];
  push(agent: string, events: readonly AgUiEventLike[]): void;
  end(agent: string): void;
  onChange(listener: () => void): () => void;
}

export type SocketRecord = {
  id: number;
  url: string;
  state: "connecting" | "open" | "closed";
  sent: string[];
  received: number;
};

export interface SocketControl {
  sockets(): readonly SocketRecord[];
  /** Sends `data` to each open socket whose URL contains `match`. Gives the number of sockets. */
  send(match: string, data: unknown): number;
  /** Closes each socket whose URL contains `match`. Gives the number of sockets. */
  close(match: string, code?: number): number;
  onChange(listener: () => void): () => void;
}

export type Session =
  | { signedIn: false }
  | {
      signedIn: true;
      role: Role;
      name: string;
      email: string;
      organization: { id: string; name: string };
      onboarded: boolean;
    };

export type AppSceneStart = {
  route: string;
  host: AppHost;
  os?: Os;
  session: Session;
  api?: Partial<Record<ApiRoute, ApiAnswer>>;
  answers?: Record<string, Answer>;
  storage?: Record<string, string>;
  /** The agent ids that the runtime's info lists. Default: the ids of the generated Bots list. */
  agents?: readonly string[];
  /** The person's skin. Not set: the default skin (`openbot`). */
  skin?: AppSkin;
  /** Whether the sidebar starts open or closed. Not set: open, as the app starts it. */
  sidebar?: AppSidebar;
};

export type AppScene = {
  kind: "app";
  id: string;
  title: string;
  group: "App";
  start: AppSceneStart;
};

/** What one app frame starts with. The frame reads it from `window.parent.__workbenchAppFrame`. */
export type AppFrameConfig = {
  scene: string;
  host: AppHost;
  os: Os;
  theme: "light" | "dark";
  role: Role | null;
  /** The skin the frame shows: the link's, else the scene's, else null (the default skin). */
  skin: AppSkin | null;
  /** The sidebar at the start: the link's, else the scene's, else null (as the app starts it). */
  sidebar: AppSidebar | null;
  api: Partial<Record<ApiRoute, ApiAnswer>>;
  answers: Record<string, Answer>;
  storage: Record<string, string>;
};

export const APP_PREFIX = "/__app/";
export const APP_SERVER_PORT = 3023;

const API_ROUTE = /^(GET|POST|PUT|PATCH|DELETE|ALL) \/api\/\S*$/;

export function isApiRoute(text: string): text is ApiRoute {
  return API_ROUTE.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

/** Gives the answer when `value` is a valid ApiAnswer, else null. */
export function parseApiAnswer(value: unknown): ApiAnswer | null {
  if (!isRecord(value)) return null;
  const hasStatus = "status" in value && value.status !== undefined;
  if (hasStatus && !isStatus(value.status)) return null;
  const status = hasStatus ? (value.status as number) : undefined;
  switch (value.mode) {
    case "value":
      if (!("body" in value)) return null;
      return status === undefined
        ? { mode: "value", body: value.body }
        : { mode: "value", status, body: value.body };
    case "never":
      return { mode: "never" };
    case "fail":
      if (status === undefined) return null;
      return "body" in value && value.body !== undefined
        ? { mode: "fail", status, body: value.body }
        : { mode: "fail", status };
    case "delay": {
      const ms = value.ms;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
      if (!("body" in value)) return null;
      return status === undefined
        ? { mode: "delay", ms, body: value.body }
        : { mode: "delay", ms, status, body: value.body };
    }
    case "offline":
      return { mode: "offline" };
    default:
      return null;
  }
}

const HOSTS: readonly string[] = ["desktop", "browser"];

/** A shallow check: enough to tell an app scene from a desktop scene or a broken file. */
export function isAppScene(value: unknown): value is AppScene {
  if (!isRecord(value)) return false;
  if (value.kind !== "app") return false;
  if (typeof value.id !== "string" || typeof value.title !== "string") {
    return false;
  }
  if (value.group !== "App") return false;
  const start = value.start;
  if (!isRecord(start)) return false;
  if (typeof start.route !== "string" || !start.route.startsWith("/")) {
    return false;
  }
  if (typeof start.host !== "string" || !HOSTS.includes(start.host)) {
    return false;
  }
  if (!isRecord(start.session)) return false;
  return true;
}

declare global {
  interface Window {
    __workbenchAppFrame?: AppFrameConfig;
    __workbenchApi?: ApiControl;
    __workbenchStreams?: StreamControl;
    __workbenchSockets?: SocketControl;
    __workbenchErrors?: string[];
  }
}
