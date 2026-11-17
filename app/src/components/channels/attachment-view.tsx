import { IconAlertTriangle, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * What an absent file is called, in one place, because two surfaces now say it.
 *
 * The tile said it and the lightbox behind the tile said nothing at all. Sharing the wording rather
 * than writing it twice is what keeps them from drifting into two different accounts of the same
 * absence — the tile naming the file and the dialog saying something vaguer, or worse, later.
 *
 * A file with no name still gets a sentence rather than a blank: the reader clicked on something,
 * and "this attachment" is the honest way to refer to a thing whose name we never had.
 */
export function unavailableSentence(filename?: string): string {
  return filename
    ? `${filename} is unavailable.`
    : "This attachment is unavailable.";
}

/**
 * The full-size picture inside the lightbox, and what it draws when the file will not load.
 *
 * IT NEEDED A FAILURE STATE AND HAD NONE. The tile in front of it has had one from the start — an
 * `onError` swapping the broken-image box for a sentence, with a comment above it about why the
 * browser's own placeholder "says nothing to the reader" — and this `<img>`, the one drawn at full
 * size against a dark backdrop with the reader's whole attention on it, had no `onError` at all. A
 * file deleted between the tile painting and the reader clicking it opened a dialog containing
 * exactly the placeholder the tile path exists to avoid.
 *
 * THE TILE CANNOT COVER THIS ONE. Its own `<img>` has already loaded by the time there is anything
 * to click, and a loaded image does not fire `error` again because the file behind it went away; the
 * request that finds out is this one. Nor can the probe beside it: `useDocumentIsGone` deliberately
 * never asks about a picture, because a picture's own load is supposed to be the answer — and this
 * is the load it meant.
 *
 * IT STAYS OPEN AND SAYS SO, rather than closing itself. The reader opened this deliberately, and a
 * dialog that vanishes on its own leaves them looking at the transcript with no idea what happened
 * and their focus wherever the close put it. The sentence in place answers the question they
 * actually asked. Escape and the close button still work, and the state resets when the popup
 * unmounts, so reopening genuinely tries again rather than remembering a failure.
 *
 * ITS OWN COMPONENT, AND EXPORTED, SO THE FAILURE CAN BE TESTED AT ALL: Base UI portals this popup
 * and under happy-dom the portal never mounts — checked, and recorded in the test named "a thumbnail
 * is a crop" — so there is no way to reach this `<img>` through the trigger. Same reason
 * `sameAttachmentRow` is exported: the behaviour is worth pinning and the thing it lives inside
 * cannot be mounted here.
 */
export function LightboxPicture({
  filename,
  url,
}: {
  filename?: string;
  url: string;
}) {
  const [failedToLoad, setFailedToLoad] = useState(false);

  if (failedToLoad) {
    return (
      /*
       * `note` rather than `alert`, for the reason the tile's own missing card gives at length: an
       * assertive live region cuts across whatever a screen reader is saying, and this is an answer
       * to something the reader just did rather than an emergency. Light-on-dark because it is
       * drawn against the lightbox's own backdrop, where `text-destructive` is unreadable.
       */
      <div
        className="flex flex-col items-center gap-3 p-8 text-center text-white"
        role="note"
      >
        <IconAlertTriangle className="size-8" />
        <p className="text-sm">{unavailableSentence(filename)}</p>
      </div>
    );
  }

  return (
    <img
      alt={filename ?? "Attachment"}
      className="max-h-[88svh] max-w-[92vw] rounded-lg object-contain"
      onError={() => setFailedToLoad(true)}
      src={url}
    />
  );
}

/**
 * The square, opened.
 *
 * The tile is a crop — that is the price of a tidy row — so there has to be a way to see the whole
 * picture, and it used to be `target="_blank"`. A new tab is a worse answer than it looks: it drops
 * the reader out of the conversation they were reading, the browser shows the raw file against its
 * own chrome with no way back but the back button, and on a phone it is a context switch away from
 * the channel entirely. A dialog closes on Escape and puts them back exactly where they were.
 *
 * Built on the app's `Dialog` so focus trapping, scroll locking and Escape behave the way they do
 * everywhere else, but with its card stripped off: `max-w-none border-0 bg-transparent p-0
 * shadow-none` leaves the picture as the only lit thing against a dark backdrop.
 *
 * THE CLOSE BUTTON IS FIXED TO THE VIEWPORT, not to the popup, which is why `showCloseButton` is
 * off and this draws its own. Pinned to the popup it would sit on the picture — invisible over a
 * pale one, and moving with every image's shape.
 */
export function AttachmentLightbox({
  children,
  filename,
  url,
}: {
  children: React.ReactNode;
  filename?: string;
  url: string;
}) {
  const label = filename ?? "Attachment";
  /*
   * Controlled only so that clicking the dark space around the picture closes it, the way every
   * lightbox a reader has used does. The popup covers the viewport (see below), so it — not the
   * backdrop underneath — is what receives that click, and Base UI's own dismiss never fires.
   */
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        // A button, not a link: it opens something on this page, and a middle-click offering a new
        // tab to a raw image file is not the promise this makes. `block` so the tile is not sitting
        // on a text baseline with a stray gap under it.
        className="block cursor-zoom-in overflow-hidden rounded-xl"
        render={<button aria-label={`Open ${label}`} type="button" />}
      >
        {children}
      </DialogTrigger>
      <DialogContent
        /*
         * THE CARD IS STRIPPED OFF AND THE POPUP IS MADE FULL-SCREEN, and the second half is not
         * cosmetic. `DialogContent` centres itself with `-translate-x-1/2 -translate-y-1/2`, and a
         * transform on an ancestor is what `position: fixed` resolves against — so a close button
         * "fixed to the viewport" inside it landed 72px down and 30px in from the corner instead of
         * at it. Measured, not guessed. A popup that already IS the viewport has no transform, and
         * `absolute` in it means the corner it looks like it means.
         *
         * Centring by flex rather than by width also lets the picture keep its own shape: as a
         * stretched flex child it was drawn 1012px wide for a 644px image, letterboxed inside a box
         * far bigger than itself.
         */
        className="inset-0 top-0 left-0 h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 items-center justify-center rounded-none border-0 bg-transparent p-0 shadow-none"
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        overlayClassName="bg-black/80 supports-backdrop-filter:backdrop-blur-sm"
        showCloseButton={false}
      >
        {/* Named for a screen reader; the picture carries the same name in its alt text. */}
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <LightboxPicture filename={filename} url={url} />
        <DialogClose
          render={
            <button
              aria-label="Close"
              className="absolute top-4 right-4 grid size-9 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              type="button"
            />
          }
        >
          <IconX className="size-5" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The probes currently outstanding, so that two tiles asking the same question ask it once.
 *
 * ONE TURN CAN CARRY THE SAME FILE TWICE — `toVisibleChatItems` keys tiles on the PART index
 * precisely so that it can — and a message parked mid-turn draws its files a second time beside the
 * sent row while the queue holds it. Each of those tiles mounts its own effect, and each one used
 * to send its own request for an answer that is the same by construction.
 *
 * WHAT THAT SHARING IS WORTH, CORRECTED. This comment used to say a duplicate probe was "a
 * duplicate megabyte read, not a duplicate status line", because at the time a HEAD reached a
 * handler whose single statement selected `attachments.bytes`. It does not any more: the route
 * grew a branch that answers a HEAD from `name, mimeType, sizeBytes` and never touches the bytes.
 * A duplicate probe is now exactly the duplicate status line this once said it was not.
 *
 * IT STILL EARNS ITS KEEP, FOR A REASON THAT DOES NOT DEPEND ON THE OLD COST. Nothing else in the
 * stack will coalesce these: the route serves `private, no-cache`, so the browser's HTTP cache is
 * required to revalidate every probe rather than answer one from the other, and two tiles for one
 * file are two components with two effects and no knowledge of each other. Without this map the
 * same question goes over the wire once per tile, every time the transcript mounts. It is a dozen
 * lines to ask it once, and cheap-per-answer is not the same as free-per-answer.
 *
 * IN FLIGHT ONLY, AND DELIBERATELY NOT A CACHE OF THE ANSWERS — and THIS is the half the old cost
 * model was never holding up. Holding onto "this file is still there" across remounts is exactly
 * the lie this hook exists to stop: a file deleted while the reader has the app open would go on
 * drawing as an intact card for as long as the tab lived, which is the "worse of the two lies" the
 * comment below names. That was the argument then and it is the whole argument now. Holding onto
 * "this file is GONE" is sound, deletion being terminal, but it buys nothing worth the branch.
 */
const probesInFlight = new Map<string, Promise<boolean>>();

/**
 * Asks the route whether this file is missing, and answers the SAME question only once at a time.
 *
 * Resolves true for 404 and false for every other answer; a fetch that never arrives rejects, and
 * the caller declines to draw a conclusion from it.
 */
function probeDocument(url: string): Promise<boolean> {
  const existing = probesInFlight.get(url);
  if (existing) return existing;

  const probe = fetch(url, { method: "HEAD", credentials: "include" })
    .then((response) => response.status === 404)
    .finally(() => {
      // Cleared however it settled, so the next mount asks again rather than inheriting an answer
      // that has had time to stop being true.
      probesInFlight.delete(url);
    });

  probesInFlight.set(url, probe);
  return probe;
}

/**
 * Whether the row behind a document has been deleted, asked of the server that serves it.
 *
 * A DOCUMENT HAS NO OTHER WAY TO FIND OUT. The picture beside it learns its file is gone by
 * fetching it: the `<img>` requests the url, the route answers 404, and `onError` fires. A document
 * tile is a filename and a label — it requests nothing, so no event about the file can ever reach
 * it — and `failedToLoad` was the only thing feeding the absent branch. A deleted document
 * therefore kept drawing as an intact card naming a file the server was answering 404 for, which
 * is the worse of the two lies: a broken picture at least looks broken.
 *
 * `HEAD` because the question is whether the row exists and the status line is the whole answer, so
 * the reader is not made to download a PDF to learn it is still there. AND IT IS NOW CHEAP ON THE
 * SERVER TOO, WHICH IT ONCE WAS NOT AND WHICH THIS COMMENT WENT ON ASSERTING AFTER IT STOPPED BEING
 * TRUE. The old paragraph was right about the mechanism — Hono does answer a HEAD by dispatching
 * the GET handler in full and dropping the body at the last step — and it concluded that the server
 * therefore still read the whole file out of Postgres, and that a route which could answer "is it
 * there" without the bytes "is not this file's to write". Somebody wrote it. The attachment route
 * now branches on the method INSIDE the handler Hono actually dispatches, selects `sizeBytes`
 * instead of `bytes`, and sets `Content-Length` by hand; the access join, the statuses and the
 * revalidation are the GET's exactly, so a probe still learns nothing a fetch would not tell you.
 *
 * That is recorded here rather than quietly deleted because this file spent two review rounds being
 * read as evidence that the cheap probe did not exist. A comment describing a path as broken, about
 * a path that works, costs more than no comment at all.
 *
 * A REQUEST THAT NEVER ARRIVED IS NOT A DELETED FILE, so a rejected fetch — offline, a dropped
 * connection, a proxy in the way — leaves the card alone rather than accusing the server of having
 * lost somebody's file.
 *
 * AND NEITHER IS A REQUEST THE SERVER REFUSED, which is the same rule and was the bug. This asked
 * `!response.ok`, which is every status outside 200-299, when exactly one of them means what the
 * tile then says. The route collapses "no such row", "channel deleted" and "not a channel of
 * yours" into 404 precisely so that probing ids learns nothing — that is the one status that means
 * "there is no file here for you". Everything else is a fact about the request:
 *
 *   - 401 is a session that expired while the channel sat open, and it turned EVERY document tile
 *     in the transcript into a red card asserting, in each file's own name, that somebody's files
 *     had been deleted. Nothing had been; they need to sign in again.
 *   - 500 is a bad moment on the server, and it stuck: the deps below are stable, so nothing asks
 *     again and the accusation stands until the component remounts.
 *   - 304 is the strongest proof of PRESENCE this route can give — the row was found AND the
 *     membership join passed — and `Response.ok` is false for it.
 *
 * That is the same lie this hook exists to stop, pointing the other way, and it is the louder one:
 * drawn in the destructive vocabulary, naming the file. So absence is claimed on 404 alone, which
 * also puts a document back in step with the picture beside it — an `<img>` handed a 401 shows a
 * broken image, not a sentence swearing the file was deleted.
 */
/** What the server says about a file it serves: whether it is gone, and its size and type. */
export type FileFacts = {
  missing: boolean;
  sizeBytes?: number;
  mimeType?: string;
};

const factsInFlight = new Map<string, Promise<FileFacts>>();

/**
 * The same bodyless question as {@link probeDocument}, keeping the size and the type the answer
 * carries. Only 404 is "missing", for the reasons given there.
 */
function probeFile(url: string): Promise<FileFacts> {
  const existing = factsInFlight.get(url);
  if (existing) return existing;

  /*
   * `no-store`, so the browser does not answer from the picture it just failed to draw: a
   * revalidation of that comes back 304 with no length and no type, and the tile lost its size.
   */
  const probe = fetch(url, {
    method: "HEAD",
    credentials: "include",
    cache: "no-store",
  })
    .then((response): FileFacts => {
      if (response.status === 404) return { missing: true };
      if (!response.ok) return { missing: false };
      const length = Number(response.headers.get("Content-Length"));
      const type = response.headers.get("Content-Type")?.split(";")[0]?.trim();
      return {
        missing: false,
        ...(Number.isFinite(length) && length > 0 ? { sizeBytes: length } : {}),
        ...(type ? { mimeType: type } : {}),
      };
    })
    .finally(() => {
      factsInFlight.delete(url);
    });

  factsInFlight.set(url, probe);
  return probe;
}

/**
 * What the server says about a file, asked only when `ask` turns true.
 *
 * For a PICTURE THAT WOULD NOT DRAW. Its own load failing says the browser could not draw it, not
 * that the file is gone: a picture up to 100MB can be intact on the server and still not draw in a
 * phone's browser. So the tile asks, and only a 404 makes it "unavailable"; anything else draws it
 * as the file it is, with the size and type when the answer carried them. A request that never
 * arrived is not an answer either way, and the tile is drawn as the file without them.
 */
export function useFileFacts(url: string, ask: boolean): FileFacts | undefined {
  const [facts, setFacts] = useState<FileFacts>();

  useEffect(() => {
    if (!ask) return;
    setFacts(undefined);
    let cancelled = false;
    void probeFile(url)
      .then((answer) => {
        if (!cancelled) setFacts(answer);
      })
      .catch(() => {
        if (!cancelled) setFacts({ missing: false });
      });
    return () => {
      cancelled = true;
    };
  }, [ask, url]);

  return ask ? facts : undefined;
}

export function useDocumentIsGone(url: string, ask: boolean): boolean {
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!ask) {
      return;
    }
    // A tile reused at the same position for a different file starts the question over rather than
    // inheriting the previous file's answer.
    setGone(false);

    let cancelled = false;
    void probeDocument(url)
      .then((missing) => {
        if (!cancelled && missing) {
          setGone(true);
        }
      })
      .catch(() => {
        // Deliberately nothing: see above. Not knowing is not the same as knowing it is gone.
      });

    return () => {
      cancelled = true;
    };
  }, [ask, url]);

  return gone;
}
