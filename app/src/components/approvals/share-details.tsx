import { attachmentUrl as storedAttachmentUrl } from "@openbot/shared/attachments";
import { PRIVATE_SHARE_TOOL_REF } from "@openbot/shared/tool-name";
import { useCallback, useState } from "react";
import { SentFileCard } from "@/components/channels/sent-file-card";
import type { SentFile } from "@/lib/computers/sent-file";
import {
  BotMarkdown,
  markdownComponents,
  markdownPlugins,
  replyRemarkPlugins,
} from "@/lib/markdown";
import { cn } from "@/lib/utils";

/** An approval as much as a share's details read: what it is, where it goes, what it sends. */
type ShareAction = { toolRef: string; target?: unknown; args?: unknown };

/**
 * What a request to share something private says to the person: who reads it, as one sentence,
 * and the text itself. Null for any other request.
 *
 * Handed to another person's Bot, the sentence says who reads it. When the person also asks before
 * changes, one card is both asks, so it says it hands the work over and shares the text.
 */
export function shareOf(action: ShareAction): {
  caption: string | undefined;
  text: string | undefined;
  files: SentFile[];
} | null {
  if (action.toolRef !== PRIVATE_SHARE_TOOL_REF) return null;
  const share = (action.args ?? {}) as {
    preview?: unknown;
    audience?: unknown;
    handOff?: unknown;
    files?: unknown;
  };
  const handedTo =
    typeof share.handOff === "string"
      ? share.handOff
      : (action.target as { kind?: unknown } | undefined)?.kind === "handoff" &&
          typeof share.audience === "string"
        ? share.audience
        : undefined;
  return {
    caption: handedTo
      ? typeof share.handOff === "string"
        ? `${handedTo} belongs to someone else, so this also shares the text below with them.`
        : `${handedTo} belongs to someone else, so they can read the text below.`
      : undefined,
    text:
      typeof share.preview === "string" && share.preview.trim()
        ? share.preview
        : undefined,
    files: filesOf(share.files),
  };
}

/**
 * The files a held reply carries, as the server names them on its request (`args.files`): what a
 * Bot sent from its computer with a reply in a group, shown with the words so the person sees the
 * files they would share. Anything not shaped like one is left out.
 */
function filesOf(value: unknown): SentFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) => {
    const { id, name, mimeType, sizeBytes } = (file ?? {}) as Record<
      string,
      unknown
    >;
    return typeof id === "string" &&
      id &&
      typeof name === "string" &&
      typeof mimeType === "string" &&
      typeof sizeBytes === "number"
      ? [
          {
            attachmentId: id,
            name,
            mimeType,
            sizeBytes,
            url: storedAttachmentUrl(id),
          },
        ]
      : [];
  });
}

/**
 * What a share would send, whole, as it will look where it goes. A short text is shown as it is. A
 * long one is cut to a few lines and faded at the foot, with Show all to read the rest in place, as
 * a step's output is in the conversation. Never a box that scrolls on its own: where scroll bars
 * hide until used, the end of the text looked like the end of the box, and the person allowed
 * words they never saw.
 *
 * THE WORDS ARE DRAWN AS THE CONVERSATION DRAWS THEM, AND THE FILES AS THEIR CARDS. Shown as the
 * stored text, a group reply that sent a file read "Sent [group-budget.csv](/api/attachments/…)"
 * and "Attached: **group-budget.csv**", so the person deciding whether to share a file read a URL
 * and asterisks and never saw the file (found by the end-to-end pass). The cards are the compact
 * ones a list has room for; the person may open or download the file, which is their Bot's.
 */
export function ShareText({
  text,
  files = [],
}: {
  text: string | undefined;
  files?: readonly SentFile[];
}) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const measure = useCallback((element: HTMLQuoteElement | null) => {
    if (element) setLong(element.scrollHeight > element.clientHeight + 1);
  }, []);
  if (!text) return <SharedFiles files={files} />;
  return (
    <div className="space-y-2">
      <div className="rounded bg-muted p-3 text-xs">
        <blockquote
          aria-label="What it would send"
          className={cn(
            "relative break-words text-foreground text-sm",
            open ? "" : "max-h-40 overflow-hidden",
          )}
          ref={measure}
        >
          <BotMarkdown
            components={markdownComponents}
            plugins={markdownPlugins}
            remarkPlugins={replyRemarkPlugins}
          >
            {text}
          </BotMarkdown>
          {long && !open ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-muted to-transparent"
            />
          ) : null}
        </blockquote>
        {long ? (
          <button
            aria-expanded={open}
            className="mt-1.5 font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(!open)}
            type="button"
          >
            {open ? "Show less" : "Show all"}
          </button>
        ) : null}
      </div>
      <SharedFiles files={files} />
    </div>
  );
}

/** The files a share would send, each as its compact card. */
function SharedFiles({ files }: { files: readonly SentFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Files it would send" className="space-y-2">
      {files.map((file) => (
        <li key={file.attachmentId}>
          <SentFileCard compact file={file} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A share as a list row shows it under the request: the same sentence and text its card in the
 * conversation shows, so the person reads the same thing in both places before they answer.
 */
export function ShareDetails({
  action,
  className,
}: {
  action: ShareAction;
  className?: string;
}) {
  const share = shareOf(action);
  if (!share || (!share.caption && !share.text && share.files.length === 0))
    return null;
  return (
    <div className={cn("space-y-2", className)}>
      {share.caption ? (
        <p className="text-muted-foreground text-sm">{share.caption}</p>
      ) : null}
      {share.text || share.files.length > 0 ? (
        <ShareText files={share.files} text={share.text} />
      ) : null}
    </div>
  );
}
