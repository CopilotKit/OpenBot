import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeControl } from "./control";
import { stateAnswer } from "./states";

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
    "trustedrouter",
    "privatemode",
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

test("#first-run waits on the sign-in until the person opens the approval page", async () => {
  const answer = stateAnswer({ hash: "#first-run", search: "" });
  let settled: unknown = "waiting";
  void Promise.resolve(answer("sign_in_to_copilotkit", { attempt: "a" })).then(
    (value) => {
      settled = value;
    },
  );
  const page = answer("copilotkit_sign_in_page", { attempt: "a" }) as {
    url: string;
    userCode: string;
  };
  expect(page.userCode).toBe("WXYZ-2345");
  await new Promise((done) => setTimeout(done, 20));
  expect(settled).toBe("waiting");
  answer("plugin:opener|open_url", { url: page.url });
  await new Promise((done) => setTimeout(done, 1500));
  expect(settled).toEqual({ signedIn: true });
  expect(answer("copilotkit_sign_in_page", { attempt: "b" })).toBeNull();
});

test("#first-run asks for the terms until setup is given the version accepted", async () => {
  const answer = stateAnswer({ hash: "#first-run", search: "" });
  const terms = answer("local_eval_terms", { attempt: "t" }) as {
    status: string;
    accepted: boolean;
    version: string;
  };
  expect(terms).toMatchObject({ status: "required", accepted: false });
  const report = answer("set_up_local_eval", {
    attempt: "s",
    root: "/Users/you/OpenBot",
    acceptedEulaVersion: terms.version,
  });
  expect(answer("local_eval_terms", { attempt: "t2" })).toMatchObject({
    accepted: true,
  });
  expect(await report).toMatchObject({
    outcome: "completed",
    licence: "valid",
  });
}, 15_000);
