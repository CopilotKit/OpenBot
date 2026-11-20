import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { COMPONENT_GUIDANCE } from "@openbot/shared/bot-prompt";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChecklistCard, GALLERY } from "@/components/gallery/cards";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/*
 * A Bot answered "list three fixes" with a checklist, every item ticked, and every item drawn struck
 * through: the answer read as crossed out.
 */
const FIXES = {
  title: "Three fixes",
  items: [
    { text: "Raise the connection pool to 20", done: true },
    { text: "Cache the pricing lookup", done: true },
    { text: "Retry the webhook with backoff", done: false },
  ],
};

test("a finished item reads as done, never as crossed out", () => {
  const view = render(<ChecklistCard {...FIXES} />);
  expect(view.container.querySelector(".line-through")).toBeNull();
  for (const item of FIXES.items) {
    const row = view.getByText(item.text).closest("li");
    expect(row?.textContent).toContain(item.done ? "Done" : "To do");
  }
  expect(view.getByText("2 of 3")).toBeDefined();
});

test("the model is told a checklist is for work to tick off, not for presenting information", () => {
  const checklist = GALLERY.find((entry) => entry.name === "showChecklist");
  const description = checklist?.description.toLowerCase() ?? "";
  expect(description).toContain("tasks");
  expect(description).toMatch(/not .*(information|findings|recommendations)/);
  // The guidance every Bot reads no longer sends "a list" to a checklist.
  const guidance = COMPONENT_GUIDANCE.replace(/\s+/g, " ");
  expect(guidance).not.toMatch(/a list or a plan: a checklist/i);
  expect(guidance).toMatch(/recommendations[^.]*never a checklist/i);
});
