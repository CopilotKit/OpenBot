import { expect, test } from "bun:test";
import {
  createOrganizationAddress,
  createOrganizationChoice,
  IN_NO_ORGANIZATION,
  ORGANIZATION,
} from "../mobile/src/organization";

// The phone addresses the organization its person is working in (mobile/src/organization.ts).

test("a request under an organization goes to the one the person is working in, read once", async () => {
  let asked = 0;
  const addressed = createOrganizationAddress(async () => {
    asked += 1;
    return [{ id: "org_first" }, { id: "org second", active: true }];
  });

  expect(await addressed(`${ORGANIZATION}/routines?limit=100`, "ada")).toBe(
    "/api/v2/organizations/org%20second/routines?limit=100",
  );
  expect(await addressed(`${ORGANIZATION}/check-in-items`, "ada")).toBe(
    "/api/v2/organizations/org%20second/check-in-items",
  );
  expect(asked).toBe(1);

  // An address that names no organization is left alone, and asks nothing.
  expect(await addressed("/api/agents", "ada")).toBe("/api/agents");
  expect(asked).toBe(1);
});

test("somebody else signing in is asked about again, and works where they do", async () => {
  const lists: Record<string, { id: string; active?: boolean }[]> = {
    ada: [{ id: "org_a", active: true }],
    // Working in none of theirs: the one they joined first.
    ben: [{ id: "org_b" }, { id: "org_c" }],
  };
  let who = "ada";
  const addressed = createOrganizationAddress(async () => lists[who] ?? []);

  expect(await addressed(`${ORGANIZATION}/routines`, "ada")).toBe(
    "/api/v2/organizations/org_a/routines",
  );
  who = "ben";
  expect(await addressed(`${ORGANIZATION}/routines`, "ben")).toBe(
    "/api/v2/organizations/org_b/routines",
  );
});

test("a read that fails is asked again, and somebody in no organization is told so", async () => {
  let fail = true;
  const addressed = createOrganizationAddress(async () => {
    if (fail) throw new Error("offline");
    return [];
  });

  await expect(addressed(`${ORGANIZATION}/routines`, "ada")).rejects.toThrow(
    "offline",
  );
  fail = false;
  await expect(addressed(`${ORGANIZATION}/routines`, "ada")).rejects.toThrow(
    IN_NO_ORGANIZATION,
  );
});

test("a pick kept on the phone is used while it is one of the person's, and set aside once it is not", async () => {
  let kept: string | null = "org_gone";
  const store = {
    read: async () => kept,
    write: async (id: string) => {
      kept = id;
    },
  };
  let list = [{ id: "org_a", active: true }, { id: "org_b" }];
  const choice = createOrganizationChoice(async () => list, store);
  // Left, deleted, or somebody else's: the server's active one.
  expect(await choice.current("ada")).toBe("org_a");
  await choice.choose("org_b", "ada");
  expect(kept).toBe("org_b");
  expect(await choice.address(`${ORGANIZATION}/bots`, "ada")).toBe(
    "/api/v2/organizations/org_b/bots",
  );
  // The next sign-in reads the list again; the pick is still one of theirs.
  expect(await choice.current("ada-again")).toBe("org_b");
  // Gone from their list: not addressed again.
  list = [{ id: "org_a", active: true }];
  expect(await choice.current("ada-third")).toBe("org_a");
});
