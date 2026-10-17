import { Hono } from "hono";
import type { DemonstrationMediaStore } from "../demonstrations/media-store";
import type { RecorderVariables } from "./variables";

export function createRecorderMediaRoutes(_deps: {
  media: DemonstrationMediaStore;
}) {
  return new Hono<{ Variables: RecorderVariables }>(); // feature off
}
