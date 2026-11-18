/**
 * The attachment limits and classification rules, re-exported from the one place they are declared.
 *
 * `shared/` is where the server checks the same limits, so a change to a number or a rule changes
 * both sides at once. This file exists so the browser code keeps importing through `@/`, and so the
 * path to `shared/` is written down once rather than in every composer file that needs it.
 */
export {
  ACCEPTED_DOCUMENT_MIME,
  ACCEPTED_FILE_TYPES,
  ACCEPTED_IMAGE_MIME,
  ACCEPTED_TEXT_MIME,
  type AttachmentKind,
  type AttachmentLimits,
  type AttachmentPart,
  type AttachmentSource,
  attachmentLimitsFrom,
  attachmentUrl,
  classifyAttachment,
  DEFAULT_ATTACHMENT_LIMITS,
  documentKindInWords,
  formatAttachmentLimit,
  LARGEST_PICTURE_DRAWN_INLINE,
  largestAttachmentBytes,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_BYTES,
  MAX_EXTRACTED_CHARACTERS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  mayBeTruncatedForModel,
  mediaTypeOf,
  namesNoFormat,
  shouldClaimPaste,
} from "@openbot/shared/attachments";

import { attachmentUrl as storedAttachmentUrl } from "@openbot/shared/attachments";
import { getGetAttachmentUrl } from "@/lib/api/generated/conversations/conversations";
import { organizationId } from "@/lib/api/request";

/**
 * Where the browser reads an attachment's bytes from: the API's address for it.
 *
 * A sent message names its attachment by the form `attachmentUrl` writes, which the server reads
 * when it builds a Bot's turn and which every message already sent keeps. That stored form does not
 * change. This is only where the app loads the file from to show it, with anything after the id
 * (a cache-busting query) carried over. Anything that is not a stored attachment is returned as it
 * is, to be refused by whoever asked.
 */
export function attachmentAddress(stored: string): string {
  const prefix = storedAttachmentUrl("");
  if (!stored.startsWith(prefix)) return stored;
  const [id = "", query] = stored.slice(prefix.length).split("?", 2);
  const address = getGetAttachmentUrl(organizationId(), decodeURIComponent(id));
  return query === undefined ? address : `${address}?${query}`;
}
