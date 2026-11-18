import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  answerWords,
  ChangeRows,
} from "@/components/admin/controls/describe-capabilities";
import { decidedNote } from "@/components/learning/proposal-dialog";
import {
  goalStatusOf,
  summaryFor,
} from "@/components/responsibilities/goal-page";
import { triggersNote } from "@/components/responsibilities/triggers";
import { runStatusOf as pageRunStatus } from "@/components/routines/routine-page";
import { runStatusOf as listRunStatus } from "@/components/routines/routine-runs";
import { deliveryLine } from "@/components/settings/devices";
import { latestRunLine } from "@/components/settings/learning-review";
import { TaskBoardRow, TaskRow } from "@/components/tasks/task-row";
import { knownRole } from "@/lib/auth/roles";
import type { CapabilityAnswer } from "@/lib/capability-changes/queries";
import type { CapabilityChange } from "@/lib/capability-changes/translate";
import type {
  OrganizationMemberSummary,
  ReceivedInvitation,
  SentInvitation,
} from "@/lib/organizations/queries";
import {
  givableRoles,
  receivedInvitationLine,
  roleInSentence,
  roleName,
  sentInvitationLine,
} from "@/lib/organizations/words";
import { type Person, personOf } from "@/lib/people/queries";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import { orderTasks } from "@/lib/tasks/groups";
import type { BotTask } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";
import { proposalStatusWord, runTitle } from "@/routes/_authed/admin/learning";
import { settleReactWork } from "./settle-react-work";

/*
 * A newer server may answer a status, a role or a kind this app doesn't know yet. The app reads it as
 * "other": it never crashes, never says "undefined", and never leaves a separator with nothing on one
 * side of it. A role it doesn't know is read as the least it could be, a member. Every value it
 * knows reads as before.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** A value a newer server might send, typed as whatever field it arrives in. */
const unknown = <T,>(value: string): T => value as unknown as T;

const now = new Date().toISOString();
const inDays = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

/** Said whole: no "undefined", and no separator with nothing on one side of it. */
const saysWhole = (text: string | null | undefined) => {
  expect(typeof text).toBe("string");
  expect(text).not.toContain("undefined");
  expect(text).not.toMatch(/·\s*$/);
  expect(text).not.toMatch(/^\s*·/);
  expect(text).not.toMatch(/·\s*·/);
};

test("a role the app doesn't know is read and named as a member", () => {
  expect(knownRole("billing_admin")).toBe("member");
  expect(roleName(unknown("billing_admin"))).toBe("Member");
  expect(roleInSentence(unknown("billing_admin"))).toBe("a member");
  expect(["owner", "admin", "member"].map(roleName)).toEqual([
    "Owner",
    "Admin",
    "Member",
  ]);
  const person = {
    id: "p1",
    email: "ana@example.com",
    name: "Ana",
    image: null,
    role: unknown<Person["role"]>("billing_admin"),
    providers: [],
    lastSignedInAt: null,
    revoked: false,
    configuredAdmin: false,
  };
  expect(personOf(person).role).toBe("member");
  expect(personOf({ ...person, role: "admin" }).role).toBe("admin");
});

test("a role the app doesn't know is never offered in a member's Role menu, so it is never sent back", () => {
  const member = {
    assignableRoles: [
      "billing_admin",
      "admin",
      "member",
    ] as unknown as OrganizationMemberSummary["assignableRoles"],
  };
  expect(givableRoles(member)).toEqual(["admin", "member"]);
});

test("an invitation in a status the app doesn't know says its role and nothing after it", () => {
  const invitation: SentInvitation = {
    id: "inv_1",
    email: "ana@example.com",
    role: "admin",
    status: unknown("revoked"),
    invitedBy: { name: "Dana Fresh", email: "dana@example.com" },
    createdAt: inDays(-1),
    expiresAt: inDays(6),
  };
  const line = sentInvitationLine(invitation);
  saysWhole(line);
  expect(line).toBe("Admin");
});

test("an invitation sent to you in a status the app doesn't know says who it is from", () => {
  const invitation = {
    id: "inv_2",
    organization: { id: "org_r", slug: "research", name: "Acme Research" },
    role: unknown("billing_admin"),
    status: unknown("revoked"),
    invitedBy: { name: "Lee Park", email: "lee@example.com" },
    createdAt: inDays(-1),
    expiresAt: inDays(6),
  } as ReceivedInvitation;
  const line = receivedInvitationLine(invitation);
  saysWhole(line);
  expect(line).toBe("Invited by Lee Park.");
});

test("a permission decided in a way the app doesn't know says only on or off", () => {
  const answer = (decidedBy: string, allowed: boolean): CapabilityAnswer => ({
    allowed,
    decidedBy: unknown(decidedBy),
    scopeId: "",
  });
  expect(answerWords(answer("policy_pack", true), [])).toBe("on");
  expect(answerWords(answer("policy_pack", false), [])).toBe("off");
  expect(answerWords(answer("default", true), [])).toBe("on by default");
  expect(answerWords(answer("organization", false), [])).toBe(
    "off for everybody",
  );
});

