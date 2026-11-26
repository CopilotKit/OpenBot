import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GoAhead } from "./SetupProgress";

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
 * The CLI's `login` for a sign-in it already has: answered at once, with no browser. Every other
 * command goes to `handler`.
 */
function alreadySignedIn(handler: (call: Call) => Promise<unknown>) {
  return async (call: Call) => {
    if (call.command === "sign_in_to_copilotkit") return { signedIn: true };
    if (call.command === "copilotkit_sign_in_page") return null;
    return handler(call);
  };
}

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

/** The step opens: its sign-in starts by itself, with no click. */
async function startSigningIn() {
  return render(
    <CopilotKitAccount root="/tmp/account-sign-in" onDone={() => {}} />,
  );
}

test("checking keeps the heading outside the scrollable account interaction", async () => {
  invokeHandler = async () => new Promise(() => {});
  const screen = await startSigningIn();
  const heading = screen.getByRole("heading", { name: "Your OpenBot account" });
  const sheet = heading.closest<HTMLElement>(".sheet");
  expect(sheet?.classList.contains("account-layout")).toBe(true);
  expect(sheet?.classList.contains("setup-layout")).toBe(true);
  expect(heading.closest(".setup-header-block")?.parentElement).toBe(sheet);
  const status = screen.getByText("Checking your OpenBot account…");
  expect(status.closest(".setup-body")?.parentElement).toBe(sheet);
  expect(status.closest(".setup-content > .setup-panel")).not.toBeNull();
  expect(!!sheet?.querySelector(".setup-panel > .row:empty")).toBe(false);
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});

/** OpenBot's own engine check: a Docker short of disk is caught here, before Start fails on it. */
test("an engine short of disk says how to raise it, and Try again checks again", async () => {
  invokeHandler = alreadySignedIn(async ({ command }) => {
    if (command === "local_eval_terms")
      return {
        status: "engine-too-small",
        podman: false,
        cpu: false,
        memory: false,
        disk: true,
      };
    throw new Error(`unexpected ${command}`);
  });
  const screen = render(
    <CopilotKitAccount root="/tmp/account-engine" onDone={() => {}} />,
  );
  await screen.findByText(
    "Docker Desktop doesn't have enough free disk space. OpenBot needs 40 GB free. Raise the disk limit in Docker Desktop > Settings > Resources, or free space in Docker, then Try again.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "local_eval_terms"),
    ).toHaveLength(2),
  );
});

/**
 * What `local_eval_terms` answered on Windows F, filled to 15 GB free, once Install had made
 * OpenBot's machine: 13.2 GiB free on C:. `local_eval.rs` measures F's engine and checks its answer
 * is this.
 */
