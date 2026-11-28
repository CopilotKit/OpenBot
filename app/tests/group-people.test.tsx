import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  answerGroupRead,
  conversationPath,
  type GroupFixture,
  noContent,
  problem,
} from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Who is in a group, from a button in its top bar: the people in it, taking someone out or leaving,
 * and adding someone by email. It used to float above the composer.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let people: GroupFixture["people"] = [];
const requests: string[] = [];
/** What was searched for among the organization's members, in order. */
const searched: string[] = [];
const MEMBERS_PATH = "/api/v2/organizations/default/members";
const member = (id: string, email: string, name: string | null) => ({
  id,
  email,
  name,
  image: null,
  role: "member" as const,
  joinedAt: "2026-11-01T09:00:00.000Z",
  removable: true,
  assignableRoles: [],
});
/** The organization's members: who can be added to a group. */
const ORGANIZATION = [
  member("me", "me@example.test", null),
  member("u2", "alex@example.test", "Alex"),
  member("u3", "sam@example.test", "Sam"),
];
function serving(initial: GroupFixture["people"]) {
  people = initial;
  requests.length = 0;
  searched.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      requests.push(`${method} ${url} ${init?.body ?? ""}`);
      // Adding answers 201 with the person added; taking one out answers with nothing.
      if (
        method === "POST" &&
        url === conversationPath("group-1", "/members")
      ) {
        people = [
          ...people,
          {
            userId: "u3",
            email: "sam@example.test",
            name: "Sam",
            creator: false,
          },
        ];
        return Response.json({ personId: "u3" }, { status: 201 });
      }
      const removed = people.find(
        (person) =>
          url === conversationPath("group-1", `/members/${person.userId}`),
      );
      if (method === "DELETE" && removed) {
        people = people.filter((person) => person !== removed);
        return noContent();
      }
      return problem(404, "Not found.");
    }
    // The organization's members, searched as a name or address is typed to add somebody.
    const asked = new URL(url, "http://openbot.invalid");
    if (asked.pathname === MEMBERS_PATH) {
      searched.push(asked.searchParams.get("search") ?? "");
      const typed = (asked.searchParams.get("search") ?? "").toLowerCase();
      return Response.json({
        members: ORGANIZATION.filter(
          (one) =>
            one.email.includes(typed) ||
            one.name?.toLowerCase().includes(typed),
        ),
        nextCursor: null,
      });
    }
    if (url === ME_PATH) {
      return meResponse({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    }
    return (
      answerGroupRead(input, init, "group-1", {
        bots: [],
        people,
        messages: [],
      }) ?? problem(404, "Not found.")
    );
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GroupPeopleButton channelId="group-1" />
    </QueryClientProvider>,
  );
}

const ME = {
  userId: "me",
  email: "me@example.test",
  name: null,
  creator: true,
};
const ALEX = {
  userId: "u2",
  email: "alex@example.test",
  name: "Alex",
  creator: false,
};

test("the top bar says how many people are in the group", async () => {
  serving([ME, ALEX]);
  const view = draw();
  expect(await view.findByRole("button", { name: "2 people" })).toBeTruthy();
});

test("the creator sees everyone and can take another person out", async () => {
  serving([ME, ALEX]);
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "2 people" }));
  expect(await view.findByText("Alex")).toBeTruthy();
  expect(view.getByText("You")).toBeTruthy();
  fireEvent.click(
    view.getByRole("button", { name: "Remove alex@example.test" }),
  );
  await waitFor(() =>
    expect(requests).toContain(
      "DELETE /api/v2/organizations/default/conversations/group-1/members/u2 ",
    ),
  );
});

test("adding someone finds them among the organization's members as they type, and lists them without reopening the dialog", async () => {
  serving([ME, ALEX]);
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "2 people" }));
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("combobox", { name: "Name or email" }),
    "a",
  );
  // Alex is in the group already, and says so; Sam is offered.
  const alex = await view.findByRole("option", { name: /^Alex,/ });
  expect(alex.getAttribute("aria-disabled")).toBe("true");
  expect(alex.textContent).toContain("In this group");
  await user.click(await view.findByRole("option", { name: /^Sam,/ }));
  await waitFor(() =>
    expect(requests).toContain(
      'POST /api/v2/organizations/default/conversations/group-1/members {"email":"sam@example.test"}',
    ),
  );
  expect(await view.findByText("Sam")).toBeTruthy();
  // Only the organization's own members were searched.
  expect(searched).toContain("a");
});
