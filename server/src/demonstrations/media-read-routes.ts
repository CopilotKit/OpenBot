import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { DemonstrationMediaStore } from "./media-store";

export type MediaReadDeps = {
  media: DemonstrationMediaStore;
  /** The demonstration's owner, or null when it does not exist. */
  demonstrationOwner(demonstrationId: string): Promise<string | null>;
};

/** Cookie routes, mounted behind requireUser. */
export function createDemonstrationMediaReadRoutes(_deps: MediaReadDeps) {
  return new Hono<{ Variables: AppVariables }>(); // feature off: every path 404s
}
