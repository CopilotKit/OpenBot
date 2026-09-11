import type { Message, UserMessage } from "@ag-ui/core";
import type { Attachment } from "@copilotkit/react-core/v2";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  ChatTranscript,
  LightboxPicture,
  sameAttachmentRow,
  TranscriptAttachments,
} from "@/components/channels/chat-transcript";
import type { QueuedMessage } from "@/components/channels/composer";
import { attachmentUrl } from "@/lib/channels/attachments";

/**
 * `toVisibleChatItems` (chat-messages.ts) gathers the attachment parts of a user turn into one
 * `{ kind: "attachments" }` item; this pins what the transcript draws for it, which until this
 * feature was an explicit `null` — a screenshot pasted with no caption rendered as nothing at all.
 *
 * It also pins the two ways an attachment-only turn has to behave like a typed one — the Thinking
 * indicator and the scroll anchor — and, in the same breath, that a CAPTIONED turn still anchors
 * exactly once. The scroller jumps to the end when it finds two anchors among the rows appended
 * together, so the naive "every attachment is an anchor" rule fixes the first case by breaking the
 * ordinary one, and only a test that counts anchors notices.
 *
 * URLS ARE RELATIVE HERE BECAUSE THAT IS THE ONLY KIND A SENT MESSAGE CARRIES. `shared/attachments.ts`
 * says so, and the transcript now refuses anything else rather than fetching it.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `agent-roster-error.test.tsx`: bun walks every file into one process, and a
 * document another file tore down mid-run fails invisibly.
 *
 * WITH ONE ADDITION: an origin. happy-dom defaults to `about:blank`, against which a relative `src`
 * does not resolve at all, and the image element fires `error` before anything has been asserted —
 * so every attachment would test as unavailable and the tests below would agree with a transcript
 * that draws nothing.
 */

/**
 * AND A STUBBED `fetch`, because a document tile now ASKS whether its row is still there.
 *
 * A document draws no `<img>`, so nothing about it can fail to load and nothing tells it the row
 * behind it was deleted; the tile probes the attachment route instead. Every test here that draws
 * a document therefore makes a request, and left unstubbed each one would be a real socket to a
 * server that is not running — slow, and answering "gone" for the wrong reason. The default answer
 * is the ordinary one: the file is still there.
 */
/*
 * ANSWERED ON A MICROTASK, NOT SYNCHRONOUSLY, so that a `probeAnswer` which THROWS becomes a
 * rejected promise rather than an exception thrown out of `fetch` itself. No real `fetch` throws at
 * the call site — an offline browser rejects — and the probe's `.catch` is written for the real
 * shape, so answering synchronously here would have the one test about an unreachable server take
 * a path production never takes, straight through the effect and into React.
 *
 * The request is still RECORDED synchronously, which is what lets the tests below use one document's
 * probe as a clock for another's absence.
 */
let probeAnswer: () => Response | Promise<Response> = () =>
  new Response(null, { status: 200 });
let probes: { url: string; method?: string }[] = [];
let realFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    probes.push({
      url: String(input),
      ...(init?.method ? { method: init.method } : {}),
    });
    return Promise.resolve().then(() => probeAnswer());
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  probeAnswer = () => new Response(null, { status: 200 });
  probes = [];
});

