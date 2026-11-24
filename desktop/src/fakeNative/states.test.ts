import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeControl } from "./control";
import { STATE_NAMES, stateAnswer } from "./states";

beforeEach(() => nativeControl().reset());

const firstRun = { hash: "", search: "" };

test("providers lists the seven providers in order", () => {
  const providers = stateAnswer(firstRun)("providers", undefined) as {
    id: string;
  }[];
  expect(providers.map((provider) => provider.id)).toEqual([
    "openai",
    "anthropic",
    "google",
    "xai",
    "unbiased",
    "trustedrouter",
    "openai-compatible",
  ]);
});

test("already_configured is installed at #start and has no local eval on a first run", () => {
  const relaunch = stateAnswer({ hash: "#start", search: "" })(
    "already_configured",
    undefined,
  ) as { localEval?: { phase: string } };
  expect(relaunch.localEval?.phase).toBe("installed");
  const first = stateAnswer(firstRun)("already_configured", undefined) as {
    localEval?: unknown;
  };
  expect(first.localEval).toBeUndefined();
});

test("show_openbot at #local-app-too-old-security throws the security problem", () => {
  const answer = stateAnswer({
    hash: "#local-app-too-old-security",
    search: "",
  });
  let thrown: unknown;
  try {
    answer("show_openbot", undefined);
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { kind?: string }).kind).toBe("app-too-old-security");
});

test("move_to_cloud at #move-failed says the native upload failure", () => {
  // The fake stops in the upload stage, so it must say what `Failure::said` says for Upload.
  const rust = readFileSync(
    join(import.meta.dir, "../../src-tauri/src/move_to_cloud.rs"),
    "utf8",
  );
  const native = /stage: Stage::Upload,[^}]*\}\s*=>\s*"([^"]+)"/.exec(
    rust,
  )?.[1];
  expect(native).toBeDefined();
  let thrown: unknown;
  try {
    stateAnswer({ hash: "#move-failed", search: "" })(
      "move_to_cloud",
      undefined,
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toEqual({ said: native, kind: "move-failed" });
});

test("local_eval_terms at #licence is not accepted yet", () => {
  const terms = stateAnswer({ hash: "#licence", search: "" })(
    "local_eval_terms",
    undefined,
  ) as { accepted: boolean };
  expect(terms.accepted).toBe(false);
});

test("STATE_NAMES holds every state once", () => {
  const hashes = new Set(STATE_NAMES.map((state) => state.hash));
  for (const hash of [
    "",
    "#update-short",
    "#backend-short",
    "#connect-app-too-old",
    "#connect-app-too-old-security",
    "#connect-session-ended",
    "#local-app-too-old",
    "#local-app-too-old-security",
    "#local-launcher-ahead",
    "#local-app-too-old-running",
    "#local-running-fails",
    "#move-choice",
    "#move-confirm",
    "#move-confirm-loading",
    "#move-confirm-many",
    "#move-signin",
    "#move-midway",
    "#move-failed",
    "#move-stopped",
    "#move-done",
    "#move-done-held",
    "#move-done-left",
    "#move-done-ai",
    "#move-first",
    "#signin",
    "#licence",
    "#licence-installing",
    "#licence-slow",
    "#pause-podman",
    "#connect-fails",
    "#start",
    "#status",
  ])
    expect(hashes).toContain(hash);
  const searches = new Set(STATE_NAMES.map((state) => state.search));
  for (const search of [
    "?offer",
    "?internal",
    "?stopped",
    "?updating",
    "?started",
  ])
    expect(searches).toContain(search);
  const keys = STATE_NAMES.map((state) => `${state.search}${state.hash}`);
  expect(new Set(keys).size).toBe(keys.length);
});

test("move-first measures the installation again after its update", () => {
  const answer = stateAnswer({ hash: "#move-first", search: "" });
  expect(answer("move_offer", undefined)).toMatchObject({
    footprintBytes: 23_100_000_000,
  });
  expect(answer("move_preview", undefined)).toMatchObject({
    footprintBytes: 26_600_000_000,
  });
});

test("a completed move includes the signed-in Cloud account", () => {
  const answer = stateAnswer({ hash: "#move-done", search: "" });
  expect(answer("move_to_cloud", undefined)).toMatchObject({
    account: {
      email: "sam.longname-for-wrapping@example.com",
      organization: "Sam's organization",
    },
  });
});
