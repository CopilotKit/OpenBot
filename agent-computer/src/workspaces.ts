/**
 * Whose files a request reaches.
 *
 * WHY. One computer process can serve many Bots: Helm's default `computers.mode: shared` and the
 * docker-compose `agent-computer` service with no supervisor both do. Browser profiles were already
 * kept apart by the id each request names (`bot-id.ts`), but the workspace was one folder, so a note
 * one Bot saved for one person was a file every other Bot could list and read. With
 * `COMPUTER_SEPARATE_WORKSPACES=on` each id gets its own folder under the workspace root, and the
 * shell starts there with HOME pointing at it.
 *
 * WHY NOT ALWAYS. A computer the supervisor or the sandbox starts serves one Bot, and the desktop's
 * computer serves one person. Their files already sit at the root of the volume, and moving the
 * root under them would hide every file they had. So only the deployments that share one process
 * turn this on.
 *
 * WHAT IT IS NOT. A command is still a process in a shared container and can read any path the
 * container can. Separate folders keep each Bot's file tools to its own files and keep commands from
 * landing in another Bot's folder by default. Isolation between people who run commands needs a
 * computer each, which `computers.mode: sandbox` gives.
 */
import { mkdir } from "node:fs/promises";
import { isPlainBotId, UnusableBotIdError } from "./bot-id";
import { createShell, type Shell } from "./shell";
import { createWorkspace } from "./workspace";

export type Workspace = ReturnType<typeof createWorkspace>;

/** The folder an id's files live in. The same allow-list as profiles, so an id is one segment. */
export function workspaceDirectoryFor(
  root: string,
  botId: string,
  separate: boolean,
): string {
  if (!separate) return root;
  if (!isPlainBotId(botId)) throw new UnusableBotIdError(botId);
  return `${root}/computers/${botId}`;
}

export function createWorkspaces(
  root: string,
  separate: boolean,
  sourceEnv: NodeJS.ProcessEnv = process.env,
) {
  const made = new Map<string, { files: Workspace; shell: Shell }>();
  return {
    /** The files and shell for this id, creating its folder the first time it is used. */
    async for(botId: string): Promise<{ files: Workspace; shell: Shell }> {
      const directory = workspaceDirectoryFor(root, botId, separate);
      const known = made.get(directory);
      if (known) return known;
      await mkdir(directory, { recursive: true });
      const created = {
        files: createWorkspace(directory),
        shell: createShell(directory, sourceEnv),
      };
      made.set(directory, created);
      return created;
    },
  };
}
