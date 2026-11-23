import { IconAlertTriangle, IconDownload } from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { attachmentAddress } from "@/lib/channels/attachments";
import { fileSize, kindLabel, type SentFile } from "@/lib/computers/sent-file";
import {
  AttachmentLightbox,
  unavailableSentence,
  useDocumentIsGone,
} from "./attachment-view";
import { FileTypeIcon } from "./file-icon";

/**
 * A file a Bot sent from its computer, as it sits in the conversation.
 *
 * WHAT IT IS FOR. The Bot made something for the person (a chart, a report, a spreadsheet's CSV, a
 * PDF) and the person wants the thing itself, not a sentence saying where it is on a computer they
 * cannot open. So the card is the file: its name, its kind and size, a Download button, and for a
 * picture the picture itself, opening full size in the same lightbox the person's own pictures use.
 *
 * Drawn from the tool call's answer alone, so a reopened conversation draws the same card, and read
 * from the conversation's own attachment address, so every member of the conversation can open it
 * and nobody else can. The server serves it with the type it found in the bytes; only a picture
 * opens in the page, everything else downloads.
 *
 * The person's own files draw as tiles in a row under their message. This is one file in the Bot's
 * answer, so it is one card the width of the column (up to a comfortable reading width), with the
 * same border, fill and corners as those tiles.
 *
 * COMPACT, for a list (an approval of a reply that carries the file): no margin and no picture
 * across the card, the picture shrunk into the icon's place, still opening full size.
 */
export function SentFileCard({
  file,
  compact = false,
}: {
  file: SentFile;
  compact?: boolean;
}) {
  const address = attachmentAddress(file.url);
  const picture = file.mimeType.toLowerCase().startsWith("image/");
  const [failedToLoad, setFailedToLoad] = useState(false);
  const gone = useDocumentIsGone(address, !picture);

  if (failedToLoad || gone) {
    return (
      <div
        className={`${compact ? "" : "my-2 "}flex w-full max-w-sm items-center gap-3 rounded-xl border border-destructive border-dashed p-3 text-destructive`}
        role="note"
      >
        <IconAlertTriangle aria-hidden className="size-5 shrink-0" />
        <p className="min-w-0 text-sm">{unavailableSentence(file.name)}</p>
      </div>
    );
  }

  return (
    <figure
      aria-label={`File from the Bot: ${file.name}`}
      className={`${compact ? "" : "my-2 "}flex w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-muted/40`}
    >
      {picture && !compact ? (
        <AttachmentLightbox filename={file.name} url={address}>
          <img
            alt={file.name}
            className="max-h-64 w-full bg-muted object-contain"
            onError={() => setFailedToLoad(true)}
            src={address}
          />
        </AttachmentLightbox>
      ) : null}
      <figcaption
        className={`flex items-center gap-3 p-3 ${picture && !compact ? "border-border border-t" : ""}`}
      >
        {picture && compact ? (
          <AttachmentLightbox filename={file.name} url={address}>
            <img
              alt={file.name}
              className="size-10 shrink-0 rounded-lg border border-border bg-muted object-cover"
              onError={() => setFailedToLoad(true)}
              src={address}
            />
          </AttachmentLightbox>
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground">
            <FileTypeIcon className="size-5" mimeType={file.mimeType} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          {/* `title` because a long name is cut, not wrapped, in the narrow column. */}
          <span
            className="block truncate font-medium text-sm"
            title={file.name}
          >
            {file.name}
          </span>
          <span className="block text-muted-foreground text-xs">
            {kindLabel(file.mimeType, file.name)} · {fileSize(file.sizeBytes)}
          </span>
        </span>
        <Button
          aria-label={`Download ${file.name}`}
          nativeButton={false}
          render={<a download={file.name} href={address} />}
          size="sm"
          variant="outline"
        >
          <IconDownload data-icon="inline-start" />
          {/* In a list on a phone the button is its icon, so the file's name and size keep the room. */}
          <span className={compact ? "max-sm:sr-only" : undefined}>
            Download
          </span>
        </Button>
      </figcaption>
    </figure>
  );
}
