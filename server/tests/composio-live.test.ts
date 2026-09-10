import { describe, expect, test } from "bun:test";
import {
  Composio,
  ComposioError,
  ComposioToolVersionRequiredError,
  type ToolExecuteResponse,
} from "@composio/core";
import { effectOf, vendorSentence } from "../src/plugins/composio";

/**
 * One real call to Composio, so the shapes this transport is written against are the shapes it gets.
 *
 * WHY THIS EXISTS AT ALL, when everything else here runs against a stub. Three separate assumptions in
 * an earlier draft were wrong — a call needs a specific version, failures throw rather than resolving
 * with an error field, and the useful sentence is nested two levels inside the cause — and every one of
 * them passed the whole stubbed suite. A stub asserts what its author believed. This asserts what the
 * vendor does.
 *
 * WRITTEN AGAINST THE VENDOR'S TYPES, WITH NO `as never`. `server/tsconfig.json` does not include
 * `tests`, so nothing in the build type-checks this file — which means a cast here erases the only
 * place in the repo where the real SDK surface is named, and erasing it defeats the one job the file
 * has. Every call below is typed by `@composio/core` itself. Where a value has to be narrowed, it is
 * narrowed by a runtime check that says what was missing, not by a cast that asserts it was there.
 *
 * SKIPPED WITHOUT A KEY, so CI and a contributor with no Composio account are unaffected. Run it
 * deliberately: `OPENBOT_LIVE_COMPOSIO=1 COMPOSIO_API_KEY=... bun test tests/composio-live.test.ts`.
 *
 * IT READS AND IT FAILS ON PURPOSE. Every action it calls is a read; the user id it calls for is one
 * nobody has connected, and the one action it calls that is allowed to reach a third party is a
 * no-auth public lookup of a record that does not exist. So the calls cannot touch anybody's data —
 * the failure is the assertion.
 */
const key = process.env.COMPOSIO_API_KEY?.trim();
const live = process.env.OPENBOT_LIVE_COMPOSIO === "1" && Boolean(key);

/** A user id nobody has connected, so no call below can reach an account that belongs to somebody. */
const NOBODY = "openbot-live-test-nobody";

/**
 * The vendor's own no-auth example action, and a record it cannot find.
 *
 * `@composio/core` 0.18.1 uses `HACKERNEWS_GET_USER` in three of its own `tools.execute` doc examples
 * with no connected account in sight, which is why it is the action picked to provoke a failure the
 * vendor reports rather than throws. The test below re-checks the vendor's `isNoAuth` label before it
 * calls, so a toolkit that stops being no-auth says so instead of quietly asking for a connection.
 */
const NO_AUTH_ACTION = "HACKERNEWS_GET_USER";
const NO_SUCH_RECORD = "openbot-live-test-no-such-hacker-news-user";

