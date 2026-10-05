import { IconX } from "@tabler/icons-react";

import { Collapse } from "./collapse";

/**
 * One line per refusal, not one message for the batch: dropping two bad files onto the composer at
 * once must produce two reasons, because folding them into a single string ("2 files were
 * rejected") or overwriting one reason with the next reports one refusal for two problems, and the
 * person can no longer tell which file failed for which reason.
 */
/**
 * `id` exists because `name` cannot be the key: two files sharing a name is the ordinary case here
 * (drag one `screenshot.png` from two different folders), not a contrived one, and this component
 * exists so that two refusals produce two lines rather than one collapsing into the other. Minting
 * that identity is the caller's job — whatever builds this list owes it an `id` per entry.
 */
export type RejectedFile = { id: string; name: string; reason: string };

/**
 * Purely presentational: the composer decides which files to refuse and why (see
 * `shared/attachments.ts` for the limits behind those reasons); this only renders the list it is
 * handed. `role="alert"` matches every other error line in this app (standing instructions, channel
 * pin errors): a refusal is something the person needs to notice.
 */
export function RejectedFiles({
  onDismiss,
  rejected,
}: {
  /**
   * Required rather than optional, because a list with no way out is the defect this argument
   * closes. A refusal is the only thing on this composer with no natural end: an attachment leaves
   * when it is sent or removed, typed words leave when they are sent, and a reason for a file that
   * never made it in has neither. Sending clears these too (see `submitDraft`), but somebody who
   * drops an SVG and then walks away should not have to send a message to be rid of the sentence
   * about it.
   */
  onDismiss: () => void;
  rejected: readonly RejectedFile[];
}) {
  return (
    /*
     * Collapsed rather than switched on and off, because this sits directly against the composer:
     * its arrival and its dismissal each move the box somebody is typing in, and it is the one
     * thing here that appears without being asked for — the worst kind of thing to have jump.
     *
     * The ALERT unmounts the moment it is dismissed rather than fading, because a `role="alert"`
     * left in the tree is still an alert: invisible to the eye, still there to a screen reader, and
     * still there to a test asking whether the refusal is gone. `Collapse` is built for exactly
     * that — it keeps the height it measured while open, so the empty box still closes over it.
     */
    /*
     * THE GAP IS `pb-2` ON THE MEASURED BOX, AND IT USED TO BE `mb-2` ON THE ALERT, WHICH IS NOT
     * THE SAME THING HERE.
     *
     * `Collapse` animates to `content.offsetHeight`, and `offsetHeight` is the border-box height:
     * padding counts, margins do not. The content wrapper has no border and no padding of its own,
     * so the alert's bottom margin collapsed straight out of the number being measured — the box
     * settled 8px short and the gap between the refusals and the composer directly under them was
     * never drawn. `AttachmentStrip` spends `pb-3` inside its own `Collapse` for exactly this
     * reason, and this is the same bargain.
     *
     * On the wrapper rather than on the alert, unlike the strip's: the alert has a dashed border,
     * so padding spent inside it would land within that border instead of under it — a taller
     * dashed box rather than a gap below one.
     */
    <Collapse className="pb-2" open={rejected.length > 0}>
      {rejected.length > 0 ? (
        <div
          className="flex items-start gap-2 rounded-lg border border-destructive border-dashed p-2"
          role="alert"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {rejected.map((file) => (
              <p className="text-destructive text-sm" key={file.id}>
                <span className="font-medium">{file.name}</span>: {file.reason}
              </p>
            ))}
          </div>
          {/*
           * One button for the block, not one per line. These arrive together — a drop of eight
           * files refuses several at once — and are read together, so dismissing them one at a
           * time is work without a purpose.
           */}
          <button
            aria-label={
              rejected.length === 1
                ? "Dismiss this refusal"
                : `Dismiss these ${rejected.length} refusals`
            }
            className="-m-1 shrink-0 rounded p-1 text-destructive/70 transition-colors hover:text-destructive"
            onClick={onDismiss}
            type="button"
          >
            <IconX className="size-4" />
          </button>
        </div>
      ) : null}
    </Collapse>
  );
}
