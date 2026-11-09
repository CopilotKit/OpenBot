import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Call = { command: string; args?: Record<string, unknown> };

let invokeCalls: Call[] = [];
let invokeHandler: (call: Call) => Promise<unknown> = async () => null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => {
    const call = { command, args };
    invokeCalls.push(call);
    return invokeHandler(call);
  },
}));

const { CopilotKitAccount } = await import("./CopilotKitAccount");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  invokeCalls = [];
});
afterAll(() => GlobalRegistrator.unregister());

// As the CLI prints it for a sign-in waiting on the browser, with a synthetic code.
const PAGE = {
  url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345&source=cli&mode=openbot",
  userCode: "WXYZ-2345",
};

/**
 * A signed-out account whose sign-in waits on the browser until it is cancelled, as it did for an
 * account in several organizations that landed on the CopilotKit dashboard.
 */
function waitingSignIn() {
  let stop: ((reason: unknown) => void) | null = null;
  invokeHandler = async ({ command, args }) => {
    if (command === "local_eval_terms") return { status: "signed-out" };
    if (command === "sign_in_to_copilotkit")
      return new Promise((_, reject) => {
        stop = reject;
      });
    if (command === "copilotkit_sign_in_page")
      return args?.attempt === signInAttempt() ? PAGE : null;
    if (command === "cancel_local_eval") {
      if (args?.attempt === signInAttempt()) stop?.("cancelled");
      return null;
    }
    if (command === "plugin:opener|open_url") return null;
    throw new Error(`unexpected ${command}`);
  };
}

function signInAttempt() {
  return invokeCalls.find((call) => call.command === "sign_in_to_copilotkit")
    ?.args?.attempt;
}

async function startSigningIn() {
  const screen = render(
    <CopilotKitAccount root="/tmp/account-sign-in" onDone={() => {}} />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign in to CopilotKit" }),
  );
  return screen;
}

/** OpenBot's own engine check: a Docker with a full disk is caught here, before Start fails on it. */
test("an engine short of disk says how to raise it, and Try again checks again", async () => {
  invokeHandler = async ({ command }) => {
    if (command === "local_eval_terms")
      return {
        status: "engine-too-small",
        podman: false,
        cpu: false,
        memory: false,
        disk: true,
      };
    throw new Error(`unexpected ${command}`);
  };
  const screen = render(
    <CopilotKitAccount root="/tmp/account-engine" onDone={() => {}} />,
  );
  await screen.findByText(
    "Docker is out of disk space. OpenBot needs 40 GB free. Raise the disk limit in Docker Desktop > Settings > Resources, or free space in Docker, then Try again.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "local_eval_terms"),
    ).toHaveLength(2),
  );
});

/**
 * What `local_eval_terms` answers when the CLI's preflight refuses OrbStack on a Mac.
 * `local_eval.rs` normalizes the CLI's own envelope (`onboard-local-terms-orbstack.json`) and
 * checks its answer is this, so the window is tested against what the CLI really says.
 */
