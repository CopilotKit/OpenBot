import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { SkillChecklist } from "@/components/skills/import-skills";
import {
  AddSkillsCard,
  ProposedSkillsCard,
} from "@/components/skills/skill-cards";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { describeOutcomes, slugStatus } from "@/lib/skills/import";
import { type Skill, skillListQueryOptions } from "@/lib/skills/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * Bringing in several skills at once: from GitHub, from a Bot's drafts, and putting saved ones on a
 * Bot. Each list says what saving would do to each command, and nothing is saved until the button.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const ME = "user-1";
const skill = (
  slug: string,
  owner: string | null,
  grantedTo: string[] = [],
): Skill => ({
  id: slug,
  slug,
  ownerUserId: owner,
  title: slug,
  summary: "",
  instructions: "Do it.",
  grantedTo,
  everyBot: false,
  tools: [],
  usableOnYourBots: owner === ME,
});
const existing = [
  skill("blog-post", ME),
  skill("docs", "user-2"),
  skill("standup", ME, ["bot-a"]),
];

function withData(children: ReactNode) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(skillListQueryOptions().queryKey, existing);
  queryClient.setQueryData(currentUserQueryOptions().queryKey, {
    id: ME,
  } as never);
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

describe("what saving under a command does", () => {
  test("makes a new skill, rewrites the person's own, or would touch somebody else's", () => {
    expect(slugStatus("fix-bug", existing, ME)).toBe("new");
    expect(slugStatus("blog-post", existing, ME)).toBe("yours");
    expect(slugStatus("docs", existing, ME)).toBe("theirs");
  });

  test("an import is told to the Bot skill by skill", () => {
    expect(
      describeOutcomes(
        [
          { slug: "a", saved: true, onBot: true, note: null },
          { slug: "b", saved: true, onBot: false, note: "Only an admin may." },
          { slug: "c", saved: false, reason: "Another skill already uses /c." },
        ],
        "Personal Assistant",
      ),
    ).toBe(
      "Saved 2 skills: /a, /b. They're on Personal Assistant. /b isn't on Personal Assistant: Only an admin may. /c wasn't saved: Another skill already uses /c.",
    );
    expect(describeOutcomes([])).toBe("Nothing was saved.");
  });
});

describe("the list of skills to tick", () => {
  test("says what each would do, and won't tick one it can't save", () => {
    const view = withData(
      <SkillChecklist
        onPick={() => {}}
        picked={new Set(["fix-bug"])}
        skills={[
          {
            slug: "fix-bug",
            title: "Fix Bug",
            summary: "Find it.",
            instructions: "x",
            leftOut: [],
          },
          {
            slug: "blog-post",
            title: "Blog Post",
            summary: "",
            instructions: "x",
            leftOut: ["a.md", "b.md", "c.md", "d.md"],
          },
          { slug: "docs", title: "Docs", summary: "", instructions: "x" },
          {
            slug: "huge",
            title: "Huge",
            summary: "",
            instructions: "",
            problem: "Its SKILL.md is over 256 KB, too long for one skill.",
          },
        ]}
      />,
    );
    expect(view.getByText("Replaces yours")).toBeTruthy();
    expect(view.getByText("Another skill already uses /docs.")).toBeTruthy();
    expect(
      view.getByText("Leaves out 4 files: a.md, b.md, c.md and 1 more."),
    ).toBeTruthy();
    const boxes = view.getAllByRole("checkbox");
    expect(
      boxes.map(
        (box) =>
          box.getAttribute("aria-disabled") === "true" ||
          box.hasAttribute("data-disabled"),
      ),
    ).toEqual([false, false, true, true]);
  });
});

describe("a Bot's cards", () => {
  test("several drafted skills start ticked, and save with one button", async () => {
    const view = withData(
      <ProposedSkillsCard
        args={{
          skills: [
            {
              slug: "fix-bug",
              title: "Fix a bug",
              instructions: "Find the root cause.",
            },
            { slug: "rfc", title: "Write an RFC", instructions: "Draft it." },
          ],
        }}
        respond={async () => {}}
      />,
    );
    expect(
      await view.findByRole("button", { name: "Save 2 skills" }),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Don't save" })).toBeTruthy();
  });

  test("putting skills on a Bot names the ones there are and the ones there aren't", () => {
    const view = withData(
      <AddSkillsCard
        args={{ skills: ["/standup", "nope"] }}
        respond={async () => {}}
      />,
    );
    expect(view.getByText("/standup")).toBeTruthy();
    expect(view.getByText("There's no skill called /nope.")).toBeTruthy();
  });

  test("a card that was answered shows the answer", () => {
    const view = withData(
      <AddSkillsCard
        args={{ skills: ["standup"] }}
        result="/standup is on Personal Assistant now."
      />,
    );
    expect(
      view.getByText("/standup is on Personal Assistant now."),
    ).toBeTruthy();
  });
});
