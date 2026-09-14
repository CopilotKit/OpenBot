/**
 * The attachment limits and classification rules, re-exported from the one place they are declared.
 *
 * `shared/` is where the server checks the same limits, so a change to a number or a rule changes
 * both sides at once. This file exists so the browser code keeps importing through `@/`, and so the
 * path to `shared/` is written down once rather than in every composer file that needs it.
 */
export {
  ACCEPTED_IMAGE_MIME,
  ACCEPTED_TEXT_MIME,
  type AttachmentKind,
  type AttachmentPart,
  type AttachmentSource,
  attachmentUrl,
  classifyAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_EXTRACTED_CHARACTERS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  mediaTypeOf,
  namesNoFormat,
  shouldClaimPaste,
} from "../../../../shared/attachments";
