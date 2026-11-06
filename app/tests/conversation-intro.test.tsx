import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ConversationIntro } from "@/components/channels/conversation-intro";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * The top of a conversation with one Bot: its kite, its name, what it does, and who can see it.
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
  const view = draw(<ConversationIntro agent={expenseReview} />);
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
  const view = draw(
    <ConversationIntro agent={{ ...expenseReview, visibility: "public" }} />,
  );
  view.getByText("Public");
});

test("a Bot with no role shows its title alone", () => {
  const view = draw(
    <ConversationIntro agent={{ ...expenseReview, roleDescription: null }} />,
  );
  view.getByText("Finance Operations");
});

test("the kite is the large one, named once, and rests between turns", () => {
  const view = draw(<ConversationIntro agent={expenseReview} />);
  const kite = view.getByRole("img");
  expect(kite.getAttribute("aria-label")).toBe("Expense Review");
  expect(kite.style.width).toBe("96px");
  expect(kite.dataset.state).toBe("idle");
});

test("the kite works while the Bot has the turn", () => {
  const view = draw(<ConversationIntro agent={expenseReview} busy />);
  expect(view.getByRole("img").dataset.state).toBe("thinking");
});

test("a paragraph-long role is held to two lines, with the whole text on hover", () => {
  const role =
    "Check one expense claim at a time against the policy as it is written. "
      .repeat(6)
      .trim();
  const view = draw(
    <ConversationIntro agent={{ ...expenseReview, roleDescription: role }} />,
  );
  const line = view.getByTitle(`Finance Operations · ${role}`);
  expect(line.className).toContain("line-clamp-2");
});

function draw(screen: ReactNode, edition: "team" | "personal" = "team") {
  const client = new QueryClient();
  client.setQueryData(deploymentKeys.capabilities(), { edition });
  return render(
    <QueryClientProvider client={client}>{screen}</QueryClientProvider>,
  );
}

test.each(["public", "private"] as const)(
  "personal chat hides %s visibility",
  (visibility) => {
    const view = draw(
      <ConversationIntro agent={{ ...expenseReview, visibility }} />,
      "personal",
    );
    expect(view.queryByText("Public")).toBeNull();
    expect(view.queryByText("Private")).toBeNull();
    expect(view.getByRole("heading", { name: "Expense Review" })).toBeTruthy();
  },
);