const orbStack = JSON.parse(
  readFileSync(
    new URL(
      "../src-tauri/test-fixtures/local-eval/local-eval-terms-orbstack.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

/**
 * 1.0.0 sat on "Checking your CopilotKit account…" for 15 minutes on a Mac with OrbStack, asking
 * every 2 seconds, then said only that it couldn't check the account. The refusal is said at once,
 * with what to do about it, and nothing is asked again until Try again.
 */
test("an engine local setup doesn't run on is said at once, with how to switch", async () => {
  invokeHandler = async ({ command }) => {
    if (command === "local_eval_terms") return orbStack;
    throw new Error(`unexpected ${command}`);
  };
  const screen = render(
    <CopilotKitAccount root="/tmp/account-orbstack" onDone={() => {}} />,
  );
  await screen.findByRole("heading", {
    name: "Switch to Docker Desktop or Podman",
  });
  expect(
    screen.getByText(
      "Docker Desktop or rootful Podman is required on macOS. This machine runs OrbStack.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("docker context use desktop-linux")).toBeTruthy();
  expect(
    screen.queryByText("Couldn’t check your CopilotKit account. Try again."),
  ).toBeNull();
  expect(screen.queryByText("Checking your CopilotKit account…")).toBeNull();

  // Not waited out: no second check comes by itself.
  await new Promise((settle) => setTimeout(settle, 2500));
  expect(
    invokeCalls.filter((call) => call.command === "local_eval_terms"),
  ).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "local_eval_terms"),
    ).toHaveLength(2),
  );
});

/** A refusal with no sentence of the CLI's own still says what is wrong, and is not waited out. */
test("a refused engine with no sentence from the CLI says so in OpenBot's words", async () => {
  invokeHandler = async ({ command }) => {
    if (command === "local_eval_terms")
      return { status: "blocked", reason: "unsupported-engine" };
    throw new Error(`unexpected ${command}`);
  };
  const screen = render(
    <CopilotKitAccount root="/tmp/account-refused" onDone={() => {}} />,
  );
  await screen.findByText(
    "OpenBot's back end can't run on the container engine this computer uses.",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("a sign-in waiting on the browser shows its code and a way back to the page", async () => {
  waitingSignIn();
  const screen = await startSigningIn();
  await screen.findByText("Finish signing in to CopilotKit in your browser…");
  expect((await screen.findByText(PAGE.userCode)).tagName).toBe("STRONG");
  expect(
    screen.getByText(
      "If your browser shows the CopilotKit dashboard after you choose an organization, open the sign-in page again.",
    ),
  ).toBeTruthy();
  const link = screen.getByRole("link", { name: "Open the sign-in page" });
  expect(link.getAttribute("href")).toBe(PAGE.url);

  // Opened in the default browser, through the opener, never inside the window.
  await userEvent.click(link);
  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "plugin:opener|open_url"),
    ).toEqual([{ command: "plugin:opener|open_url", args: { url: PAGE.url } }]),
  );
});

test("Cancel stops the CLI's sign-in and goes back to the start of the step", async () => {
  waitingSignIn();
  const screen = await startSigningIn();
  await screen.findByText(PAGE.userCode);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(
    invokeCalls.filter((call) => call.command === "cancel_local_eval"),
  ).toEqual([
    { command: "cancel_local_eval", args: { attempt: signInAttempt() } },
  ]);
  expect(
    await screen.findByRole("button", { name: "Sign in to CopilotKit" }),
  ).toBeTruthy();
  expect(screen.queryByText(PAGE.userCode)).toBeNull();
  // The stopped sign-in is not reported as a failure.
  await new Promise((settle) => setTimeout(settle, 50));
  expect(screen.queryByText("Sign-in didn’t finish. Try again.")).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Open the sign-in page" }),
  ).toBeNull();
});

/** CopilotKit's logotype, light, with the reversed wordmark for a dark window. */
function expectCopilotKitLogo(screen: ReturnType<typeof render>) {
  const logo = screen.getByRole("img", { name: "CopilotKit" });
  expect(logo.getAttribute("src")).toBe("/copilotkit-logo.svg");
  expect(
    logo
      .closest("picture")
      ?.querySelector('source[media="(prefers-color-scheme: dark)"]')
      ?.getAttribute("srcset"),
  ).toBe("/copilotkit-logo-dark.svg");
}

/*
 * The step signs in to a CopilotKit account, so it shows CopilotKit's logotype, signed out and
 * while the sign-in waits. It showed OpenBot's mark alone.
 */
test("the CopilotKit sign-in shows CopilotKit's logotype, before and while it waits", async () => {
  waitingSignIn();
  const screen = render(
    <CopilotKitAccount root="/tmp/account-sign-in" onDone={() => {}} />,
  );
  await screen.findByRole("button", { name: "Sign in to CopilotKit" });
  expectCopilotKitLogo(screen);

  await userEvent.click(
    screen.getByRole("button", { name: "Sign in to CopilotKit" }),
  );
  await screen.findByText(PAGE.userCode);
  expectCopilotKitLogo(screen);
});

test("after Accept, the step says it is setting up your apps, not to sign in", async () => {
  // Seen on Windows: Accept was followed for two seconds by "Sign in to CopilotKit" and its
  // sign-in lede, over "Connecting your apps…", for a person already signed in and agreed.
  let connected!: () => void;
  invokeHandler = async ({ command }) => {
    if (command === "local_eval_terms")
      return {
        status: "required",
        accepted: false,
        version: "developer-edition-2026-10-01-web",
        url: "https://copilotkit.ai/legal/developer-edition",
        organizationName: "Acme",
      };
    if (command === "connect_copilotkit_apps")
      return new Promise<void>((resolve) => {
        connected = resolve;
      });
    if (command === "cancel_local_eval") return null;
    throw new Error(`unexpected ${command}`);
  };
  let done: string | null | undefined;
  const screen = render(
    <CopilotKitAccount
      root="/tmp/account-accept"
      onDone={(version) => {
        done = version;
      }}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
  expect(
    await screen.findByRole("heading", { name: "Setting up your apps" }),
  ).toBeTruthy();
  expect(screen.getByText("Connecting your apps…")).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Sign in to CopilotKit" }),
  ).toBeNull();
  expect(screen.queryByText(/Sign in, then accept/)).toBeNull();
  connected();
  await waitFor(() => expect(done).toBe("developer-edition-2026-10-01-web"));
});
