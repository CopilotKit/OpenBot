import { useContext, useState } from "react";
import { Streamdown } from "streamdown";
import {
  markdownComponents,
  markdownPlugins,
  replyRemarkPlugins,
} from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { GalleryStreamingContext } from "./streaming";

/**
 * Text a Bot wrote into a card, drawn the way its reply draws it.
 *
 * WHY. A Bot writes a card's text the way it writes a reply, in markdown. Asked for its five most
 * recent unread emails "with a link to each message", a Bot drew a notice whose every point was
 * `[Sender](https://mail.google.com/mail/u/0/#inbox/…) — 5:00 pm. …`, and the card drew that
 * literally: brackets, parentheses and the whole Gmail address on every line, and nothing to click.
 *
 * THE REPLY'S RENDERER, NOT A SECOND ONE. The same Streamdown, components, plugins and line endings
 * as a Bot's reply in the transcript, so a link is the same link (a new tab, no referrer, which
 * OpenBot Desktop hands to the person's own browser), a connected document is the same chip, and raw
 * HTML is dropped by the same sanitising. Nothing here can drift from the transcript.
 *
 * A LONG LINK WRAPS. A card is narrower than a reply and clips what runs past its edge, so a long
 * URL or path in its text breaks across lines rather than losing its end. Code blocks still scroll.
 *
 * FOR PROSE ONLY. A card's title, caption and labels stay plain: they are one line, cut to fit.
 *
 * Streaming is decided once, when the card mounts, as the transcript decides it for a message: a card
 * drawn while its arguments arrive closes a half-written link or bold marker for the duration rather
 * than flashing the markers, and the renderer never changes under the reader once they are in.
 */
export function GalleryMarkdown({
  children,
  className,
}: {
  children: string | undefined;
  className?: string;
}) {
  const streaming = useContext(GalleryStreamingContext);
  const [mode] = useState<"static" | "streaming">(
    streaming ? "streaming" : "static",
  );
  if (!children) return null;
  return (
    <Streamdown
      className={cn("break-words", className)}
      components={markdownComponents}
      mode={mode}
      plugins={markdownPlugins}
      remarkPlugins={replyRemarkPlugins}
    >
      {children}
    </Streamdown>
  );
}