test("a change for a kind of scope the app doesn't know is listed with its id and a plain mark", () => {
  const changes: CapabilityChange[] = [
    {
      scopeKind: unknown("bot"),
      scopeId: "bot_7",
      capability: unknown("use_computer"),
      allowed: false,
    },
    {
      scopeKind: "organization",
      scopeId: "",
      capability: unknown("use_computer"),
      allowed: true,
    },
  ];
  const view = render(
    <ChangeRows
      changes={changes}
      onRemove={() => {}}
      problems={[]}
      teams={[]}
      titles={{ use_computer: "Use a computer" }}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("bot_7");
  expect(text).not.toContain("Group: bot_7");
  expect(text).toContain("Everybody");
  expect(text).not.toContain("undefined");
});

const task = (status: string, rest: Partial<BotTask> = {}): BotTask => ({
  id: `task_${status}`,
  agentId: "assistant",
  channelId: `channel_${status}`,
  threadId: `thread_${status}`,
  title: `A task that is ${status}`,
  why: null,
  origin: "check_in",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  originChannelId: null,
  status: unknown(status),
  failure: null,
  failedAt: null,
  next: null,
  resolvedAt: null,
  createdAt: now,
  updatedAt: now,
  ...rest,
});

function inRouter(children: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => children }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a task in a status the app doesn't know is listed, not crashed on, with no empty status", async () => {
  const paused = task("paused");
  const view = inRouter(
    <>
      <div data-row="row">
        <TaskRow
          botName="Ada"
          listed={{ task: paused, status: paused.status }}
        />
      </div>
      <div data-row="board">
        <TaskBoardRow listed={{ task: paused, status: paused.status }} />
      </div>
    </>,
  );
  const row = await view.findByText("A task that is paused", {
    selector: '[data-row="row"] *',
  });
  expect(row).toBeTruthy();
  const rowText =
    view.container.querySelector(
      '[data-row="row"] [data-slot="item-description"]',
    )?.textContent ?? "";
  saysWhole(rowText);
  expect(rowText.startsWith("Ada · ")).toBe(true);
  const board = view.container.querySelector('[data-row="board"]');
  const meta = board?.querySelector(".text-xs")?.textContent ?? "";
  saysWhole(meta);
  expect(board?.textContent).not.toContain("undefined");
});

test("a task in a status the app doesn't know is listed after every status it knows", () => {
  const listed = orderTasks(
    [task("paused"), task("resolved"), task("working"), task("needs_input")],
    () => false,
    Date.now(),
  );
  expect(listed.map((each) => each.status)).toEqual([
    "needs_input",
    "working",
    "resolved",
    "paused",
  ]);
});

test("a goal in a status the app doesn't know has a mark and says nothing it doesn't know", () => {
  const goal = {
    id: "goal_1",
    status: unknown("archived"),
  } as ResponsibilityRecord;
  expect(goalStatusOf("archived").icon).toBeTruthy();
  expect(goalStatusOf("archived").label).toBeNull();
  expect(goalStatusOf("paused").label).toBe("Paused");
  expect(summaryFor(goal, [], [])).toBe("");
});

test("a goal in a state the app doesn't know is not said in the server's own word under Triggers", () => {
  expect(triggersNote("pending_approval")).toBeNull();
  expect(triggersNote("active")).toBeNull();
  expect(triggersNote("paused")).toBe(
    "This goal is paused. Its triggers won't start it.",
  );
  expect(triggersNote("completed")).toBe(
    "This goal is completed. Its triggers won't start it.",
  );
});

test("a routine run in a status the app doesn't know is not called Skipped", () => {
  for (const look of [pageRunStatus, listRunStatus]) {
    expect(look("cancelled")).toBeNull();
    expect(look("skipped")?.text).toBe("Skipped");
    expect(look("succeeded")?.text).toBe("Succeeded");
  }
});

test("a Learning run or proposal in a status the app doesn't know says nothing about where it stands", () => {
  const line = latestRunLine({ status: unknown("paused"), failure: null });
  expect(line).not.toContain("undefined");
  expect(line).toBe("");
  expect(
    latestRunLine({
      status: unknown("paused"),
      failure: "It ran out of time.",
    }),
  ).toBe("It ran out of time.");
  expect(latestRunLine({ status: "succeeded", failure: null })).toBe(
    "Latest run finished.",
  );
  const title = runTitle({
    status: unknown("paused"),
    triggerSource: "manual",
  });
  saysWhole(title);
  expect(title).toBe("Manual");
  expect(runTitle({ status: "queued", triggerSource: "automatic" })).toBe(
    "Queued · Automatic",
  );
  expect(proposalStatusWord("archived")).toBeNull();
  expect(proposalStatusWord("approved")).toBe("Published");
  expect(decidedNote("archived", false, "Published.")).toBeNull();
  expect(decidedNote("approved", false, "Published.")).toBe("Published.");
  expect(decidedNote("rejected", true, "Published.")).toBe(
    "Rejected. The skill stays.",
  );
});

test("a delivery in a state the app doesn't know leaves the state out of its line", () => {
  const line = deliveryLine({
    transport: "push",
    state: unknown("bounced"),
    createdAt: "2026-11-17T10:00:00Z",
  });
  saysWhole(line);
  expect(line.startsWith("Push · ")).toBe(true);
  expect(line.split(" · ")).toHaveLength(2);
  expect(
    deliveryLine({
      transport: "push",
      state: "delivered",
      createdAt: "2026-11-17T10:00:00Z",
    }).startsWith("Push · Delivered · "),
  ).toBe(true);
});
