import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/**
 * How a conversation's words are drawn: the Bot's reply one bubble per thought, the person's in a
 * bubble of their own, and three dots while the Bot has not said anything yet.
 */

const reply = (text: string): Message => ({
  id: "reply",
  role: "assistant",
  content: text,
});
const asked: Message = { id: "asked", role: "user", content: "What's on?" };

/** The Bot's bubbles, by the hook every skin finds them with. */
function botBubbles(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-slot="bubble"][data-variant="ghost"][data-align="start"]',
    ),
  );
}

test("a Bot's reply is drawn one bubble per thought", () => {
  const view = render(
    <ChatTranscript
      messages={[asked, reply("Two things today.\n\nThe first is at ten.")]}
    />,
  );
  const bubbles = botBubbles(view.container);
  expect(bubbles.map((bubble) => bubble.textContent)).toEqual([
    "Two things today.",
    "The first is at ten.",
  ]);
  // Each is a bubble of its own, in the Bot's colour.
  for (const bubble of bubbles)
    expect(bubble.className).toContain(
      "*:data-[slot=bubble-content]:bg-bubble",
    );
});

test("a thought still arriving joins its bubble rather than starting another", async () => {
  const view = render(
    <ChatTranscript busy messages={[asked, reply("Here are three:")]} />,
  );
  expect(botBubbles(view.container)).toHaveLength(1);
  view.rerender(
    <ChatTranscript
      busy
      messages={[asked, reply("Here are three:\n\n- Standup\n- Lunch")]}
    />,
  );
  // What arrived is revealed a little behind it (`usePacedReveal`), into the same bubble.
  await waitFor(() =>
    expect(botBubbles(view.container)[0]?.querySelectorAll("li")).toHaveLength(
      2,
    ),
  );
  expect(botBubbles(view.container)).toHaveLength(1);
});

test("a bubble holding a code block or a table spans the column on a wide screen; prose keeps the cap", () => {
  const view = render(
    <ChatTranscript
      messages={[
        asked,
        reply(
          "Run this:\n\n```sh\nbun test\n```\n\n| Day | Time |\n|---|---|\n| Mon | 10 |",
        ),
      ]}
    />,
  );
  const [prose, code, table] = botBubbles(view.container);
  expect(prose?.className).not.toContain("md:w-full");
  expect(code?.className).toContain("md:w-full");
  expect(table?.className).toContain("md:w-full");
  // On a phone every one of them keeps the cap.
  for (const bubble of [prose, code, table])
    expect(bubble?.className).toContain("data-[variant=ghost]:max-w-[82%]");
});

test("the person's words sit in their own bubble, exactly as typed", () => {
  const view = render(
    <ChatTranscript
      messages={[{ id: "a", role: "user", content: "Is *this* bold?\n\nNo." }]}
    />,
  );
  const bubble = view.container.querySelector(
    '[data-slot="bubble"][data-align="end"]',
  );
  expect(bubble?.textContent).toBe("Is *this* bold?\n\nNo.");
  expect(bubble?.className).toContain(
    "*:data-[slot=bubble-content]:bg-bubble-user",
  );
  expect(botBubbles(view.container)).toHaveLength(0);
});

test("while the Bot has said nothing, three dots stand where its words will land", () => {
  const view = render(<ChatTranscript busy messages={[asked]} />);
  const status = view.getByRole("status");
  // A screen reader is told the word; everybody else sees the dots.
  expect(status.textContent).toBe("Thinking");
  const dots = status.querySelectorAll(".typing-dot");
  expect(dots).toHaveLength(3);
  for (const dot of dots) expect(dot.getAttribute("aria-hidden")).toBe("true");
});
