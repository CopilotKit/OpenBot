import { IconFile, IconX } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";

import { Skeleton } from "@/components/ui/skeleton";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { Collapse } from "./collapse";

/**
 * WHAT IS ON THE COMPOSER, DRAWN AS ITS OWN ROW ACROSS THE TOP.
 *
 * `PromptArea` will draw this strip itself, given `images` and `files`, and it did until this
 * existed. Three things were wrong with that, and all three come from the same fact: the strip is
 * inside the editor's column, and on the compact composer that column is the MIDDLE of a row whose
 * first child is the attach button.
 *
 * So the strip started 42px in from the composer's left edge, hanging off nothing, instead of
 * lining up with the frame the way every reference composer draws it. Its thumbnails are a
 * hardcoded `h-16 w-16` with no prop to say otherwise. And its padding is a hardcoded `pb-2`,
 * which this file previously reached in and overrode by class name.
 *
 * Each of those could be forced from outside with a selector into somebody else's DOM, and for a
 * while one of them was. Three of them stacked is a component we have forked in CSS without saying
 * so, and it breaks silently on the next `prompt-area` release. Fifty lines of our own markup is
 * the cheaper of the two.
 *
 * Both composer branches use this, so there is one strip in the app rather than a compact one and
 * a full-size one that drift.
 */

/**
 * `url` is empty while the upload is in flight — the SDK has no bytes to point at yet — which is
 * why `loading` is not merely cosmetic here: an `<img src="">` re-requests the whole page in some
 * browsers, and React says so in the console.
 */
export type StagedImage = {
  id: string;
  url: string;
  alt?: string;
  loading: boolean;
};

export type StagedFile = {
  id: string;
  name: string;
  size?: number;
  loading: boolean;
};

export function AttachmentStrip({
  files,
  images,
  onRemove,
}: {
  files: readonly StagedFile[];
  images: readonly StagedImage[];
  onRemove: (id: string) => void;
}) {
  const occupied = images.length > 0 || files.length > 0;

  return (
    /*
     * `items-start` rather than a stretch, so a wrapped second line of thumbnails sits under the
     * first rather than growing to match the tallest thing on its own line.
     *
     * The list stays mounted while empty, which is what gives `Collapse` something to measure: a
     * box with nothing in it cannot report the height it is meant to animate to.
     *
     * `aria-hidden` is the price of that, and it is not optional. Height 0 under `overflow-hidden`
     * is a VISUAL state and nothing more — it does not take an element out of the accessibility
     * tree the way `display: none` does. Left as it was, a composer carrying nothing still offered
     * a screen reader a labelled list to walk into and announce as "Attachments, list, 0 items".
     * Empty and unheard is the state we want; empty is only half of it.
     *
     * Hiding a subtree that contains something focusable is its own defect, and this cannot commit
     * it: `occupied` is false exactly when both lists are empty, so there is nothing inside to
     * reach when the attribute is on.
     */
    <Collapse open={occupied}>
      <ul
        aria-hidden={!occupied}
        aria-label="Attachments"
        className="flex flex-wrap items-start gap-2 pb-3"
      >
        {images.map((image) => (
          <Staged key={image.id}>
            {image.loading || image.url === "" ? (
              /*
               * The placeholder stands in for the picture, so it carries the picture's role and
               * the picture's name — otherwise the tile is a shape and nothing else, and the only
               * thing a screen reader finds in it is a button offering to remove something
               * unnamed. The file tile has said "Uploading…" in plain text since it was written.
               *
               * A name, not an announcement. `role="status"` would make each of these a live
               * region, and a paste of eight images would interrupt eight times to say so.
               */
              <Skeleton
                aria-label={`${image.alt ?? "Attachment"}, uploading`}
                className="size-20 rounded-xl"
                role="img"
              />
            ) : (
              <img
                alt={image.alt ?? "Attachment"}
                className="size-20 rounded-xl border border-border object-cover"
                src={image.url}
              />
            )}
            <RemoveButton
              name={image.alt ?? "attachment"}
              onRemove={() => onRemove(image.id)}
            />
          </Staged>
        ))}
        {files.map((file) => (
          /*
           * The same height as a thumbnail, so a message carrying one of each reads as one row of
           * attachments rather than as two things that happened to land next to each other.
           */
          <Staged
            className="flex h-20 w-40 flex-col justify-between rounded-xl border border-border bg-muted/40 p-2"
            key={file.id}
          >
            <IconFile className="size-5 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate font-medium text-xs" title={file.name}>
                {file.name}
              </p>
              {file.loading ? (
                <p className="text-muted-foreground text-xs">Uploading…</p>
              ) : file.size === undefined ? null : (
                <p className="text-muted-foreground text-xs">
                  {formatBytes(file.size)}
                </p>
              )}
            </div>
            <RemoveButton name={file.name} onRemove={() => onRemove(file.id)} />
          </Staged>
        ))}
      </ul>
    </Collapse>
  );
}

/**
 * One tile, arriving.
 *
 * Entrance only. It leaves the instant it is removed, because that is what the person asked for and
 * because an element held on screen by an animation is an element a test cannot prove is gone — see
 * the note on the collapse above.
 *
 * `layout` is what keeps the removal from reading as a glitch anyway: the tiles to the right of the
 * one that went slide into its place over the same 200ms rather than jumping on a single frame. It
 * is also why `scale` is motion's own prop here, where the rest of this app writes full transform
 * strings for hardware acceleration — a layout animation composes its own transform, and a literal
 * `transform` in `animate` would be overwritten by it mid-flight.
 */
function Staged({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.li
      animate={{ opacity: 1, scale: 1 }}
      className={className ? `relative ${className}` : "relative"}
      initial={{ opacity: 0, scale: shouldReduceMotion ? 1 : 0.85 }}
      layout
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      {children}
    </motion.li>
  );
}

/**
 * The label names the file, because a composer carrying four attachments otherwise offers a screen
 * reader four buttons all called "Remove".
 *
 * Inside the tile rather than hanging off its corner: the strip animates its own height inside an
 * `overflow-hidden` box, and anything outside the tile is clipped while that runs.
 */
function RemoveButton({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}) {
  return (
    <button
      aria-label={`Remove ${name}`}
      className="absolute top-1 right-1 grid size-5 place-items-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
      onClick={onRemove}
      type="button"
    >
      <IconX className="size-3" />
    </button>
  );
}

/**
 * Whole kilobytes below a megabyte and one decimal above it. A staged attachment is capped at 8MB
 * (`shared/attachments.ts`), so this never has to reach gigabytes, and "0.1MB" for a 100KB text
 * file tells the reader less than "98KB" does.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