describe.skipIf(!live)("Composio, for real", () => {
  // Constructed inside each test rather than here, because Bun evaluates the body of a skipped
  // describe: the constructor throws without a key, which would make this file fail rather than skip.
  const client = () =>
    new Composio({
      apiKey: key,
      // Their default telemetry installs its own interrupt handlers, and this is a self-hosted product
      // whose operator never opted into a third party's analytics.
      allowTracking: false,
      disableVersionCheck: true,
      // Pinned so the result is the same on every machine. `getToolkitVersionsFromEnv` folds any
      // exported `COMPOSIO_TOOLKIT_VERSION_<SLUG>` into this config, and a version test whose answer
      // depends on the operator's shell reports the operator's environment as a vendor change.
      // Config wins over the environment, so naming the toolkits this file touches settles it.
      toolkitVersions: { gmail: "latest", hackernews: "latest" },
    });

  test("a listing carries a version and a behaviour label for every action", async () => {
    const composio = client();
    const actions = await composio.tools.getRawComposioTools({
      toolkits: ["gmail"],
      // Explicit, because their default page is 20 and Gmail has 63.
      limit: 500,
    });

    expect(actions.length).toBeGreaterThan(50);
    expect(actions.every((action) => Boolean(action.version))).toBe(true);

    // The classifier's fail-closed branch should be a guard against the future, not the present. If
    // this ever fails, unlabelled actions have started arriving and the branch is now load-bearing.
    const unlabelled = actions.filter(
      (action) =>
        !(action.tags ?? []).some(
          (tag) => tag === "readOnlyHint" || tag === "destructiveHint",
        ),
    );
    expect(unlabelled).toEqual([]);

    const reads = actions.filter(
      (action) => effectOf(action.tags).effect === "read",
    );
    expect(reads.length).toBeGreaterThan(10);
  });

  test("calling for somebody with no connection fails with a sentence naming that", async () => {
    const composio = client();
    const [action] = await composio.tools.getRawComposioTools({
      toolkits: ["gmail"],
      limit: 1,
    });
    // Stated rather than destructured into a crash. A vendor that lists nothing has not disagreed
    // with the assertion below, it has left the assertion unmade, and the two want opposite reactions.
    if (!action) {
      throw new Error(
        "Precondition not met: Composio listed no Gmail action, so there was nothing to call. Nothing below was exercised.",
      );
    }
    // `Tool.version` is optional in `ToolSchema`, so the concrete version this call needs is a
    // precondition and not something to assert into existence with a cast.
    const version = action.version;
    if (!version) {
      throw new Error(
        `Precondition not met: Composio listed ${action.slug} with no version, so no versioned call could be made. Nothing below was exercised.`,
      );
    }

    let thrown: unknown;
    try {
      await composio.tools.execute(action.slug, {
        userId: NOBODY,
        arguments: {},
        version,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    // The whole point: the transport's error path depends on this shape, and the top-level message
    // ("Error executing the tool X") names nothing anybody could act on.
    expect(vendorSentence(thrown)).toMatch(/no connected account/i);
  });

  /**
   * NOT A CHECK ON COMPOSIO, and named that way now because it used to be named as though it were.
   *
   * `executeComposioTool` throws `ComposioToolVersionRequiredError` on the statement directly above
   * its own `try` — `@composio/core` 0.18.1, `dist/index.mjs:1728` — before the request body is built
   * and before anything is sent. So no answer from Composio is involved and none can drift; what this
   * watches is the SDK's local guard.
   *
   * Kept rather than deleted, because that guard is the reason the transport carries a version column
   * at all. If the SDK ever stops refusing, `latest` becomes reachable and the column, and the refusal
   * this transport inherits from it, are both worth revisiting.
   */
  test("the SDK refuses locally, before dialling, when a version resolves to 'latest'", async () => {
    const composio = client();
    const [action] = await composio.tools.getRawComposioTools({
      toolkits: ["gmail"],
      limit: 1,
    });
    if (!action) {
      throw new Error(
        "Precondition not met: Composio listed no Gmail action, so there was nothing to call. Nothing below was exercised.",
      );
    }

    // Both spellings of "no concrete version": omitted, which the SDK resolves through the config to
    // `latest`, and `latest` asked for by name. `body.version ?? getToolkitVersion(...)` reads an
    // explicit `undefined` exactly as it reads an absent key, so passing it is the omitted case.
    for (const version of [undefined, "latest"] as const) {
      let thrown: unknown;
      try {
        await composio.tools.execute(action.slug, {
          userId: NOBODY,
          arguments: {},
          version,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ComposioToolVersionRequiredError);
      // Read off a narrowed instance rather than cast onto `unknown`: `ComposioError.code` is
      // declared `string | undefined`, and the `TS-SDK::` prefix is the SDK stamping its own errors.
      expect(thrown instanceof ComposioError ? thrown.code : null).toBe(
        "TS-SDK::TOOL_VERSION_REQUIRED",
      );
    }
  });

  /**
   * The one that mattered, and the one that was missing.
   *
   * A 200 carrying `successful: false` came back from this transport as `isError: false`, was audited
   * as `mcp.call_succeeded`, and was handed to the model as though the failure were content. The fix
   * reads the field; nothing here checked that the real API still sends it, so the exact drift the fix
   * was about was unguarded against the vendor.
   *
   * `ToolExecuteResponseSchema` makes `successful` required and `transformToolExecuteResponse` parses
   * every answer through it, so an SDK resolution is guaranteed to carry the field. What only a live
   * call can show is the other half: that the vendor reports a failure by RESOLVING with that field
   * set to false, and not only by throwing. If this ever throws instead, `reportedFailure` in the
   * transport has become dead code and the throw path is carrying the whole load.
   */
  test("a failure the vendor reports arrives as a resolution, not only as a throw", async () => {
    const composio = client();
    const [action] = await composio.tools.getRawComposioTools({
      tools: [NO_AUTH_ACTION],
    });
    if (!action) {
      throw new Error(
        `Precondition not met: Composio does not list ${NO_AUTH_ACTION}, so no unauthenticated call could be made. Nothing below was exercised.`,
      );
    }
    if (action.isNoAuth !== true) {
      throw new Error(
        `Precondition not met: Composio no longer marks ${NO_AUTH_ACTION} as no-auth, so calling it would need somebody's connected account. Pick another no-auth action rather than connecting one.`,
      );
    }
    const version = action.version;
    if (!version) {
      throw new Error(
        `Precondition not met: Composio listed ${action.slug} with no version, so no versioned call could be made. Nothing below was exercised.`,
      );
    }

    let thrown: unknown;
    let answer: ToolExecuteResponse | undefined;
    try {
      answer = await composio.tools.execute(action.slug, {
        userId: NOBODY,
        // A public lookup of a record that does not exist: the request reaches the vendor, and the
        // vendor has nothing of anybody's to return.
        arguments: { userId: NO_SUCH_RECORD },
        version,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(answer?.successful).toBe(false);
    // `ComposioResult` in the transport spells `error` as `string | null`, and a reported failure that
    // says nothing is what `unexplained()` exists for — so null is legal here and a third type is drift.
    expect(answer?.error === null || typeof answer?.error === "string").toBe(
      true,
    );
  });
});
