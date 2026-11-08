import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LearnedSkillContent } from "@openbot/shared/learning";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LearnedSkillDialog } from "@/components/learning/learned-skill-dialog";
import type { LearnedSkillSource } from "@/lib/learning/queries";
import { queryClient } from "@/query-client";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const asked: string[] = [];
const skill: LearnedSkillContent = {
  name: "refund-order",
  description: "Refunds an order.",
  files: [
    {
      path: "SKILL.md",
      text: "---\nname: refund-order\n---\nOpen the order, then refund it.",
    },
  ],
};

beforeEach(() => {
  queryClient.clear();
  asked.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      asked.push(url);
      if (url === "/api/settings/learning/skills/refund-order")
        return Response.json({ skill });
      if (
        url ===
        `/api/admin/learning/skills/${encodeURIComponent("a b/c")}?agentId=bot-1`
      )
        return Response.json({ skill: { ...skill, name: "a b/c" } });
      return Response.json(
        { error: "That skill is no longer there." },
        { status: 404 },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function tree(
  name: string | null,
  onClose = () => {},
  source: LearnedSkillSource = { kind: "personal" },
) {
  return (
    <QueryClientProvider client={queryClient}>
      <LearnedSkillDialog name={name} onClose={onClose} source={source} />
    </QueryClientProvider>
  );
}

function draw(
  name: string | null,
  onClose = () => {},
  source: LearnedSkillSource = { kind: "personal" },
) {
  return render(tree(name, onClose, source));
}

test("the personal source fetches the skill and renders its SKILL.md", async () => {
  const view = draw("refund-order");
  await view.findByText("Open the order, then refund it.");
  expect(asked).toEqual(["/api/settings/learning/skills/refund-order"]);
  expect(view.getByText("Refunds an order.")).toBeTruthy();
  expect(view.getByText("Refund order")).toBeTruthy();
});

test("a 404 shows the server's message", async () => {
  const view = draw("gone");
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toBe(
      "That skill is no longer there.",
    ),
  );
});

test("without a name nothing is fetched and the dialog is closed", () => {
  const view = draw(null);
  expect(asked).toEqual([]);
  expect(view.queryByRole("dialog")).toBeNull();
});

test("Done closes the dialog", async () => {
  let closed = 0;
  const view = draw("refund-order", () => {
    closed += 1;
  });
  fireEvent.click(await view.findByRole("button", { name: "Done" }));
  expect(closed).toBe(1);
});

test("the admin source reads the Bot's skill with its name encoded", async () => {
  const view = draw("a b/c", () => {}, { kind: "admin", agentId: "bot-1" });
  await view.findByText("Open the order, then refund it.");
  expect(asked).toEqual(["/api/admin/learning/skills/a%20b%2Fc?agentId=bot-1"]);
});
