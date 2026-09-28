import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  BROWSER_ID_HEADER,
  BROWSER_ID_QUERY,
} from "../../shared/browser-identity";
import {
  actorForBrowserId,
  createDevRequireUser,
  DEV_ACTOR,
  singleUserActorFromRequest,
  singleUserEnabled,
} from "../src/auth/dev-actor";

/**
 * Whether this deployment lets every visitor in as one administrator.
 *
 * The most dangerous boolean in the codebase and it had no test. It used to be locked with
 * `NODE_ENV === "production"`, which is exactly the wrong way round: `NODE_ENV` is unset unless
 * somebody sets it, so a container on a VM with a hand-written env file and no identity provider
 * served the whole internet as an administrator, silently, because nothing was wrong from the
 * outside. It now takes an explicit flag and refuses to start without one.
 *
 * The cases below are the four a deployment can actually be in.
 */
describe("running with no sign-in", () => {
  test("a configured provider always wins, whatever else is set", () => {
    // A provider means sign-in, so the flag cannot half-disable it. Asserted with the flag on,
    // because the dangerous reading is "the flag opens a deployment that has a provider".
    expect(singleUserEnabled({ OPENBOT_SINGLE_USER: "true" }, true)).toBe(
      false,
    );
    expect(singleUserEnabled({}, true)).toBe(false);
  });

  test("no provider and the flag set runs open, because somebody said so", () => {
    expect(singleUserEnabled({ OPENBOT_SINGLE_USER: "true" }, false)).toBe(
      true,
    );
  });

  test("the older name for the flag still works, so an existing .env keeps running", () => {
    expect(singleUserEnabled({ OPENBOT_DEV_NO_AUTH: "true" }, false)).toBe(
      true,
    );
  });

  test("no provider and no flag refuses to start", () => {
    // The whole point. Not a warning, not a default: a deployment that would admit everybody as an
    // administrator does not come up, and says what to configure.
    expect(() => singleUserEnabled({}, false)).toThrow(
      /No identity provider is configured/,
    );
  });

  test("NODE_ENV decides nothing, in either direction", () => {
    // The previous lock. A server with NODE_ENV unset was the case it had to catch and the case it
    // let through, so neither value may change the answer now.
    expect(() =>
      singleUserEnabled({ NODE_ENV: "development" }, false),
    ).toThrow();
    expect(() =>
      singleUserEnabled({ NODE_ENV: "production" }, false),
    ).toThrow();
    expect(
      singleUserEnabled(
        { NODE_ENV: "production", OPENBOT_SINGLE_USER: "true" },
        false,
      ),
    ).toBe(true);
  });

  test("a flag set to anything but true is not a yes", () => {
    // Read exactly, so `OPENBOT_SINGLE_USER=false` and a stray `1` both refuse rather than opening.
    for (const value of ["false", "1", "yes", "TRUE", ""]) {
      expect(() =>
        singleUserEnabled({ OPENBOT_SINGLE_USER: value }, false),
      ).toThrow();
    }
  });
});

const BROWSER_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BROWSER_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

describe("who a no-sign-in request is", () => {
  test("a request with no browser id is the shared administrator", () => {
    expect(
      singleUserActorFromRequest(new Request("http://openbot.test/")),
    ).toEqual(DEV_ACTOR);
  });

  test("a remembered browser is its own person, so two laptops do not share a roster", () => {
    const left = singleUserActorFromRequest(
      new Request("http://openbot.test/", {
        headers: { [BROWSER_ID_HEADER]: BROWSER_A },
      }),
    );
    const right = singleUserActorFromRequest(
      new Request("http://openbot.test/", {
        headers: { [BROWSER_ID_HEADER]: BROWSER_B },
      }),
    );
    expect(left.id).not.toBe(right.id);
    expect(left.id).toBe(actorForBrowserId(BROWSER_A).id);
    expect(right.id).toBe(actorForBrowserId(BROWSER_B).id);
  });

  test("a WebSocket identifies itself on the query, because it cannot set headers", () => {
    const actor = singleUserActorFromRequest(
      new Request(
        `http://openbot.test/api/channels/events?${BROWSER_ID_QUERY}=${BROWSER_A}`,
      ),
    );
    expect(actor.id).toBe(actorForBrowserId(BROWSER_A).id);
  });
});

describe("the no-sign-in guard", () => {
  function app() {
    const routes = new Hono();
    routes.use("*", createDevRequireUser());
    routes.get("/", (context) => context.json(context.var.actor));
    return routes;
  }

  test("admits a visitor with no header as the shared administrator", async () => {
    const response = await app().request("/");
    expect(await response.json()).toEqual(DEV_ACTOR);
  });

  test("admits each browser as itself", async () => {
    const response = await app().request("/", {
      headers: { [BROWSER_ID_HEADER]: BROWSER_A },
    });
    expect(await response.json()).toMatchObject({
      id: actorForBrowserId(BROWSER_A).id,
      role: "admin",
    });
  });
});
