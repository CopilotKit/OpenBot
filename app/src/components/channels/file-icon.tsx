import {
  IconFile,
  IconFileText,
  IconFileTypeCsv,
  IconFileTypeDocx,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeXls,
  IconJson,
  IconMarkdown,
  IconPhoto,
  type TablerIcon,
} from "@tabler/icons-react";
import {
  type AcceptedFileType,
  mediaTypeOf,
} from "@openbot/shared/attachments";

/**
 * The icon for each kind of file OpenBot takes, keyed by the one list of them
 * (`ACCEPTED_FILE_TYPES` in shared/attachments.ts). Typed as a record over every type on that list,
 * so a type added there does not build until it has an icon here.
 */
export const FILE_TYPE_ICONS = {
  "image/png": IconPhoto,
  "image/jpeg": IconPhoto,
  "image/gif": IconPhoto,
  "image/webp": IconPhoto,
  "application/pdf": IconFileTypePdf,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    IconFileTypeDocx,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    IconFileTypeXls,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    IconFileTypePpt,
  "text/plain": IconFileText,
  "text/markdown": IconMarkdown,
  "text/csv": IconFileTypeCsv,
  "application/json": IconJson,
} as const satisfies Record<AcceptedFileType["mimeType"], TablerIcon>;

/** A file's icon by the type the server found in it; the plain file icon for a type not known. */
export function FileTypeIcon({
  mimeType,
  className,
}: {
  mimeType: string | undefined;
  className?: string;
}) {
  const type = mediaTypeOf(mimeType ?? "");
  const Icon =
    type in FILE_TYPE_ICONS
      ? FILE_TYPE_ICONS[type as keyof typeof FILE_TYPE_ICONS]
      : IconFile;
  return <Icon aria-hidden className={className} />;
}
