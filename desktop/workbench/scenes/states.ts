import { STATE_NAMES } from "../../src/fakeNative/states";
import type { Scene, SceneGroup } from "./types";

function groupOf(hash: string, search: string): SceneGroup {
  if (hash === "#status") return "Status";
  if (hash.startsWith("#move-")) return "Move to Cloud";
  if (
    hash.startsWith("#connect-app-too-old") ||
    hash === "#connect-session-ended"
  ) {
    return "Connected";
  }
  if (
    hash === "#update-short" ||
    hash === "#backend-short" ||
    hash === "#start" ||
    hash.startsWith("#local-") ||
    (hash === "" && (search === "?offer" || search === "?internal"))
  ) {
    return "Update";
  }
  return "Install";
}

/** One scene for every state the fake native side can show. */
export const STATE_SCENES: readonly Scene[] = STATE_NAMES.map((entry) => ({
  id: `state-${entry.hash.replace("#", "") || "first-run"}${
    entry.search ? `-${entry.search.replace("?", "")}` : ""
  }`,
  title: entry.title,
  group: groupOf(entry.hash, entry.search),
  start: { hash: entry.hash, search: entry.search },
}));
