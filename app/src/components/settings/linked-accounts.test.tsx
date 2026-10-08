import { expect, test } from "bun:test";
import { IconBrandGithub, IconBrandSlack, IconLink } from "@tabler/icons-react";
import { linksFromResponse } from "@/lib/identity/queries";
import { linkedAccountDescription, providerIcon } from "./linked-accounts";

const base = {
  id: "1",
  provider: "github" as const,
  title: "GitHub",
  createdAt: "2026-10-08T00:00:00.000Z",
};

test("an active link shows its handle", () => {
  expect(
    linkedAccountDescription({ ...base, handle: "dana", status: "active" }),
  ).toBe("@dana");
});

test("a link without a handle says it is linked", () => {
  expect(
    linkedAccountDescription({ ...base, handle: null, status: "active" }),
  ).toBe("Linked");
});

test("a link needing reconnection says so first", () => {
  expect(
    linkedAccountDescription({
      ...base,
      handle: "dana",
      status: "needs_reconnect",
    }),
  ).toBe("Needs reconnecting · @dana");
});

test("a reconnect with no handle does not also say linked", () => {
  expect(
    linkedAccountDescription({
      ...base,
      handle: null,
      status: "needs_reconnect",
    }),
  ).toBe("Needs reconnecting");
});

test("providers map to their own icon with a neutral fallback", () => {
  expect(providerIcon("slack")).toBe(IconBrandSlack);
  expect(providerIcon("github")).toBe(IconBrandGithub);
  expect(providerIcon("gitlab")).toBe(IconLink);
});

test("a 503 means the feature is absent, so no links", async () => {
  const response = Response.json(
    { error: "Linked accounts are not available." },
    { status: 503 },
  );
  expect(await linksFromResponse(response)).toEqual([]);
});

test("other failures still throw the server message", async () => {
  const response = Response.json({ error: "boom" }, { status: 500 });
  await expect(linksFromResponse(response)).rejects.toThrow("boom");
});

test("a success unwraps the links", async () => {
  const links = [{ ...base, handle: "dana", status: "active" as const }];
  expect(await linksFromResponse(Response.json({ links }))).toEqual(links);
});
