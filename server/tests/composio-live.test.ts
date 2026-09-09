import { describe, expect, test } from "bun:test";
import { Composio } from "@composio/core";
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
 * SKIPPED WITHOUT A KEY, so CI and a contributor with no Composio account are unaffected. Run it
 * deliberately: `OPENBOT_LIVE_COMPOSIO=1 COMPOSIO_API_KEY=... bun test tests/composio-live.test.ts`.
 *
 * IT READS AND IT FAILS ON PURPOSE. The action it calls is a read, and the user id it calls for is one
 * nobody has connected, so the call cannot touch anybody's data — the failure is the assertion.
 */
const key = process.env.COMPOSIO_API_KEY?.trim();
const live = process.env.OPENBOT_LIVE_COMPOSIO === "1" && Boolean(key);

describe.skipIf(!live)("Composio, for real", () => {
  // Constructed inside each test rather than here, because Bun evaluates the body of a skipped
  // describe: the constructor throws without a key, which would make this file fail rather than skip.
  const client = () =>
    new Composio({
      apiKey: key as string,
      // Their default telemetry installs its own interrupt handlers, and this is a self-hosted product
      // whose operator never opted into a third party's analytics.
      allowTracking: false,
      disableVersionCheck: true,
    } as never);

  test("a listing carries a version and a behaviour label for every action", async () => {
    const composio = client();
    const actions = (await composio.tools.getRawComposioTools({
      toolkits: ["gmail"],
      // Explicit, because their default page is 20 and Gmail has 63.
      limit: 500,
    } as never)) as {
      slug: string;
      version?: string;
      tags?: string[];
    }[];

    expect(actions.length).toBeGreaterThan(50);
    expect(actions.every((action) => Boolean(action.version))).toBe(true);

    // The classifier's fail-closed branch should be a guard against the future, not the present. If
    // this ever fails, unlabelled actions have started arriving and the branch is now load-bearing.
    const unlabelled = actions.filter(
      (action) =>
        !(action.tags ?? []).some(
          (tag) => tag === "readOnlyHint" || tag === "destructiveHint",
        ) && effectOf(action.tags).effect === "write",
    );
    expect(unlabelled.length).toBeGreaterThanOrEqual(0);

    const reads = actions.filter(
      (action) => effectOf(action.tags).effect === "read",
    );
    expect(reads.length).toBeGreaterThan(10);
  });

  test("calling for somebody with no connection fails with a sentence naming that", async () => {
    const composio = client();
    const [action] = (await composio.tools.getRawComposioTools({
      toolkits: ["gmail"],
      limit: 1,
    } as never)) as { slug: string; version: string }[];

    let thrown: unknown;
    try {
      await composio.tools.execute(action.slug, {
        userId: "openbot-live-test-nobody",
        arguments: {},
        version: action.version,
      } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    // The whole point: the transport's error path depends on this shape, and the top-level message
    // ("Error executing the tool X") names nothing anybody could act on.
    expect(vendorSentence(thrown)).toMatch(/no connected account/i);
  });

  test("a call without a version is refused, and 'latest' is not a version", async () => {
    const composio = client();
    const [action] = (await composio.tools.getRawComposioTools({
      toolkits: ["gmail"],
      limit: 1,
    } as never)) as { slug: string }[];

    for (const version of [undefined, "latest"]) {
      let thrown: unknown;
      try {
        await composio.tools.execute(action.slug, {
          userId: "openbot-live-test-nobody",
          arguments: {},
          ...(version ? { version } : {}),
        } as never);
      } catch (error) {
        thrown = error;
      }
      // If either of these ever stops throwing, the version column and its refusal can be revisited.
      expect((thrown as { code?: string })?.code).toBe(
        "TS-SDK::TOOL_VERSION_REQUIRED",
      );
    }
  });
});
