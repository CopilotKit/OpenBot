import { afterEach, describe, expect, test } from "bun:test";
import Arcade from "@arcadeai/arcadejs";
import { createArcadeClient } from "../src/plugins/arcade-adapter";

/**
 * `provider_id` IS THE AUTH PROVIDER AND NOT THE TOOLKIT, which is the whole of what this file
 * exists to pin. One Google connection serves `Gmail` and `GoogleCalendar` both, and the live API
 * refuses with an operator-named `"provider_id": "cpk-poc"` — a provider CONFIGURATION, not a
 * toolkit. It coincides with the toolkit slug only when an operator names it that way, which
 * `Github`, `Asana` and `Attio` all happen to do and which is every toolkit in this tree's
 * fixtures. So the case that matters is constructed here rather than taken from the fixture: a
 * toolkit whose provider is named DIFFERENTLY from it.
 *
 * Same prototype-stubbing pattern as `arcade-adapter.test.ts`, so nothing dials.
 */
type Methods = Record<string, (...args: unknown[]) => unknown>;
const toolsProto = (): Methods =>
  Object.getPrototypeOf(
    new Arcade({ apiKey: "never-dialled" }).tools,
  ) as Methods;

const restores: (() => void)[] = [];
function stub(
  on: Methods,
  name: string,
  impl: (...args: unknown[]) => unknown,
) {
  const was = on[name];
  on[name] = impl;
  restores.push(() => {
    on[name] = was;
  });
}
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

/** One listed action carrying the provider its toolkit's connections are held under. */
const toolUnder = (toolkit: string, i: number, providerId: string | null) => ({
  qualified_name: `${toolkit}.A${i}`,
  toolkit: { name: toolkit },
  requirements: {
    authorization: {
      id: `arcade-${i}`,
      ...(providerId === null ? {} : { provider_id: providerId }),
      oauth2: { scopes: [] },
    },
  },
});

describe("Arcade authProviderOf", () => {
  test("answers the listing's provider for a toolkit named differently from it", async () => {
    const asked: unknown[] = [];
    stub(toolsProto(), "list", (query: unknown) => {
      asked.push(query);
      return Promise.resolve({
        items: [
          toolUnder("Gmail", 1, "google"),
          toolUnder("Gmail", 2, "google"),
        ],
      });
    });

    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.authProviderOf("Gmail")).toBe("google");
    // ONE page and no paging: every tool in a toolkit shares its auth provider.
    expect(asked).toHaveLength(1);
    expect((asked[0] as { toolkit?: string }).toolkit).toBe("Gmail");
  });

  test("carries the vendor's own case through untouched", async () => {
    stub(toolsProto(), "list", () =>
      Promise.resolve({ items: [toolUnder("Gmail", 1, "Google")] }),
    );

    expect(
      await createArcadeClient("never-dialled").broker.authProviderOf("Gmail"),
    ).toBe("Google");
  });

  test("answers null when the page names two distinct providers, never the first", async () => {
    stub(toolsProto(), "list", () =>
      Promise.resolve({
        items: [
          toolUnder("Mixed", 1, "google"),
          toolUnder("Mixed", 2, "slack"),
        ],
      }),
    );

    expect(
      await createArcadeClient("never-dialled").broker.authProviderOf("Mixed"),
    ).toBeNull();
  });

  test("answers null — NEVER the toolkit name — when the listing does not say", async () => {
    stub(toolsProto(), "list", () =>
      Promise.resolve({ items: [toolUnder("Gmail", 1, null)] }),
    );

    expect(
      await createArcadeClient("never-dialled").broker.authProviderOf("Gmail"),
    ).toBeNull();
  });

  /**
   * AN UNREADABLE AUTHORIZATION BESIDE A READABLE ONE IS UNANSWERED, NOT THE READABLE ONE'S ID.
   * The seam's caller (`store.ts`'s sibling resolver) counts `null` as unanswered and ends nothing
   * for it; answering `google` here would let it end rows on a listing it never read whole.
   */
  test("answers null when another action's authorization could not be read", async () => {
    stub(toolsProto(), "list", () =>
      Promise.resolve({
        items: [
          toolUnder("Gmail", 1, "google"),
          {
            qualified_name: "Gmail.A2",
            requirements: { authorization: "oauth2" },
          },
        ],
      }),
    );

    expect(
      await createArcadeClient("never-dialled").broker.authProviderOf("Gmail"),
    ).toBeNull();
  });

  test("still answers the provider when another action has NO authorization at all", async () => {
    stub(toolsProto(), "list", () =>
      Promise.resolve({
        items: [
          toolUnder("Gmail", 1, "google"),
          { qualified_name: "Gmail.A2", requirements: null },
        ],
      }),
    );

    expect(
      await createArcadeClient("never-dialled").broker.authProviderOf("Gmail"),
    ).toBe("google");
  });
});
