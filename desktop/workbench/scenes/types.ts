import type { Answer } from "../../src/fakeNative/control";
import type { Problem } from "../../src/Problem";
import type { FrameConfig } from "../frameConfig";

export type SceneGroup =
  | "Install"
  | "Status"
  | "Update"
  | "Move to Cloud"
  | "Shutting down"
  | "Security floor"
  | "Connected";

/** `at` is in seconds from the scene start; `click` clicks the frame's button with that accessible name; `type` types the text into the field with the name `into`. */
export type RunStep =
  | { at: number; emit: string; payload: unknown }
  | { at: number; answer: string; with: Answer }
  | { at: number; settle: string; value: unknown }
  | { at: number; fail: string; problem: Problem }
  | { at: number; click: string }
  | { at: number; type: string; into: string };

export type Scene = {
  id: string;
  title: string;
  group: SceneGroup;
  start: Pick<FrameConfig, "hash" | "search"> &
    Partial<Pick<FrameConfig, "os" | "env" | "answers">>;
  run?: RunStep[];
};

export const SCENE_GROUPS: readonly SceneGroup[] = [
  "Install",
  "Update",
  "Connected",
  "Status",
  "Move to Cloud",
  "Shutting down",
  "Security floor",
];
