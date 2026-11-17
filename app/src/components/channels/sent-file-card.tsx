import {
  IconAlertTriangle,
  IconDownload,
  IconFileText,
  IconFileTypeCsv,
  IconFileTypePdf,
  IconJson,
  IconMarkdown,
  IconPhoto,
} from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { attachmentAddress } from "@/lib/channels/attachments";
import { fileSize, kindLabel, type SentFile } from "@/lib/computers/sent-file";
import {
  AttachmentLightbox,
  unavailableSentence,
  useDocumentIsGone,
} from "./attachment-view";

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
 */
export function SentFileCard({ file }: { file: SentFile }) {
  const address = attachmentAddress(file.url);
  const picture = file.mimeType.toLowerCase().startsWith("image/");
  const [failedToLoad, setFailedToLoad] = useState(false);
  const gone = useDocumentIsGone(address, !picture);

  if (failedToLoad || gone) {
    return (
      <div
        className="my-2 flex w-full max-w-sm items-center gap-3 rounded-xl border border-destructive border-dashed p-3 text-destructive"
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
      className="my-2 flex w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-muted/40"
    >
      {picture ? (
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
        className={`flex items-center gap-3 p-3 ${picture ? "border-border border-t" : ""}`}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground">
          <FileIcon mimeType={file.mimeType} />
        </span>
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
          Download
        </Button>
      </figcaption>
    </figure>
  );
}

function FileIcon({ mimeType }: { mimeType: string }) {
  const type = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  const Icon =
    type === "application/pdf"
      ? IconFileTypePdf
      : type === "text/csv"
        ? IconFileTypeCsv
        : type === "application/json"
          ? IconJson
          : type === "text/markdown"
            ? IconMarkdown
            : type.startsWith("image/")
              ? IconPhoto
              : IconFileText;
  return <Icon aria-hidden className="size-5" />;
}
