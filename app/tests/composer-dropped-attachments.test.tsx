import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Attachment } from "@copilotkit/react-core/v2";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

/**
 * What the composer does with `droppedAttachments`: the files the queue has let go of, which must
 * not vanish with nothing said — see `queue.ts`'s `droppedAttachments` and
 * `conversation-view.tsx`, the only caller that produces this prop from a real queue.
 *
 * TWO KINDS OF FILE ARRIVE ON THIS PROP AND THEY GET DIFFERENT SENTENCES. The cap re-check bumps
 * the excess off a drained turn; a person taking a queued message back takes everything it was
 * carrying with it. `conversation-view.tsx` releases the server-side row either way and hands both
 * here to be said out loud, with the cause attached — because the composer's reason for one of them
 * is false about the other, and telling somebody about a limit they never reached sends them
 * looking for a rule to work around. The last two cases below are that split; the earlier ones are
 * the part that holds regardless, which is that the FILE is named.
 *
 * WHAT THE PROP OWES ITS CALLER, and it is not only a value: the effect that turns this into
 * refusal lines is keyed on the OBJECT, so the same object arriving again is a render that reports
 * nothing and a fresh object is a new batch of lines. That is a contract on whoever passes it, and
 * the two `rerender` cases at the end are what hold it to that in both directions.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `agent-roster-error.test.tsx` for the reason recorded there: bun walks
 * every file into one process, and a document another file tore down mid-run fails invisibly.
 *
 * The registration carries a `url`, matching `composer-attachments-ui.test.tsx`: without one
 * `location` is `about:blank` and relative URLs do not resolve.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/**
 * `filename` is OPTIONAL on the SDK's `Attachment` and optional here for the same reason: the
 * composer has a fallback for the case where there is no name to print, and a helper that always
 * supplies one is a helper that makes that fallback untestable. See the last case in this file.
 */
function attachment(id: string, filename?: string): Attachment {
  return {
    id,
    ...(filename === undefined ? {} : { filename }),
    source: { type: "url", value: `https://example.com/${id}.png` },
    status: "ready",
    type: "image",
  };
}

test("a drain that drops attachments shows one line per dropped file, each naming that file", async () => {
  const dropped = {
    cause: "merged-over-cap",
    attachments: [
      attachment("one", "invoice.pdf"),
      attachment("two", "receipt.png"),
    ],
  } as const;

  const { container, findByRole } = render(
    <Composer compact droppedAttachments={dropped} onSubmit={() => {}} />,
  );

  const alert = await findByRole("alert");
  const lines = container.querySelectorAll('[role="alert"] p');
  // One line per dropped file, not one message for the whole batch — collapsing them would leave
  // no way to tell which of the two files a single reported reason was about.
  expect(lines).toHaveLength(2);
  expect(alert.textContent).toContain("invoice.pdf");
  expect(alert.textContent).toContain("receipt.png");
});

