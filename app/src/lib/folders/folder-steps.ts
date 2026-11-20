import { inFolder, ownToolSubject } from "@openbot/shared/tool-name";
import { createContext } from "react";

/**
 * A Bot's steps on folders on the person's computer (`host_*` tools), as a person reads them.
 *
 * The tools answer the model: "Check your folders" answers JSON naming each folder by the id OpenBot
 * gave its grant ({"connected":true,"folders":[{"grantId":"host-grant-7712-…","displayName":"share"}]}),
 * and every other step names its folder only by that id. Opened, a step showed that JSON as it came.
 * The person reads the folder's name, the file in it ("todo.txt in share"), and no JSON or id.
 */

/** Folder names by grant id, from the "Check your folders" answers in the conversation. */
export type FolderNames = ReadonlyMap<string, string>;

export const FolderNamesContext = createContext<FolderNames>(new Map());

/** What "Check your folders" answered, or undefined when it is not that answer. */
function readListing(
  answer: string | undefined,
): { connected: boolean; folders: { id: string; name: string }[] } | undefined {
  if (!answer) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { connected, folders } = parsed as {
    connected?: unknown;
    folders?: unknown;
  };
  if (!Array.isArray(folders)) return undefined;
  return {
    connected: connected !== false,
    folders: folders.flatMap((folder) => {
      const { grantId, displayName } = (folder ?? {}) as {
        grantId?: unknown;
        displayName?: unknown;
      };
      return typeof grantId === "string" && typeof displayName === "string"
        ? [{ id: grantId, name: displayName }]
        : [];
    }),
  };
}

/** Every folder the conversation's "Check your folders" steps named, by grant id. */
export function folderNamesIn(
  steps: readonly {
    toolCall: { function: { name: string } };
    result?: string;
  }[],
): FolderNames {
  const names = new Map<string, string>();
  for (const step of steps) {
    if (step.toolCall.function.name !== "host_list_folders") continue;
    for (const folder of readListing(step.result)?.folders ?? [])
      names.set(folder.id, folder.name);
  }
  return names;
}

/**
 * What a folder step is about, beside its words: "todo.txt in share", or "in share" for a step on
 * the whole folder. Undefined for any other step, and for a folder step whose folder is not named
 * in the conversation, which keeps the file alone.
 */
export function folderStepSubject(
  name: string,
  args: unknown,
  folders: FolderNames,
): string | undefined {
  if (!name.startsWith("host_") || name === "host_list_folders")
    return undefined;
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const grantId =
    value && typeof value === "object"
      ? (value as { grantId?: unknown }).grantId
      : undefined;
  return inFolder(
    ownToolSubject(name, args),
    typeof grantId === "string" ? folders.get(grantId) : undefined,
  );
}

/**
 * What an opened folder step shows: "Check your folders" in words, and nothing for any other folder
 * step's answer that is JSON, which was written for the model. Any other step's answer is returned as
 * it is: a file's contents, a command's output, the sentence a save answers.
 */
export function folderStepBody(
  name: string,
  body: string | undefined,
): string | undefined {
  if (!name.startsWith("host_") || body === undefined) return body;
  if (name === "host_list_folders") {
    const listing = readListing(body);
    if (!listing) return undefined;
    const names = listing.folders.map((folder) => folder.name);
    return [
      names.length > 0
        ? `Folders it can read: ${names.join(", ")}.`
        : "No folders are shared with this Bot.",
      ...(listing.connected ? [] : ["OpenBot Desktop isn't running."]),
    ].join(" ");
  }
  const trimmed = body.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? undefined : body;
}