afterAll(async () => {
  /*
   * ONE TURN OF THE LOOP BEFORE THE DOCUMENT GOES AWAY. A probe answered during the last test
   * leaves React work scheduled on a macrotask, and the scheduler reaches for `window` when it
   * runs — after `unregister`, that is a `ReferenceError` reported against whichever file bun
   * happens to be running by then, which is a failure with somebody else's name on it.
   */
  await new Promise((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

let idCounter = 0;

/** A user turn, with whatever content a test needs — a caption, an attachment, or both. */
function userMessage(content: UserMessage["content"]): Message {
  idCounter += 1;
  return { id: `user-${idCounter}`, role: "user", content };
}

function textPart(text: string) {
  return { type: "text" as const, text };
}

function imagePart(url: string, filename: string) {
  return {
    type: "image" as const,
    source: { type: "url" as const, value: url },
    metadata: { attachmentId: "att-image", filename },
  };
}

function documentPart(url: string, filename: string) {
  return {
    type: "document" as const,
    source: { type: "url" as const, value: url },
    metadata: { attachmentId: "att-document", filename },
  };
}

function renderTranscript(
  messages: readonly Message[],
  props: {
    busy?: boolean;
    onRemoveQueued?: (id: string) => void;
    queued?: readonly QueuedMessage[];
  } = {},
) {
  return render(<ChatTranscript messages={messages} {...props} />);
}

/** A file staged on the composer, as the SDK hands it over: settled, and pointing at its own row. */
function staged(id: string, filename: string): Attachment {
  return {
    id,
    type: "image",
    source: { type: "url", value: attachmentUrl(id) },
    filename,
    status: "ready",
  };
}

/** A message typed while the Bot had the turn, with whatever was staged on the draft beside it. */
function parked(text: string, attachments: Attachment[]): QueuedMessage {
  return { id: "queued-1", text, commandIds: [], attachments };
}

/**
 * Which rows the scroller would treat as the place to scroll to, in the order it walks them.
 *
 * Read off the DOM rather than off a return value because that attribute IS the contract: the
 * primitive looks for `data-scroll-anchor="true"` among the newly appended children and nothing
 * else, so asserting on anything closer to the component would pass while the scroller misbehaved.
 */
function anchoredRows(container: HTMLElement): (string | null)[] {
  return Array.from(
    container.querySelectorAll('[data-scroll-anchor="true"]'),
  ).map((row) => row.getAttribute("data-message-id"));
}

test("an image attachment renders as an img carrying the attachment url", () => {
  const url = attachmentUrl("att-image");
  const { getByRole } = renderTranscript([
    userMessage([imagePart(url, "shot.png")]),
  ]);

  const img = getByRole("img", { name: /attachment/i });
  expect(img.getAttribute("src")).toBe(url);
});

test("a broken image is replaced by a stated absence, not a broken-image glyph", () => {
  const { getByRole, getByText, queryByRole } = renderTranscript([
    userMessage([imagePart(attachmentUrl("att-image"), "gone.png")]),
  ]);

  const img = getByRole("img", { name: /attachment/i });
  fireEvent.error(img);

  // The <img> element is gone entirely — this reader is never left staring at the browser's own
  // broken-image box, which says nothing about what actually happened.
  expect(queryByRole("img")).toBeNull();
  expect(getByText(/unavailable/i)).toBeTruthy();
});

test("an off-site attachment url is never fetched, it is reported missing", () => {
  // An absolute url cannot have come from this app's composer, and drawing it would have the
  // reader's browser announce to a third party that they opened this channel.
  const { getByText, queryByRole } = renderTranscript([
    userMessage([imagePart("https://example.com/shot.png", "shot.png")]),
  ]);

  expect(queryByRole("img")).toBeNull();
  expect(getByText("shot.png is unavailable.")).toBeTruthy();
});

test("a message that is only an attachment still appears", () => {
  // The regression this whole feature rests on: before this change, `chat-transcript.tsx` had an
  // explicit `null` for the attachment branch, so a document pasted with no caption vanished from
  // the transcript entirely.
  const { getByText } = renderTranscript([
    userMessage([documentPart(attachmentUrl("att-document"), "report.pdf")]),
  ]);

  expect(getByText("report.pdf")).toBeTruthy();
});

test("a turn that is only an attachment is still waited on", () => {
  // Somebody who pastes a screenshot and sends it is watching the same spot under it as somebody
  // who typed a question, and without this they watched it stay empty.
  const { getByRole } = renderTranscript(
    [userMessage([imagePart(attachmentUrl("att-image"), "shot.png")])],
    { busy: true },
  );

  expect(getByRole("status").textContent).toBe("Thinking");
});

test("a turn that is only an attachment anchors the scroller on itself", () => {
  const message = userMessage([
    imagePart(attachmentUrl("att-image"), "shot.png"),
  ]);
  const { container } = renderTranscript([message]);

  expect(anchoredRows(container)).toEqual([`${message.id}:attachments`]);
});

test("two files sent together anchor their turn exactly once", () => {
  const message = userMessage([
    imagePart(attachmentUrl("att-image"), "one.png"),
    imagePart(attachmentUrl("att-image"), "two.png"),
  ]);
  const { container } = renderTranscript([message]);

  // Two files are ONE row now, so there is only one thing that could be an anchor. Kept anyway:
  // the assertion that survives the grouping is the one worth having if the grouping is ever undone.
  expect(anchoredRows(container)).toEqual([`${message.id}:attachments`]);
});

test("a caption and its attachment anchor their turn exactly once", () => {
  const message = userMessage([
    textPart("does this look right?"),
    imagePart(attachmentUrl("att-image"), "shot.png"),
  ]);
  const { container } = renderTranscript([message]);

  // ONE, and it is the PICTURES, which is the row the caption now sits under. A second anchor among
  // rows appended together makes the scroller give up and jump to the end, which would quietly cost
  // every captioned turn the anchoring it has today — the exact price of marking the caption an
  // anchor too.
  expect(anchoredRows(container)).toEqual([`${message.id}:attachments`]);
});

test("a plain string message renders exactly as before", () => {
  const { getByText } = renderTranscript([
    userMessage("when does the offer expire?"),
  ]);

  expect(getByText("when does the offer expire?")).toBeTruthy();
});

test("two files sent together are drawn as one row, not two", () => {
  const { container } = renderTranscript([
    userMessage([
      imagePart(attachmentUrl("att-image"), "one.png"),
      imagePart(attachmentUrl("att-image"), "two.png"),
    ]),
  ]);

  // The thing the grouping buys, stated as the DOM: two tiles inside a single list, rather than
  // two rows each as wide as the transcript with a picture alone on each.
  const lists = container.querySelectorAll("ul");
  expect(lists).toHaveLength(1);
  expect(lists[0].querySelectorAll("li")).toHaveLength(2);
});

test("a thumbnail is a crop, and what opens it is a button rather than a link", () => {
  /*
   * WHAT THIS CANNOT ASSERT, SAID PLAINLY RATHER THAN LEFT AS A GAP. The picture opens in a dialog
   * now, and none of that is observable here: Base UI portals its popup and under happy-dom the
   * portal never mounts, while `aria-expanded` on the trigger stays `false` even though
   * `onOpenChange(true)` demonstrably fires — the primitive's own state does not settle without a
   * frame this environment never delivers. Both were checked before this comment was written.
   *
   * So the dialog was verified in Chrome instead — centred at its own aspect ratio, close button at
   * the viewport's top right, and closing on the button, on Escape and on a click outside — and
   * what is pinned here is the contract around it that a unit test CAN see: the tile is a crop, so
   * something has to open the whole picture, and the thing that does is a button on this page
   * rather than a link out of it.
   */
  const url = attachmentUrl("att-image");
  const { getByRole, getByLabelText, queryByRole } = renderTranscript([
    userMessage([imagePart(url, "shot.png")]),
  ]);

  expect(queryByRole("dialog")).toBeNull();
  // `object-cover` is what makes it a square crop, and therefore what makes the dialog necessary.
  expect(getByRole("img", { name: /attachment/i }).className).toContain(
    "object-cover",
  );

  const trigger = getByLabelText("Open shot.png");
  expect(trigger.tagName).toBe("BUTTON");
  // Not an anchor: it opens something here, and a middle-click must not offer a tab of raw bytes.
  expect(trigger.getAttribute("href")).toBeNull();
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
});

/*
 * THE OTHER HALF OF THE TILE'S `onError`, ON THE PICTURE THE TILE OPENS.
 *
 * The tile swaps a broken-image box for a sentence, and the full-size picture behind it did not —
 * it had no `onError` at all — so a file deleted between the tile painting and the reader clicking
 * it opened a dialog containing exactly the browser placeholder the tile path exists to avoid.
 *
 * The tile cannot answer for this: its own `<img>` has already loaded, and a loaded image does not
 * fire `error` again because the bytes behind it went away. Nor can the document probe, which
 * deliberately never asks about a picture.
 *
 * RENDERED DIRECTLY, NOT THROUGH THE TRIGGER, and the test named "a thumbnail is a crop" above
 * records why: Base UI portals the popup and under happy-dom that portal never mounts, so there is
 * no way to reach this element by clicking. The component is exported for exactly this, the same
 * reason `sameAttachmentRow` is.
 */
test("the opened picture states its absence rather than showing a broken frame", () => {
  const { getByRole, getByText, queryByRole } = render(
    <LightboxPicture filename="gone.png" url={attachmentUrl("att-image")} />,
  );

  fireEvent.error(getByRole("img"));

  // The <img> is gone entirely, exactly as it is in the tile: no browser placeholder is left for
  // the reader to interpret.
  expect(queryByRole("img")).toBeNull();
  expect(getByText("gone.png is unavailable.")).toBeTruthy();
  // A note, never an alert — this answers something the reader just did, it does not interrupt.
  expect(getByRole("note")).toBeTruthy();
});

/* A picture whose name never arrived still gets a sentence rather than a blank dialog. */
test("an unnamed picture that will not open still says what happened", () => {
  const { getByRole, getByText } = render(
    <LightboxPicture url={attachmentUrl("att-image")} />,
  );

  fireEvent.error(getByRole("img"));

  expect(getByText("This attachment is unavailable.")).toBeTruthy();
});

/*
 * And the ordinary case, which a fix to the above can break silently: a picture that loads is drawn,
 * at its own aspect ratio rather than cropped. `object-contain` is what makes the dialog worth
 * opening at all, given the tile is `object-cover`.
 */
test("the opened picture is drawn whole, not cropped like its tile", () => {
  const url = attachmentUrl("att-image");
  const { getByRole } = render(
    <LightboxPicture filename="shot.png" url={url} />,
  );

  const img = getByRole("img");
  expect(img.getAttribute("src")).toBe(url);
  expect(img.getAttribute("alt")).toBe("shot.png");
  expect(img.className).toContain("object-contain");
});

test("an off-site document url is reported missing rather than drawn as a file card", () => {
  /*
   * THE SAME RULE AS THE PICTURE ABOVE, and it has to be, because the lie a document tells is the
   * worse one: a picture that cannot be drawn at least looks wrong, while a card naming a file the
   * app cannot serve reads as an intact attachment sitting right there. The reader is told the
   * thing is present when it is not.
   */
  const { getByText, queryByText } = renderTranscript([
    userMessage([documentPart("https://example.com/report.pdf", "report.pdf")]),
  ]);

  expect(getByText("report.pdf is unavailable.")).toBeTruthy();
  // Not the file card: no "Attachment" caption, and the name is not offered as an intact one.
  expect(queryByText("Attachment")).toBeNull();
});

/*
 * A DELETED ROW IS THE CASE THE OFF-SITE RULE ABOVE DOES NOT COVER, and it was the one that shipped
 * broken. `unavailable` was `failedToLoad || !url.startsWith(...)`, and `failedToLoad` is set only
 * by an image's `onError` — an event a document, which renders no `<img>`, can never receive. So a
 * document whose row had been deleted kept a url of exactly the right shape and drew as an intact
 * file card: the reader was told the file was sitting right there while the server was answering
 * 404 for it. Verified in a browser before it was written down here.
 */
test("a document whose row is gone is reported missing rather than named", async () => {
  probeAnswer = () => new Response(null, { status: 404 });

  const { findByText, queryByText } = renderTranscript([
    userMessage([documentPart(attachmentUrl("att-document"), "report.pdf")]),
  ]);

  expect(await findByText("report.pdf is unavailable.")).toBeTruthy();
  // Not the file card: the name is no longer offered as an intact one, caption and all.
  expect(queryByText("Attachment")).toBeNull();
});

/*
 * The other half of that, and the half a fix can break without anybody noticing: a document whose
 * row is still there keeps its card. "Everything is unavailable" passes the test above.
 */
test("a document whose row is still there keeps its card", async () => {
  const { getByText, queryByText } = renderTranscript([
    userMessage([documentPart(attachmentUrl("att-document"), "report.pdf")]),
  ]);

  await waitFor(() => expect(probes).toHaveLength(1));

  expect(getByText("report.pdf")).toBeTruthy();
  expect(getByText("Attachment")).toBeTruthy();
  expect(queryByText("report.pdf is unavailable.")).toBeNull();
});

/*
 * WHAT THE PROBE IS ALLOWED TO BE: a bodyless request for the file's own url. `HEAD` because the
 * question is whether the row exists and the answer is the status line — pulling a whole PDF back
 * through the browser to learn it is still there would cost the reader the file's bytes on every
 * transcript that mentions it.
 */
test("the probe asks for the head of the attachment url, not its bytes", async () => {
  const url = attachmentUrl("att-document");
  renderTranscript([userMessage([documentPart(url, "report.pdf")])]);

  await waitFor(() => expect(probes).toHaveLength(1));
  expect(probes[0].url).toBe(url);
  expect(probes[0].method).toBe("HEAD");
});

/*
 * AND WHAT IT MUST NEVER BE: a request to somebody else's server. The off-site rule exists so that
 * drawing a transcript cannot announce to a third party that this person opened this channel, and
 * a probe is a request like any other — an existence check sent there would leak exactly the fact
 * the rule was written to keep. An off-site document is already known to be unavailable without
 * asking anybody.
 */
/*
 * NOT ASSERTED BY WAITING ON AN EMPTY LIST, which is what this did and which proves nothing: the
 * callback `waitFor` retries does not throw on the very first check, so `await waitFor(() =>
 * expect(probes).toEqual([]))` is over before a macrotask has run and the `await` reads as patience
 * it never bought. It said "not probed synchronously" while its name said "never" — a probe moved
 * behind a microtask, an `IntersectionObserver` or an idle callback would have slid straight past.
 *
 * A SERVABLE DOCUMENT IS DRAWN BESIDE IT AS THE CLOCK. Waiting for THAT one's probe to arrive puts
 * the question after the point by which the off-site one — mounted in the same commit — would have
 * had to appear, so an empty result now means the request was not made rather than not made yet.
 */
test("an off-site document is never probed", async () => {
  const kept = attachmentUrl("att-document");
  const { getByText } = renderTranscript([
    userMessage([
      documentPart("https://example.com/report.pdf", "report.pdf"),
      documentPart(kept, "kept.pdf"),
    ]),
  ]);

  expect(getByText("report.pdf is unavailable.")).toBeTruthy();

  await waitFor(() => expect(probes).toHaveLength(1));
  // One probe, and it is the servable file's. Nothing was sent to example.com.
  expect(probes.map((probe) => probe.url)).toEqual([kept]);
});

/*
 * An image is not probed either: it fetches its own url to draw itself, and `onError` is that same
 * request's answer. A probe beside it would ask the server for the same file twice per picture.
 *
 * Same clock as the test above, and for the same reason.
 */
test("an image is not probed, its own load already answers", async () => {
  const kept = attachmentUrl("att-document");
  renderTranscript([
    userMessage([
      imagePart(attachmentUrl("att-image"), "shot.png"),
      documentPart(kept, "kept.pdf"),
    ]),
  ]);

  await waitFor(() => expect(probes).toHaveLength(1));
  expect(probes.map((probe) => probe.url)).toEqual([kept]);
});

/*
 * ONLY 404 MEANS THE FILE IS GONE, AND THE PROBE USED TO READ EVERY OTHER FAILURE AS ONE.
 *
 * `!response.ok` is every status outside 200-299, and exactly one of them says what the tile then
 * says. The route this asks (`server/src/channels/attachments.ts`) deliberately collapses "no such
 * row", "channel deleted" and "not yours" into 404 so that probing ids learns nothing — that is the
 * status, and the only status, that means "there is no file here for you".
 *
 * Everything else is a different fact about the REQUEST, not about the file:
 *
 *  - 401 is the session having expired while the channel sat open. Every document tile in the
 *    transcript flipped at once to a red card asserting, in the file's own name, that somebody's
 *    files had been deleted — when all that happened is that they need to sign in again.
 *  - 500 or 503 is the database or the server having a bad moment. It is also PERMANENT for that
 *    mount: the effect's deps are the url and whether to ask, both stable, so nothing ever asks
 *    again and the tile goes on claiming deletion until the component remounts.
 *  - 304 is the strongest possible proof of PRESENCE the route can give — the row was found and the
 *    membership join passed — and `Response.ok` is false for it.
 *
 * This is the same lie the probe was added to stop, pointing the other way, and it is the louder
 * one: it is drawn in the destructive vocabulary and it names the file. A card that stays intact
 * when the answer is unclear is the honest failure, and it matches what the picture beside it does
 * — an `<img>` given a 401 or a 500 shows a broken image, not a sentence asserting deletion.
 */
test("only a 404 makes a document missing, not any other failed answer", async () => {
  for (const status of [304, 401, 403, 500, 503]) {
    probes = [];
    probeAnswer = () => new Response(null, { status });

    const { getByText, queryByText, unmount } = renderTranscript([
      userMessage([documentPart(attachmentUrl("att-document"), "report.pdf")]),
    ]);

    await waitFor(() => expect(probes).toHaveLength(1));

    // The card is intact: the name, the caption, and no accusation.
    expect(getByText("report.pdf")).toBeTruthy();
    expect(getByText("Attachment")).toBeTruthy();
    expect(queryByText("report.pdf is unavailable.")).toBeNull();

    unmount();
  }
});

/*
 * TWO TILES SHOWING THE SAME FILE ASK ABOUT IT ONCE.
 *
 * One turn carrying the same file twice is a shape this projection explicitly supports — the tile
 * key is the PART index so that it can — and it is not the only way two tiles land on one url: a
 * message parked mid-turn draws its files again beside the sent row.
 *
 * THE SAVING IS THE ROUND TRIP, AND IT USED TO BE THE FILE. This note said the second probe was "a
 * second whole-file read out of Postgres", because a HEAD was then answered by Hono running the GET
 * handler in full, bytes and all, before dropping the body. The route has since grown a HEAD branch
 * that selects `sizeBytes` and never `bytes`, so what is deduped now is a cheap metadata query.
 *
 * The case still holds, on a footing that does not depend on the old cost: the route serves
 * `private, no-cache`, so the browser is required to revalidate rather than answer one tile's probe
 * out of the other's, and two tiles are two components with two effects that know nothing of each
 * other. Nothing but `probesInFlight` coalesces them, and this is what pins that it does.
 */
test("the same file drawn twice is asked about once", async () => {
  const url = attachmentUrl("att-document");
  const { getAllByText } = renderTranscript([
    userMessage([
      documentPart(url, "report.pdf"),
      documentPart(url, "report.pdf"),
    ]),
  ]);

  // Both tiles are really there — the saving is in the asking, not in the drawing.
  expect(getAllByText("report.pdf")).toHaveLength(2);

  await waitFor(() => expect(probes).toHaveLength(1));
  // And no straggler arrives behind it once the shared answer has settled.
  await act(async () => {});
  expect(probes).toHaveLength(1);
});

/*
 * But a SETTLED answer is not kept: the next mount asks again. Caching "still there" across mounts
 * is the one change that would cut the cost of the common case, and it is also the lie this whole
 * probe exists to stop — a file deleted while the tab is open would go on drawing as an intact card
 * until the page was reloaded. The cheap answer is not worth the honest one.
 */
test("a later mount asks again rather than reusing a settled answer", async () => {
  const url = attachmentUrl("att-document");

  const first = renderTranscript([
    userMessage([documentPart(url, "report.pdf")]),
  ]);
  await waitFor(() => expect(probes).toHaveLength(1));
  first.unmount();

  renderTranscript([userMessage([documentPart(url, "report.pdf")])]);
  await waitFor(() => expect(probes).toHaveLength(2));
});

/*
 * And a probe that never arrived at all is still not a deleted file — the rule the comment on
 * `useDocumentIsGone` already stated for a REJECTED fetch, pinned here beside the statuses so a
 * change to one cannot quietly take the other with it.
 */
test("a probe that never arrives leaves the card alone", async () => {
  probeAnswer = () => {
    throw new Error("offline");
  };

  const { getByText, queryByText } = renderTranscript([
    userMessage([documentPart(attachmentUrl("att-document"), "report.pdf")]),
  ]);

  await waitFor(() => expect(probes).toHaveLength(1));
  await act(async () => {});

  expect(getByText("report.pdf")).toBeTruthy();
  expect(queryByText("report.pdf is unavailable.")).toBeNull();
});

/*
 * WHAT A MISSING FILE IS ALLOWED TO INTERRUPT, WHICH IS NOTHING. `role="alert"` is an ASSERTIVE
 * live region: it cuts across whatever a screen reader is currently saying, which is right for
 * something that just happened in answer to what somebody did — `Stopped` is exactly that — and
 * wrong for history. Opening a channel whose old turns carry three deleted files fired three
 * interruptions before the reader had heard the first sentence of the conversation, and none of
 * them was news: those files went missing long before this page was opened.
 *
 * The absence still has to READ as an absence, so the sentence stays exactly as it was and the
 * tile stays a thing a screen reader stops on. It simply waits its turn.
 */
test("missing attachments are stated, not announced over what is being read", () => {
  const { container, getByText } = renderTranscript([
    userMessage([
      imagePart("https://example.com/one.png", "one.png"),
      imagePart("https://example.com/two.png", "two.png"),
      imagePart("https://example.com/three.png", "three.png"),
    ]),
  ]);

  /*
   * Read off the DOM, like `anchoredRows` above and for the same reason: the attribute IS the
   * contract a screen reader reads, and `getAllByRole` walks the whole transcript computing roles
   * for every node in it — which under this harness takes minutes rather than milliseconds.
   */
  const role = (name: string) =>
    container.querySelectorAll(`[role="${name}"]`).length;

  // Three files, three tiles, and not one interruption between them.
  expect(role("alert")).toBe(0);
  expect(role("note")).toBe(3);
  expect(getByText("one.png is unavailable.")).toBeTruthy();
  expect(getByText("three.png is unavailable.")).toBeTruthy();
});
/*
 * The two wordings, both pinned, because they are the ones a reader is left with when everything
 * else about the file is gone. A filename-less attachment is the ordinary case for anything pasted
 * rather than picked — the composer has no name to send — so this branch is not an edge.
 */
test("an unnamed missing attachment still says what it is", () => {
  const { getByText } = renderTranscript([
    userMessage([
      {
        type: "image" as const,
        source: { type: "url" as const, value: "https://example.com/x.png" },
        metadata: { attachmentId: "att-image" },
      },
    ]),
  ]);

  expect(getByText("This attachment is unavailable.")).toBeTruthy();
});

test("an unnamed document that is present is still drawn as a file", async () => {
  const { getByText } = renderTranscript([
    userMessage([
      {
        type: "document" as const,
        source: { type: "url" as const, value: attachmentUrl("att-document") },
        metadata: { attachmentId: "att-document" },
      },
    ]),
  ]);

  await waitFor(() => expect(probes).toHaveLength(1));
  expect(getByText("Untitled file")).toBeTruthy();
  expect(getByText("Attachment")).toBeTruthy();
});

/*
 * A PARKED FILE WAS ON NO SURFACE IN THE APP AT ALL, which is the part that makes this worse than a
 * missing row. Parking a message consumes the draft, so the composer's own strip is cleared in the
 * same beat — and the queued line drew `message.text` and nothing else. Somebody who attached a
 * screenshot and typed a correction while the Bot was working watched the file disappear from the
 * composer and never appear anywhere else, with nothing on screen to say it was still coming.
 */
test("a file parked with a message is still on screen", () => {
  const { container, getByText } = renderTranscript([], {
    queued: [parked("this one instead", [staged("att-image", "shot.png")])],
  });

  const image = container.querySelector("img");
  expect(image?.getAttribute("src")).toBe(attachmentUrl("att-image"));
  // Still parked, and still takeable back: the row is drawn with the message, not instead of it.
  expect(getByText("this one instead")).toBeTruthy();
  expect(getByText("Queued")).toBeTruthy();
});

/*
 * AND AN ATTACHMENT-ONLY PARKED MESSAGE IS NOT AN EMPTY BUBBLE. A screenshot pasted mid-turn with
 * no words is the ordinary way this feature gets used, and it drew a muted bubble containing
 * nothing — which reads as a message somebody sent by mistake rather than as a file waiting its
 * turn.
 */
test("a parked message that is only a file draws the file, not an empty bubble", () => {
  const { container } = renderTranscript([], {
    queued: [parked("", [staged("att-image", "shot.png")])],
  });

  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    attachmentUrl("att-image"),
  );
  expect(container.querySelector('[data-slot="bubble"]')).toBeNull();
});

/*
 * The button that takes it back is named after what it deletes — and with no words to name it by,
 * the files are what it is. "Remove queued message: " was the label before, which tells somebody
 * reading by name alone that there is something to remove and nothing whatever about what.
 */
test("taking back a parked file names the file", () => {
  const { getByLabelText } = renderTranscript([], {
    onRemoveQueued: () => {},
    queued: [parked("", [staged("att-image", "shot.png")])],
  });

  expect(getByLabelText("Remove queued message: shot.png")).toBeTruthy();
});

/*
 * THE MEMO ON THE ROW OF TILES MISSED EVERY SINGLE TIME, and the default comparison is why:
 * `toVisibleChatItems` is deliberately not memoised — the agent hands back the same array and
 * mutates it, so a `useMemo` keyed on it never invalidates and a reply never appears — which means
 * the `attachments` array is a NEW array on every render of the transcript, and `Object.is` on two
 * different arrays is false however identical their contents. So every chunk of a streaming answer
 * re-rendered every tile in the history, each one carrying an image `Dialog` with it. That is
 * exactly the churn the memoised message rows above it exist to stop, and this row opted out of it
 * by accident.
 *
 * Compared field by field rather than by identity, because the fields are what the tiles draw.
 */
const ONE_FILE = [
  {
    id: "user-1:0",
    attachmentId: "att-image",
    url: attachmentUrl("att-image"),
    filename: "shot.png",
    modality: "image" as const,
  },
];

test("a rebuilt but unchanged row of files compares equal", () => {
  // Same values, different objects, different array: what every render after the first hands over.
  const rebuilt = ONE_FILE.map((file) => ({ ...file }));

  expect(
    sameAttachmentRow(
      { attachments: ONE_FILE, delay: 0 },
      { attachments: rebuilt, delay: 0 },
    ),
  ).toBe(true);
});

test("a row that actually changed does not compare equal", () => {
  const changed = [
    { ...ONE_FILE[0], id: "user-1:1" },
    { ...ONE_FILE[0], attachmentId: "att-other" },
    { ...ONE_FILE[0], url: attachmentUrl("att-other") },
    { ...ONE_FILE[0], filename: "other.png" },
    { ...ONE_FILE[0], filename: undefined },
    { ...ONE_FILE[0], modality: "document" as const },
  ];

  for (const file of changed) {
    expect(
      sameAttachmentRow(
        { attachments: ONE_FILE, delay: 0 },
        { attachments: [file], delay: 0 },
      ),
    ).toBe(false);
  }

  // A file added, a file taken away, and the entrance delay itself — all of them redraw.
  expect(
    sameAttachmentRow(
      { attachments: ONE_FILE, delay: 0 },
      { attachments: [], delay: 0 },
    ),
  ).toBe(false);
  expect(
    sameAttachmentRow(
      { attachments: ONE_FILE, delay: 0 },
      { attachments: [...ONE_FILE, ONE_FILE[0]], delay: 0 },
    ),
  ).toBe(false);
  expect(
    sameAttachmentRow(
      { attachments: ONE_FILE, delay: 0 },
      { attachments: ONE_FILE, delay: 0.04 },
    ),
  ).toBe(false);
});

/*
 * And that it is the comparison the row is actually memoised WITH — a correct function nobody
 * passed to `memo` buys nothing, and that is precisely the state this row was in. `compare` is the
 * field `React.memo` keeps its comparator in.
 */
test("the row of tiles is memoised with that comparison", () => {
  expect(
    (TranscriptAttachments as unknown as { compare?: unknown }).compare,
  ).toBe(sameAttachmentRow);
});

/*
 * A PARKED FILE IS THE ONE SURFACE IN THIS BROWSER THAT KNOWS WHAT IT IS HOLDING.
 *
 * `attachment.type` is the SDK's `getModalityFromMimeType(file.type)`, decided from the browser's
 * claim before a byte was uploaded and never revisited when the upload replies — the merge back is
 * `{ ...att, source, status: "ready", thumbnail, metadata }`, which replaces the source and leaves
 * `type` alone. `attachment.source.mimeType` is what OUR `onUpload` returned, and that is
 * `body.mimeType`: the type the server earned from `sniffMimeType` over the actual bytes.
 *
 * `composer/picked-files.ts` makes the two disagree deliberately, by passing a claim that names no
 * format so the server is the one that decides. So a PNG dragged out of an editor arrives here as
 * `type: "document"` with `source.mimeType: "image/png"`.
 *
 * AND THIS IS THE HALF THAT CAN BE PUT RIGHT FROM HERE. `QueuedMessage.attachments` is
 * `Attachment[]` — the staged object itself, source and all. A SENT turn has been through
 * `toAttachmentPart` (`channel-chat.tsx`), which rebuilds the source as `{ type: "url", value }`
 * and drops the `mimeType`, so the sent row has nothing better than the guess to go on. The two
 * rows can therefore genuinely disagree until that one line forwards it.
 */

/** A staged file as the SDK hands it over, with the guess and the server's answer set apart. */
function stagedAs(
  id: string,
  filename: string,
  type: "image" | "document",
  mimeType?: string,
): Attachment {
  return {
    id,
    type,
    source: {
      type: "url",
      value: attachmentUrl(id),
      ...(mimeType === undefined ? {} : { mimeType }),
    },
    filename,
    status: "ready",
  };
}

/*
 * THE DEFECT, ON THE SURFACE THAT HOLDS THE EVIDENCE. A screenshot the browser called text drew a
 * grey card with a filename on it, in front of somebody who had just attached a picture.
 *
 * The `<img>` is asserted by SRC and the card by its caption, because "not a document" is not the
 * claim being made — a tile that rendered nothing at all would satisfy that.
 */
test("a parked picture the browser mislabelled is drawn as a picture", () => {
  const { container, queryByText } = renderTranscript([], {
    queued: [
      parked("", [stagedAs("att-shot", "shot.png", "document", "image/png")]),
    ],
  });

  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    attachmentUrl("att-shot"),
  );
  // Not the file card: that caption is the fixed word every document tile carries.
  expect(queryByText("Attachment")).toBeNull();
});

/*
 * THE SAME MISTAKE POINTING THE OTHER WAY, AND IT IS THE LOUDER ONE. A text file the browser called
 * an image draws an `<img>` at a url the route answers 200 for with text; nothing decodes, `onError`
 * fires, and the tile replaces itself with the destructive card reading "notes.txt is unavailable."
 * — swearing in the file's own name that it was deleted while it sits on the server intact.
 */
test("a parked file the browser called a picture is drawn as a file", () => {
  const { container, getByText } = renderTranscript([], {
    queued: [
      parked("", [stagedAs("att-notes", "notes.txt", "image", "text/plain")]),
    ],
  });

  expect(container.querySelector("img")).toBeNull();
  expect(getByText("notes.txt")).toBeTruthy();
  expect(getByText("Attachment")).toBeTruthy();
});

/*
 * A PICTURE THIS BROWSER CANNOT DRAW IS NOT A PICTURE. `classifyAttachment` is asked rather than
 * `startsWith("image/")` exactly so this answers correctly: a HEIC is an image by media type and no
 * `<img>` here renders one, so the honest tile is the card naming the file rather than a box that
 * silently fails to paint.
 */
test("a parked image type this app cannot draw stays a file card", () => {
  const { container, getByText } = renderTranscript([], {
    queued: [
      parked("", [stagedAs("att-heic", "photo.heic", "image", "image/heic")]),
    ],
  });

  expect(container.querySelector("img")).toBeNull();
  expect(getByText("photo.heic")).toBeTruthy();
});

/*
 * WITHOUT THE SERVER'S ANSWER THE GUESS IS STILL USED, rather than everything collapsing to a file
 * card. `mimeType` is optional on the source, and a staged attachment that never went through our
 * `onUpload` has none — which is the shape every other parked test in this file uses, and they must
 * go on drawing exactly as they did.
 */
test("a parked file with no server type falls back to the declared one", () => {
  const { container } = renderTranscript([], {
    queued: [parked("", [stagedAs("att-shot", "shot.png", "image")])],
  });

  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    attachmentUrl("att-shot"),
  );
});

/*
 * AND THE PROBE FOLLOWS THE DRAWING. `SentAttachmentTile` asks the route whether a row is still
 * there for a DOCUMENT and never for a picture, so getting the modality right stops a request as
 * well as a wrong tile.
 *
 * HOW MUCH THAT REQUEST COSTS IS NOT WHAT THIS PINS, and the figure this note used to quote is out
 * of date: it said a HEAD was answered by Hono running the GET in full — "the whole file out of
 * Postgres" — so a mislabelled screenshot "bought a megabyte read on every render". The route now
 * answers a HEAD from `sizeBytes` without touching the bytes. What the case is actually good for is
 * unchanged and does not rest on the price: a picture's own load is the answer, so asking again is
 * asking a question that has already been answered.
 *
 * NOT ASSERTED BY WAITING ON AN EMPTY LIST, which proves nothing here for the reason the off-site
 * test above sets out at length: `waitFor` returns on its first check when the callback does not
 * throw, so an empty array reads as "not probed yet" rather than "not probed". A servable document
 * is parked beside it as the clock — waiting for THAT one's probe puts the question after the point
 * by which a probe for the picture, mounted in the same commit, would have had to appear.
 */
test("a parked picture drawn from its bytes is not probed either", async () => {
  const kept = attachmentUrl("att-clock");
  renderTranscript([], {
    queued: [
      parked("", [
        stagedAs("att-shot", "shot.png", "document", "image/png"),
        stagedAs("att-clock", "clock.pdf", "document"),
      ]),
    ],
  });

  await waitFor(() => expect(probes).toHaveLength(1));
  // One probe, and it is the real document's. Nothing was asked about the screenshot.
  expect(probes.map((probe) => probe.url)).toEqual([kept]);
});

/*
 * THE PARKED BLOCK COMES FIRST IN THE DOM, AND THAT IS A REQUIREMENT RATHER THAN AN ACCIDENT.
 *
 * It is drawn last — CSS `order` puts it under the transcript — so the obvious tidy-up is to write
 * it where it is drawn and delete the `order` classes. That tidy-up is silently destructive, which
 * is exactly why it is pinned here instead of trusted to the comment beside it.
 *
 * The scroller identifies a newly appended row POSITIONALLY. On each content change it takes
 * `Array.from(content.children)` minus the spacer, compares the length with the previous length,
 * and on growth scans from the OLD LENGTH FORWARD for the next `data-scroll-anchor="true"`. That
 * only finds the row if the row is last. With the parked block moved below `items.map`, every
 * appended row lands one slot short of the end, the scan meets the block instead, finds no anchor
 * and gives up — and a new turn stops aligning to the top of the viewport. No existing test sees
 * it, because the anchor ATTRIBUTE is still on the right row; it is the row's INDEX that broke.
 *
 * So this asserts the ordering the scroller needs, in the terms the scroller reads it in: among the
 * children of the content element, the block sits ahead of every transcript row.
 *
 * IT PINS A COST TOO, AND KNOWINGLY. Focus order and the reading order of the enclosing
 * `role="log"` follow the DOM, not `order`, so a keyboard user meets the queue's Remove buttons
 * before the conversation and a screen reader hears parked messages ahead of it. That debt is
 * described in full at the block itself. This test does not bless it — it records that the naive
 * repair is not available, so that whoever pays it properly changes the scroller's row detection
 * rather than only this markup, and has a failing test to tell them which one they changed.
 */
test("the parked block precedes the transcript rows the scroller counts", () => {
  const { container } = renderTranscript(
    [userMessage("first"), userMessage("second")],
    { queued: [parked("hold on", [])] },
  );

  const content = container.querySelector(
    '[data-slot="message-scroller-content"]',
  );
  if (!content) throw new Error("no scroller content element");

  const children = Array.from(content.children);
  // The wrapper is `display: contents`, so it is not a flex item — but it IS a child, which is the
  // list the scroller walks. It has to be the first of them.
  const parkedBlock = children.findIndex((child) =>
    child.textContent?.includes("hold on"),
  );
  const firstRow = children.findIndex((child) =>
    child.hasAttribute("data-message-id"),
  );

  expect(parkedBlock).toBe(0);
  expect(firstRow).toBeGreaterThan(parkedBlock);
});
