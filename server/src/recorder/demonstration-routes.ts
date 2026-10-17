import { Hono } from "hono";
import type { DemonstrationRecorder } from "../demonstrations/recording";
import type { DemonstrationStore } from "../demonstrations/store";
import type { RecorderVariables } from "./variables";

export type RecorderDemonstrationDeps = {
  store: DemonstrationStore;
  recorder: DemonstrationRecorder;
};

export function createRecorderDemonstrationRoutes(
  _deps: RecorderDemonstrationDeps,
) {
  return new Hono<{ Variables: RecorderVariables }>(); // feature off: every path 404s
}
