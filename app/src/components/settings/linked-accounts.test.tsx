import { expect, test } from "bun:test";
import { IconBrandGithub, IconBrandSlack, IconLink } from "@tabler/icons-react";
import { unlinkOutcome } from "@/lib/identity/mutations";
import { linksFromResponse } from "@/lib/identity/queries";
import {
  linkedAccountDescription,
  linkedAccountsSectionState,
  providerIcon,
} from "./linked-accounts";

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

test("the not-configured 503 means the feature is absent, so no links", async () => {
  const response = Response.json(
    {
      error: "Linked accounts are not available.",
      code: "identity_unavailable",
    },
    { status: 503 },
  );
  expect(await linksFromResponse(response)).toEqual([]);
});

test("any other 503 is an outage and throws its message", async () => {
  const response = Response.json(
    { error: "Service Unavailable" },
    { status: 503 },
  );
  await expect(linksFromResponse(response)).rejects.toThrow(
    "Service Unavailable",
  );
});

test("a 503 with no JSON body throws the fallback", async () => {
  const response = new Response("upstream down", { status: 503 });
  await expect(linksFromResponse(response)).rejects.toThrow(
    "Could not load your linked accounts",
  );
});

test("other failures still throw the server message", async () => {
  const response = Response.json({ error: "boom" }, { status: 500 });
  await expect(linksFromResponse(response)).rejects.toThrow("boom");
});

test("a success unwraps the links", async () => {
  const links = [{ ...base, handle: "dana", status: "active" as const }];
  expect(await linksFromResponse(Response.json({ links }))).toEqual(links);
});

test("a 200 whose body has no links array throws the fallback", async () => {
  await expect(
    linksFromResponse(Response.json({ accounts: [] })),
  ).rejects.toThrow("Could not load your linked accounts");
  await expect(
    linksFromResponse(new Response("<!doctype html>", { status: 200 })),
  ).rejects.toThrow("Could not load your linked accounts");
});

const row = { ...base, handle: "dana", status: "active" as const };

test("the section hides while loading and when nothing is linked", () => {
  expect(linkedAccountsSectionState({ data: undefined, error: null })).toBe(
    null,
  );
  expect(linkedAccountsSectionState({ data: [], error: null })).toBe(null);
});

test("rows show on their own when the list loaded", () => {
  expect(linkedAccountsSectionState({ data: [row], error: null })).toEqual({
    rows: [row],
    error: null,
  });
});

test("a failed refetch keeps stale rows on screen and shows the error with them", () => {
  expect(
    linkedAccountsSectionState({ data: [row], error: new Error("boom") }),
  ).toEqual({ rows: [row], error: "boom" });
});

test("an error with no data, or with an empty cached list, still shows", () => {
  for (const data of [undefined, []]) {
    expect(
      linkedAccountsSectionState({ data, error: new Error("boom") }),
    ).toEqual({ rows: [], error: "boom" });
  }
});

test("a 204 disconnect succeeds", async () => {
  await expect(
    unlinkOutcome(new Response(null, { status: 204 })),
  ).resolves.toBeUndefined();
});

test("the server's own 404 means the link is already gone, which is success", async () => {
  await expect(
    unlinkOutcome(
      Response.json(
        { error: "Linked account not found.", code: "identity_link_not_found" },
        { status: 404 },
      ),
    ),
  ).resolves.toBeUndefined();
});

test("a 404 without the server's code is a failed disconnect", async () => {
  await expect(
    unlinkOutcome(Response.json({ error: "Not Found" }, { status: 404 })),
  ).rejects.toThrow("Not Found");
});

test("an HTML 404 from a proxy or SPA fallback throws the fallback", async () => {
  await expect(
    unlinkOutcome(
      new Response("<!doctype html><html></html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    ),
  ).rejects.toThrow("The account could not be disconnected");
});

test("any other disconnect failure throws the server message", async () => {
  await expect(
    unlinkOutcome(Response.json({ error: "boom" }, { status: 500 })),
  ).rejects.toThrow("boom");
});

test("a disconnect failure without a message throws the fallback", async () => {
  await expect(
    unlinkOutcome(new Response("nope", { status: 502 })),
  ).rejects.toThrow("The account could not be disconnected");
});
