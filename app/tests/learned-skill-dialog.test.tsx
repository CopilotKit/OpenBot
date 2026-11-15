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
import {
  LEARNING,
  learningContract,
  ORGANIZATION,
  personLearning,
  problem,
  requestOf,
  served,
} from "./learning-api";

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

/** A name a path has to encode: a space, an ampersand and a question mark. */
const ODD_NAME = "a b&c?";

beforeEach(() => {
  queryClient.clear();
  asked.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      asked.push(url);
      const request = requestOf(path, init);
      if (request.path === personLearning().learnedSkill("refund-order"))
        return served(learningContract.GetLearnedSkillResponse, skill);
      if (
        request.path === LEARNING.skill(ODD_NAME) &&
        request.query.get("botId") === "bot-1"
      )
        return served(learningContract.GetPublishedSkillResponse, {
          ...skill,
          name: ODD_NAME,
        });
      return problem(
        404,
        "That skill is no longer there.",
        "LEARNED_SKILL_NOT_FOUND",
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
  expect(asked).toEqual([personLearning().learnedSkill("refund-order")]);
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
  const view = draw(ODD_NAME, () => {}, { kind: "admin", agentId: "bot-1" });
  await view.findByText("Open the order, then refund it.");
  expect(asked).toEqual([
    `${ORGANIZATION}/settings/learning/skills/a%20b%26c%3F?botId=bot-1`,
  ]);
});
