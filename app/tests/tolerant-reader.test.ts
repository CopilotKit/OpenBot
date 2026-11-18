import { afterEach, describe, expect, test } from "bun:test";
import { listNetworkPolicies } from "../src/lib/api/generated/network-policies/network-policies";
import { getListNetworkPoliciesResponseMock } from "../src/lib/api/generated/network-policies/network-policies.msw";
import { ListNetworkPoliciesResponse } from "../src/lib/api/generated/network-policies/network-policies.zod";
import { getPerson } from "../src/lib/api/generated/people/people";
import { getGetPersonResponseMock } from "../src/lib/api/generated/people/people.msw";
import { GetPersonResponse } from "../src/lib/api/generated/people/people.zod";
import { listRoutineRuns } from "../src/lib/api/generated/routines/routines";
import { getListRoutineRunsResponseMock } from "../src/lib/api/generated/routines/routines.msw";
import { ListRoutineRunsResponse } from "../src/lib/api/generated/routines/routines.zod";
import { getTask } from "../src/lib/api/generated/tasks/tasks";
import { getGetTaskResponseMock } from "../src/lib/api/generated/tasks/tasks.msw";
import { GetTaskResponse } from "../src/lib/api/generated/tasks/tasks.zod";

/**
 * The app's generated client is a tolerant reader (api/README.md, Enums that grow): a newer server
 * may answer with a field this app has never heard of, or a value it doesn't know in an enum the spec
 * declares open, and neither may break a read. Each case is a real answer, the spec's own example as
 * the generated mocks give it, with an unknown field added and an open enum given a value no release
 * has sent, and it goes through the generated function the screens call and the generated contract
 * schema the app's tests check answers with.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The server: answers `body` to the one address asked for. */
function answer(address: string, body: unknown) {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input), "http://openbot.test");
    return url.pathname === address
      ? Response.json(body)
      : Response.json({ detail: "Not found." }, { status: 404 });
  }) as unknown as typeof fetch;
}

/** `body` with `value` at `path`, and a field no release has sent beside it and at the top. */
function newer<T>(body: T, path: (string | number)[], value: string): T {
  const copy = structuredClone(body) as Record<string | number, unknown>;
  let at: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1))
    at = at[key] as Record<string | number, unknown>;
  at[path.at(-1) as string | number] = value;
  at.addedLater = { by: "a newer server" };
  copy.alsoAddedLater = true;
  return copy as T;
}

const ORG = "/api/v2/organizations/default";

const cases = [
  {
    name: "a task's status",
    address: `${ORG}/tasks/t_1`,
    body: newer(getGetTaskResponseMock(), ["task", "status"], "parked"),
    read: () => getTask("default", "t_1"),
    contract: GetTaskResponse,
    value: (answer: unknown) =>
      (answer as { task: { status: string } }).task.status,
  },
  {
    name: "a person's role",
    address: `${ORG}/people/me`,
    body: newer(getGetPersonResponseMock(), ["person", "role"], "auditor"),
    read: () => getPerson("default", "me"),
    contract: GetPersonResponse,
    value: (answer: unknown) =>
      (answer as { person: { role: string } }).person.role,
  },
  {
    name: "a network policy's scope",
    address: `${ORG}/network-policies`,
    body: newer(
      getListNetworkPoliciesResponseMock(),
      ["networkPolicies", 0, "scopeKind"],
      "project",
    ),
    read: () => listNetworkPolicies("default"),
    contract: ListNetworkPoliciesResponse,
    value: (answer: unknown) =>
      (answer as { networkPolicies: { scopeKind: string }[] })
        .networkPolicies[0]?.scopeKind,
  },
  {
    name: "a routine run's status",
    address: `${ORG}/routines/r_1/runs`,
    body: newer(
      getListRoutineRunsResponseMock(),
      ["runs", 0, "status"],
      "cancelled",
    ),
    read: () => listRoutineRuns("default", "r_1"),
    contract: ListRoutineRunsResponse,
    value: (answer: unknown) =>
      (answer as { runs: { status: string }[] }).runs[0]?.status,
  },
];

describe.each(cases)(
  "$name, from a newer server",
  ({ address, body, read, contract, value }) => {
    test("the generated function reads it, the new value and fields as sent", async () => {
      answer(address, body);
      const read_: unknown = await read();
      expect(value(read_)).toBe(value(body));
      expect((read_ as Record<string, unknown>).alsoAddedLater).toBe(true);
    });

    test("the generated contract takes it, and drops only the fields it doesn't name", () => {
      const parsed = contract.safeParse(body);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(value(parsed.data)).toBe(value(body));
    });
  },
);