const windowsFShortOfDisk = JSON.parse(
  readFileSync(
    new URL(
      "../src-tauri/test-fixtures/local-eval/local-eval-terms-windows-f-short-of-disk.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

/**
 * Windows F was told "OpenBot is out of disk space. It needs 40 GB free." with 13 GB free, and
 * again on Try again. The step says what is free and what is needed, and Try again asks again.
 */
test("a disk too short for OpenBot says what is free and what it needs", async () => {
  invokeHandler = alreadySignedIn(async ({ command }) => {
    if (command === "local_eval_terms") return windowsFShortOfDisk;
    throw new Error(`unexpected ${command}`);
  });
  const screen = render(
    <CopilotKitAccount root="/tmp/account-windows-f" onDone={() => {}} />,
  );
  await screen.findByText(
    "This computer has 13.2 GB of free space on drive C:, and OpenBot needs 40 GB. Free up some space, then Try again.",
  );
  expect(screen.queryByText(/out of disk space/)).toBeNull();
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
 * 1.0.0 sat on "Checking your OpenBot account…" for 15 minutes on a Mac with OrbStack, asking
 * every 2 seconds, then said only that it couldn't check the account. The refusal is said at once,
 * with what to do about it, and nothing is asked again until Try again.
 */
test("an engine local setup doesn't run on is said at once, with how to switch", async () => {
  invokeHandler = alreadySignedIn(async ({ command }) => {
    if (command === "local_eval_terms") return orbStack;
    throw new Error(`unexpected ${command}`);
  });
  const screen = render(
    <CopilotKitAccount root="/tmp/account-orbstack" onDone={() => {}} />,
  );
  await screen.findByRole("heading", {
    name: "Switch to Docker Desktop or Podman",
  });
  // OpenBot's own words: the CLI's names a rootful Podman, and goes to the log.
  expect(
    screen.getByText(
      "OpenBot can't run with the app this computer uses to run its software. It works with Docker Desktop or Podman.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/rootful/)).toBeNull();
  expect(screen.getByText("docker context use desktop-linux")).toBeTruthy();
  expect(
    screen.queryByText("Couldn’t check your OpenBot account. Try again."),
  ).toBeNull();
  expect(screen.queryByText("Checking your OpenBot account…")).toBeNull();

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

/**
 * What `local_eval_terms` answers while no engine answers yet: the CLI's preflight found no Podman
 * (`onboard-local-terms-no-engine.json`), as `local_eval.rs` normalizes and checks it.
 */
const noEngine = JSON.parse(
  readFileSync(
    new URL(
      "../src-tauri/test-fixtures/local-eval/local-eval-terms-no-engine.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

/** A status line, with the rows' spinner, that says exactly `said`. */
function expectWorking(screen: ReturnType<typeof render>, said: string) {
  const status = screen
    .getAllByRole("status")
    .find((line) => line.textContent === said);
  expect(status?.textContent).toBe(said);
  expect(status?.querySelector(".step-spinner")).not.toBeNull();
}

/**
 * 1.0.0 on a new Mac said only "Checking your OpenBot account…" for minutes while Install put
 * Podman in behind this step. Signed in first, it says what the agreement is waiting on, in
 * Install's own words as Install moves on. Then it goes on to the agreement by itself.
 */
test("while Install sets up the engine, the signed-in account step says so, then goes on to the agreement", async () => {
  let asked = 0;
  let answerSecond!: (terms: unknown) => void;
  invokeHandler = alreadySignedIn(async ({ command }) => {
    if (command === "local_eval_terms") {
      asked += 1;
      if (asked === 1) return noEngine;
      if (asked === 2)
        return new Promise((resolve) => {
          answerSecond = resolve;
        });
      return {
        status: "required",
        accepted: false,
        version: "developer-edition-2026-10-01-web",
        url: "https://copilotkit.ai/legal/developer-edition",
        organizationName: "Acme",
      };
    }
    throw new Error(`unexpected ${command}`);
  });
  const account = (engine: string) => (
    <CopilotKitAccount
      root="/tmp/account-no-engine"
      onDone={() => {}}
      engine={engine}
    />
  );
  const screen = render(account("Preparing the engine machine."));
  await screen.findByText(
    "You're signed in. OpenBot is setting up the software it runs on. The license agreement comes next.",
  );
  expect(
    screen.getByRole("heading", { name: "Setting up this computer" }),
  ).toBeTruthy();
  expectWorking(screen, "Preparing the engine machine.");
  expect(screen.queryByText("Checking your OpenBot account…")).toBeNull();

  // Install moves on, and so does what the step says. Asking again, it still says it.
  screen.rerender(account("Starting the engine machine."));
  expectWorking(screen, "Starting the engine machine.");
  await waitFor(() => expect(asked).toBe(2), { timeout: 3000 });
  expectWorking(screen, "Starting the engine machine.");
  expect(screen.queryByText("Checking your OpenBot account…")).toBeNull();
  answerSecond(noEngine);

  // The engine answers: the agreement.
  expect(
    await screen.findByRole(
      "heading",
      { name: "Accept the license agreement" },
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  expect(asked).toBe(3);
  expect(screen.queryByText("Starting the engine machine.")).toBeNull();
  // Signed in once, at the start: never asked again.
  expect(
    invokeCalls.filter((call) => call.command === "sign_in_to_copilotkit"),
  ).toHaveLength(1);
}, 15000);

/**
 * macOS's password prompt comes only on Continue, said in a card on the Account step, and closing
 * it without a password is a decision: Install asks again, the step says why, and Try again works.
 */
test("the password prompt waits for Continue in the step, and a closed one is said with Try again", async () => {
  invokeHandler = alreadySignedIn(async ({ command }) => {
    if (command === "local_eval_terms") return noEngine;
    if (command === "allow_podman_install") return true;
    throw new Error(`unexpected ${command}`);
  });
  const account = (goAhead: GoAhead | null) => (
    <CopilotKitAccount
      root="/tmp/account-go-ahead"
      onDone={() => {}}
      goAhead={goAhead}
    />
  );
  // Nothing waits on the person: nothing to click.
  const screen = render(account(null));
  await screen.findByRole("heading", { name: "Setting up this computer" });
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  const allowed = () =>
    invokeCalls.filter((call) => call.command === "allow_podman_install");

  // Before the prompt: what comes next and why, and Continue, which lets the prompt come up.
  const before =
    "OpenBot needs to install the software it runs on. Choose Continue, then enter your Mac password when your Mac asks for it.";
  screen.rerender(account({ line: before, beforePrompt: true }));
  const card = screen.getByRole("region", {
    name: "Your Mac will ask for your password",
  });
  expect(card.textContent).toContain(before);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(allowed()).toHaveLength(1);

  // Closed without a password: what that means, and Try again.
  const declined =
    "OpenBot needs your password to install what it needs to run. It asks again in a moment, or choose Try again.";
  screen.rerender(account({ line: declined, beforePrompt: false }));
  expect(
    screen.getByRole("region", { name: "Your password is needed" }),
  ).toBeTruthy();
  expect(screen.getByText(declined)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    (screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(allowed()).toHaveLength(2);
});

/** A refusal with no sentence of the CLI's own still says what is wrong, and is not waited out. */
test("a refused engine with no sentence from the CLI says so in OpenBot's words", async () => {
  invokeHandler = alreadySignedIn(async ({ command }) => {
    if (command === "local_eval_terms")
      return { status: "blocked", reason: "unsupported-engine" };
    throw new Error(`unexpected ${command}`);
  });
  const screen = render(
    <CopilotKitAccount root="/tmp/account-refused" onDone={() => {}} />,
  );
  await screen.findByText(
    "OpenBot can't run with the app this computer uses to run its software. It works with Docker Desktop or Podman.",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("a sign-in waiting on the browser shows its code and a way back to the page", async () => {
  waitingSignIn();
  const screen = await startSigningIn();
  const instruction = await screen.findByRole("heading", {
    level: 3,
    name: "Finish signing in to OpenBot in your browser…",
  });
  const waiting = screen.getByText("Waiting for you to finish signing in…");
  expect(waiting.closest(".status-line")).not.toBeNull();
  expect(instruction.closest(".status-line")).toBeNull();
  expect(
    screen.container.querySelectorAll(".sign-in-wait .step-spinner"),
  ).toHaveLength(1);
  expect((await screen.findByText(PAGE.userCode)).tagName).toBe("STRONG");
  expect(
    screen.getByText(
      "If your browser shows a dashboard after you choose an organization, open the sign-in page again.",
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
  const panel = screen.getByText(PAGE.userCode).closest(".setup-panel");
  expect(panel).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "Cancel" }).closest(".setup-panel"),
  ).toBe(panel);
  const explanation = screen.getByText(/Signing in gets your free license key/);
  expect(explanation.nextElementSibling).toBe(panel);
  expect(explanation.parentElement?.classList.contains("setup-content")).toBe(
    true,
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(
    invokeCalls.filter((call) => call.command === "cancel_local_eval"),
  ).toEqual([
    { command: "cancel_local_eval", args: { attempt: signInAttempt() } },
  ]);
  expect(
    await screen.findByRole("button", {
      name: "Sign in for a free local license key",
    }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Sign in for a free local license key" })
      .closest(".setup-panel"),
  ).not.toBeNull();
  expect(screen.queryByText(PAGE.userCode)).toBeNull();
  // The stopped sign-in is not reported as a failure.
  await new Promise((settle) => setTimeout(settle, 50));
  expect(screen.queryByText("Sign-in didn’t finish. Try again.")).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Open the sign-in page" }),
  ).toBeNull();
});

/*
 * Seen on two Windows computers: after "Sign-in didn't finish", the first Try again showed the code
 * that had just timed out, and approving it said it had expired. Try again starts a new sign-in
 * that shows its own code, never the timed-out one, even when the old sign-in's answer lands late.
 */
test("after a sign-in times out, Try again shows a new code and never the old one", async () => {
  const OLD = {
    url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=OLDC-0001&source=cli&mode=openbot",
    userCode: "OLDC-0001",
  };
  const attempts: string[] = [];
  const first: {
    timeOut?: (reason: unknown) => void;
    lateAnswer?: (found: unknown) => void;
  } = {};
  let asksForOld = 0;
  invokeHandler = async ({ command, args }) => {
    const attempt = args?.attempt as string;
    if (command === "local_eval_terms") return { status: "signed-out" };
    if (command === "sign_in_to_copilotkit") {
      attempts.push(attempt);
      return new Promise((_, reject) => {
        if (attempts.length === 1) first.timeOut = reject;
      });
    }
    if (command === "copilotkit_sign_in_page") {
      if (attempt === attempts[0]) {
        asksForOld += 1;
        if (asksForOld === 1) return OLD;
        // Still on its way when the sign-in times out.
        return new Promise((resolve) => {
          first.lateAnswer = resolve;
        });
      }
      return attempt === attempts[1] ? PAGE : null;
    }
    if (command === "cancel_local_eval") return null;
    throw new Error(`unexpected ${command}`);
  };
  const screen = await startSigningIn();
  await screen.findByText(OLD.userCode);
  await waitFor(() => expect(first.lateAnswer).toBeDefined());

  // OpenBot stopped the CLI's sign-in: it waited too long.
  first.timeOut?.("timeout");
  await screen.findByText("Sign-in didn’t finish. Try again.");
  expect(screen.queryByText(OLD.userCode)).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  // The late answer for the timed-out sign-in lands after Try again.
  first.lateAnswer?.(OLD);
  expect((await screen.findByText(PAGE.userCode)).tagName).toBe("STRONG");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).not.toBe(attempts[0]);
  expect(screen.queryByText(OLD.userCode)).toBeNull();
  expect(
    screen
      .getByRole("link", { name: "Open the sign-in page" })
      .getAttribute("href"),
  ).toBe(PAGE.url);
});

/*
 * The step is OpenBot's, so it leads with OpenBot by CopilotKit, not CopilotKit's logotype, while
 * the sign-in waits and once it is stopped, and says what the free local license key is for.
 */
test("the sign-in leads with OpenBot, while it waits and once stopped", async () => {
  waitingSignIn();
  const screen = await startSigningIn();
  await screen.findByText(PAGE.userCode);
  expect(
    screen.getByRole("heading", { name: "Get your free license key" }),
  ).toBeTruthy();
  expect(screen.getByText(/needs a free license key/)).toBeTruthy();
  // What signing in does, and where OpenBot keeps what you make: never "only", and never that
  // conversations stay on this computer (the AI provider gets them).
  expect(
    screen.getByText(
      "Signing in gets your free license key and sets up your apps. OpenBot keeps your conversations and files on this computer.",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText(/traffic data|\bonly\b|stay on this computer/),
  ).toBeNull();
  expect(screen.getByText("by CopilotKit")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "CopilotKit" })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("button", {
    name: "Sign in for a free local license key",
  });
  expect(screen.queryByRole("img", { name: "CopilotKit" })).toBeNull();
});

test("the agreement groups its explanation, legal link and explicit Accept in the centered panel", async () => {
  const terms = {
    status: "required",
    accepted: false,
    version: "developer-edition-2026-10-01-web",
    url: "https://copilotkit.ai/legal/developer-edition",
    organizationName: "Acme",
  };
  invokeHandler = alreadySignedIn(async ({ command }) => {
    if (command === "local_eval_terms") return terms;
    if (command === "plugin:opener|open_url") return null;
    throw new Error(`unexpected ${command}`);
  });
  const screen = await startSigningIn();
  const accept = await screen.findByRole("button", { name: "Accept" });
  const heading = screen.getByRole("heading", {
    name: "Accept the license agreement",
  });
  const sheet = heading.closest<HTMLElement>(".sheet");
  expect(sheet?.classList.contains("setup-layout")).toBe(true);
  expect(sheet?.classList.contains("account-layout")).toBe(true);
  expect(heading.closest(".setup-header-block")?.parentElement).toBe(sheet);
  const panel = accept.closest<HTMLElement>(".setup-panel");
  expect(panel).not.toBeNull();
  const documentIcon = panel?.querySelector("svg.agreement-icon");
  expect(documentIcon).not.toBeNull();
  expect(documentIcon?.getAttribute("aria-hidden")).toBe("true");
  expect(documentIcon?.getAttribute("width")).toBe("28");
  expect(documentIcon?.getAttribute("height")).toBe("28");
  expect(documentIcon?.getAttribute("stroke-width")).toBe("1.5");
  expect(screen.queryByRole("img")).toBeNull();
  expect(panel?.closest(".setup-body")?.parentElement).toBe(sheet);
  expect(panel?.parentElement?.classList.contains("setup-content")).toBe(true);
  const explanation = screen.getByText(
    "To run OpenBot on this computer, accept the OpenBot by CopilotKit license agreement.",
  );
  expect(explanation.closest<HTMLElement>(".setup-panel")).toBe(panel);
  expect(explanation.closest(".setup-header-block")).toBeNull();
  const link = screen.getByRole("link", { name: "Read the license agreement" });
  expect(link.closest<HTMLElement>(".setup-panel")).toBe(panel);
  expect(link.getAttribute("href")).toBe(terms.url);
  expect(accept.closest(".step-footer")).toBeNull();
  expect(
    Array.from(panel?.querySelectorAll("a, button") ?? []).map(
      (element) => element.textContent,
    ),
  ).toEqual(["Read the license agreement", "Accept"]);
  await userEvent.click(link);
  expect(
    invokeCalls.some((call) => call.command === "connect_copilotkit_apps"),
  ).toBe(false);
});

test("after Accept, the step says it is setting up your apps, not to sign in", async () => {
  // Seen on Windows: Accept was followed for two seconds by the sign-in heading and its
  // sign-in lede, over "Connecting your apps…", for a person already signed in and agreed.
  let connected!: () => void;
  invokeHandler = alreadySignedIn(async ({ command }) => {
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
  });
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
    screen.queryByRole("heading", { name: "Get your free license key" }),
  ).toBeNull();
  expect(screen.queryByText(/needs a free license key/)).toBeNull();
  connected();
  await waitFor(() => expect(done).toBe("developer-edition-2026-10-01-web"));
});

/*
 * The install behind this step is said at the sidebar's foot, never in the step, and it never
 * spins: beside "Finish signing in to OpenBot in your browser…" it was a second spinner, and as it
 * came and went it moved the button the person was about to press.
 */
test("the install behind the step is at the sidebar's foot, quiet, and never in the page", async () => {
  waitingSignIn();
  const asked: string[] = [];
  const screen = render(
    <CopilotKitAccount
      root="/tmp/account-behind"
      onDone={() => {}}
      behind={(waitingFor) => {
        asked.push(waitingFor);
        return {
          step: "install",
          ok: true,
          running: true,
          detail: waitingFor,
          position: { at: 3, of: 4 },
        };
      }}
    />,
  );
  await screen.findByText(PAGE.userCode);
  const list = screen.getByRole("list", { name: "Background install" });
  expect(list.closest("aside.rail > .rail-foot")).not.toBeNull();
  expect(list.closest(".sheet")).toBeNull();
  // The step's own wait is the one spinner on the screen; the row behind it is marked, not spun.
  expect(list.querySelector(".step-spinner")).toBeNull();
  expect(list.querySelector(".step-current")).not.toBeNull();
  const page = screen
    .getByRole("heading", { name: "Get your free license key" })
    .closest(".sheet") as HTMLElement;
  expect(page.previousElementSibling).toBe(list.closest("aside.rail"));
  expect(
    page.querySelector('[aria-label="Background install"], .rail-foot'),
  ).toBeNull();
  expect(list.textContent).toContain(asked.at(-1) ?? "");
  // The sections head the sidebar, with Account the step it is on.
  const sections = screen.getByRole("list", { name: "Setup" });
  expect(sections.closest("aside.rail")).toBe(list.closest("aside.rail"));
  expect(sections.querySelector('[aria-current="step"]')?.textContent).toBe(
    "Account",
  );
});
