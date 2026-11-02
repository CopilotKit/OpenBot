import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ConversationIntro } from "@/components/channels/conversation-intro";
import { settleReactWork } from "./settle-react-work";

/*
 * The top of a conversation with one Bot: its orb, its name, what it does, and who can see it.
 * Drawn from the Bot's profile the conversation already has.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const expenseReview = {
  id: "expense-review",
  name: "Expense Review",
  title: "Finance Operations",
  roleDescription: "Reads every expense claim against the travel policy.",
  avatarSeed: "seed-1",
  visibility: "private" as const,
};

test("shows the Bot's name, what it does, and that it is private", () => {
  const view = render(<ConversationIntro agent={expenseReview} />);
  expect(view.getByRole("heading", { level: 1 }).textContent).toBe(
    "Expense Review",
  );
  view.getByText(
    "Finance Operations · Reads every expense claim against the travel policy.",
  );
  view.getByText("Private");
  expect(view.queryByText("Public")).toBeNull();
});

test("a public Bot says so", () => {
  const view = render(
    <ConversationIntro agent={{ ...expenseReview, visibility: "public" }} />,
  );
  view.getByText("Public");
});

test("a Bot with no role shows its title alone", () => {
  const view = render(
    <ConversationIntro agent={{ ...expenseReview, roleDescription: null }} />,
  );
  view.getByText("Finance Operations");
});

test("the orb is the large one, named once", () => {
  const view = render(<ConversationIntro agent={expenseReview} />);
  const orb = view.getByRole("img");
  expect(orb.getAttribute("aria-label")).toBe("Expense Review");
  expect(orb.dataset.variant).toBe("live");
});

test("a paragraph-long role is held to two lines, with the whole text on hover", () => {
  const role =
    "Check one expense claim at a time against the policy as it is written. "
      .repeat(6)
      .trim();
  const view = render(
    <ConversationIntro agent={{ ...expenseReview, roleDescription: role }} />,
  );
  const line = view.getByTitle(`Finance Operations · ${role}`);
  expect(line.className).toContain("line-clamp-2");
});
