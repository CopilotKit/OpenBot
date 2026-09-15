import type { RunStore } from "../storage/run-store";
import type { WorkspaceManager } from "./workspace-manager";

export async function cleanupExpiredWorkspaces(
  store: RunStore,
  manager: Pick<WorkspaceManager, "remove">,
  before: number,
): Promise<string[]> {
  const removed: string[] = [];
  for (const run of store.listWorkspaceCleanupCandidates(before)) {
    if (!run.workspacePath) continue;
    await manager.remove(run.workspacePath);
    if (store.clearWorkspace(run.provider, run.runId, run.workspacePath)) {
      removed.push(run.workspacePath);
    }
  }
  return removed;
}
