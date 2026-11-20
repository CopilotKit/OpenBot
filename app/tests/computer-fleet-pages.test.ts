import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  computerFleetQueryOptions,
  computerStatusQueryOptions,
} from "../src/lib/computers/queries";

/**
 * The organization's computers and one Bot's computer's state, read from the API.
 *
 * The API pages the list and the Computers screen shows all of it, so every page has to be read: a
 * screen that stopped at the first would show an organization with a hundred computers and no sign
 * that there were more. The fake answers only the API's addresses, so a read sent anywhere else is
 * not found and fails here.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const LIST = "/api/v2/organizations/default/computers";
const one = (id: string) => ({
  id,
  computer: id,
  kind: "person" as const,
  personId: id.slice("person:".length),
  running: true,
  startedAt: null,
});

test("the list is read to its end, in the order the pages came", async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    const address = new URL(String(url), "http://openbot.test");
    asked.push(`${address.pathname}${address.search}`);
    if (address.pathname !== LIST)
      return Response.json({ error: "Not found." }, { status: 404 });
    return address.searchParams.get("cursor") === "bmV4dA"
      ? Response.json({
          computers: [one("person:c")],
          isolation: "per-person",
          nextCursor: null,
        })
      : Response.json({
          computers: [one("person:a"), one("person:b")],
          isolation: "per-person",
          nextCursor: "bmV4dA",
        });
  }) as unknown as typeof fetch;

  const fleet = await new QueryClient().fetchQuery(computerFleetQueryOptions());

  expect(fleet.isolation).toBe("per-person");
  expect(fleet.computers.map((computer) => computer.computer)).toEqual([
    "person:a",
    "person:b",
    "person:c",
  ]);
  expect(asked).toEqual([
    `${LIST}?limit=100`,
    `${LIST}?limit=100&cursor=bmV4dA`,
  ]);
});

test("a Bot's computer's state is read at the computer's own address", async () => {
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) =>
    String(url) === `${LIST}/bot-1`
      ? Response.json({ botId: "bot-1", state: "absent" })
      : Response.json(
          { error: "Not found." },
          { status: 404 },
        )) as unknown as typeof fetch;

  expect(
    await new QueryClient().fetchQuery(computerStatusQueryOptions("bot-1")),
  ).toEqual({ botId: "bot-1", state: "absent" });
});
