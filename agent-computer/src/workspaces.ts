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
 * WHO TURNS IT ON. Every computer that serves more than one Bot: the shared computer, and the one
 * computer per person the supervisor and the sandbox now make, which carries each of that person's
 * Bots. A computer that predates this has its files at the root of its volume, and moving the root
 * under it would hide every file it had, so the switch is set where a computer is created rather
 * than assumed here.
 *
 * WHAT IT IS NOT. A command is still a process in a shared container and can read any path the
 * container can. Separate folders keep each Bot's file tools to its own files and keep commands from
 * landing in another Bot's folder by default. Isolation between people who run commands needs a
 * computer each, which `computers.mode: sandbox` gives.
 */
import { mkdir } from "node:fs/promises";
import { isUsableSeatId, UnusableBotIdError } from "./bot-id";
import { createShell, type Shell } from "./shell";

export type { Shell };
import { createWorkspace } from "./workspace";

export type Workspace = ReturnType<typeof createWorkspace>;

/**
 * The folder a seat's files live in. The same allow-list as profiles, so a seat is one segment.
 *
 * A seat is a Bot, or a person and a Bot on a computer many people share (see `seatIdFor`).
 */
export function workspaceDirectoryFor(
  root: string,
  seatId: string,
  separate: boolean,
): string {
  if (!separate) return root;
  if (!isUsableSeatId(seatId)) throw new UnusableBotIdError(seatId);
  return `${root}/computers/${seatId}`;
}

export function createWorkspaces(
  root: string,
  separate: boolean,
  sourceEnv: NodeJS.ProcessEnv = process.env,
) {
  const files = new Map<string, Workspace>();
  /*
   * A live shell for each seat, not each folder. A shell now outlives its commands (live-shell.ts),
   * and so does whoever holds its wheel, which is a seat's: on a computer that keeps one folder for
   * every Bot, two Bots sharing a shell would type into each other's lines and into a person's.
   */
  const shells = new Map<string, Shell>();
  return {
    /** The files and shell for this id, creating its folder the first time it is used. */
    async for(seatId: string): Promise<{ files: Workspace; shell: Shell }> {
      const directory = workspaceDirectoryFor(root, seatId, separate);
      let known = files.get(directory);
      if (!known) {
        await mkdir(directory, { recursive: true });
        known = files.get(directory) ?? createWorkspace(directory);
        files.set(directory, known);
      }
      let shell = shells.get(seatId);
      if (!shell) {
        shell = createShell(directory, sourceEnv);
        shells.set(seatId, shell);
      }
      return { files: known, shell };
    },
    /** This seat's shell if it has one, without making one: for the paths that end things. */
    existingShell(seatId: string): Shell | undefined {
      return shells.get(seatId);
    },
  };
}