test("a drain that drops none shows nothing", () => {
  const { container } = render(
    <Composer
      compact
      droppedAttachments={{ attachments: [], cause: "merged-over-cap" }}
      onSubmit={() => {}}
    />,
  );

  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("the dropped reason is distinguishable from a pick-time refusal reason", async () => {
  const { container, findByRole } = render(
    <Composer
      channelId="channel-1"
      compact
      droppedAttachments={{
        attachments: [attachment("one", "invoice.pdf")],
        cause: "merged-over-cap",
      }}
      onSubmit={() => {}}
    />,
  );

  // The dropped reason is already on screen from mount, before any file is ever picked.
  const droppedAlert = await findByRole("alert");
  const droppedReason = droppedAlert.textContent ?? "";
  expect(droppedReason).toContain("queued messages were merged");

  // Now trigger the other kind of refusal: a file refused at pick time, for an unrelated reason.
  const form = container.querySelector("form") as HTMLFormElement;
  fireEvent.drop(form, {
    dataTransfer: {
      files: [new File(["<svg />"], "logo.svg", { type: "image/svg+xml" })],
      items: [],
      types: ["Files"],
    },
  });

  await waitFor(() =>
    expect(container.querySelectorAll('[role="alert"] p')).toHaveLength(2),
  );
  const lines = Array.from(container.querySelectorAll('[role="alert"] p')).map(
    (line) => line.textContent ?? "",
  );

  const pickTimeReason = lines.find((line) => line.includes("logo.svg"));
  const dropReason = lines.find((line) => line.includes("invoice.pdf"));
  expect(pickTimeReason).toBeDefined();
  expect(dropReason).toBeDefined();
  // Different sentences for a different cause: a file refused on pick names the SVG rule, and a
  // file dropped by a drain names the cap and the merge that overran it.
  expect(dropReason).not.toBe(pickTimeReason);
  expect(dropReason).toContain("queued messages were merged");
  expect(pickTimeReason).toContain("SVG");
  expect(pickTimeReason).not.toContain("queued messages were merged");
});

/**
 * TWO CAUSES REACH THIS PROP, AND UNTIL NOW ONLY ONE OF THEM WAS TRUE OF THE SENTENCE.
 *
 * `reduceQueue` reports a bare `Attachment[]` whichever way the files left, and the composer built
 * one hardcoded reason for it — "dropped when queued messages were merged into one: a message can
 * carry at most 8 attachments". Once a REMOVED queued message routes its attachments down the same
 * channel, that sentence is simply false: nothing was merged and no cap was hit. Somebody took a
 * parked message out of the queue and its files went with it, and being told about a cap they never
 * reached is worse than the bare fact, because it sends them looking for a limit to work around.
 *
 * The cause travels with the files now — see `DroppedAttachments` in `composer.tsx` — and
 * `conversation-view.tsx` reads it off the queue action, which is the one place that knows.
 */
test("attachments dropped by a removal say that, not that a cap was hit", async () => {
  const { findByRole } = render(
    <Composer
      compact
      droppedAttachments={{
        attachments: [attachment("one", "invoice.pdf")],
        cause: "queued-message-removed",
      }}
      onSubmit={() => {}}
    />,
  );

  const alert = await findByRole("alert");
  const reason = alert.textContent ?? "";

  expect(reason).toContain("invoice.pdf");
  expect(reason).toContain("removed");
  expect(reason).not.toContain("merged");
  expect(reason).not.toContain("at most");
});

test("the two causes do not share a sentence", async () => {
  const merged = render(
    <Composer
      compact
      droppedAttachments={{
        attachments: [attachment("one", "invoice.pdf")],
        cause: "merged-over-cap",
      }}
      onSubmit={() => {}}
    />,
  );
  const mergedReason = (await merged.findByRole("alert")).textContent ?? "";
  cleanup();

  const removed = render(
    <Composer
      compact
      droppedAttachments={{
        attachments: [attachment("one", "invoice.pdf")],
        cause: "queued-message-removed",
      }}
      onSubmit={() => {}}
    />,
  );
  const removedReason = (await removed.findByRole("alert")).textContent ?? "";

  expect(mergedReason).not.toBe(removedReason);
  expect(mergedReason).toContain("merged");
});

/**
 * THE CONTRACT THIS PROP PUTS ON ITS CALLER, WHICH NOTHING HELD IT TO.
 *
 * The composer keys its dropped-files effect on the prop OBJECT rather than on anything derived
 * from it, and says why: "the caller is expected to hand over a fresh one only when a new drop
 * actually happened". That is a real requirement and an invisible one. A caller that builds the
 * object inline in its JSX passes a new identity on every render, and every render then appends
 * the same refusal lines again — a list that grows without bound underneath somebody who is only
 * typing. `conversation-view.tsx` holds it in state, so it is safe today; nothing was checking.
 *
 * Every other case in this file renders once, which is exactly the shape that cannot see this.
 */
test("the same dropped object arriving again reports nothing a second time", async () => {
  const dropped = {
    attachments: [attachment("one", "invoice.pdf")],
    cause: "merged-over-cap",
  } as const;

  const { container, findByRole, rerender } = render(
    <Composer compact droppedAttachments={dropped} onSubmit={() => {}} />,
  );
  await findByRole("alert");
  expect(container.querySelectorAll('[role="alert"] p')).toHaveLength(1);

  // The identical object, which is what an unrelated re-render looks like from in here: a keystroke,
  // a parent refetch, a `pending` flipping. Nothing was dropped, so nothing may be said again.
  rerender(
    <Composer compact droppedAttachments={dropped} onSubmit={() => {}} />,
  );

  expect(container.querySelectorAll('[role="alert"] p')).toHaveLength(1);
});

test("a fresh dropped object with equal contents reports the drop again", async () => {
  const first = {
    attachments: [attachment("one", "invoice.pdf")],
    cause: "merged-over-cap",
  } as const;

  const { container, findByRole, rerender } = render(
    <Composer compact droppedAttachments={first} onSubmit={() => {}} />,
  );
  await findByRole("alert");
  expect(container.querySelectorAll('[role="alert"] p')).toHaveLength(1);

  // THE OTHER HALF, AND THE REASON THE FIRST CANNOT BE FIXED BY COMPARING CONTENTS. Two drops of
  // the same file are two events — drop it, park it, remove the message, do all of it again — and
  // a composer that deduplicated on value would swallow the second one silently. Equal contents,
  // new object: one more line.
  const second = {
    attachments: [attachment("one", "invoice.pdf")],
    cause: "merged-over-cap",
  } as const;
  rerender(
    <Composer compact droppedAttachments={second} onSubmit={() => {}} />,
  );

  await waitFor(() =>
    expect(container.querySelectorAll('[role="alert"] p')).toHaveLength(2),
  );
});

/**
 * A DROPPED FILE WITH NO NAME STILL GETS A LINE, AND THE LINE IS NOT ABOUT `undefined`.
 *
 * `filename` is optional on the SDK's `Attachment`, so the composer prints `filename ?? "Attachment"`
 * — and every other case in this file went through a helper that always supplied one, so the
 * fallback had never run. The rendered line is `<name>: <reason>`, which without the fallback reads
 * "undefined: dropped when queued messages were merged into one…": a sentence naming a file the
 * person cannot match to anything they picked, about a file they cannot get back.
 */
test("a dropped attachment with no filename reads as an attachment, not as undefined", async () => {
  const { container, findByRole } = render(
    <Composer
      compact
      droppedAttachments={{
        attachments: [attachment("one")],
        cause: "merged-over-cap",
      }}
      onSubmit={() => {}}
    />,
  );

  await findByRole("alert");
  const line = container.querySelector('[role="alert"] p');

  expect(line?.textContent).toStartWith("Attachment: ");
  expect(line?.textContent).not.toContain("undefined");
});
