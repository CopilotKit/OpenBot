import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Call = { command: string; args?: Record<string, unknown> };

let invokeHandler: (call: Call) => Promise<unknown> = async () => null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) =>
    invokeHandler({ command, args }),
}));

const { CopilotKitSignInWait } = await import("./CopilotKitSignInWait");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

/** The page the CLI opened for a sign-in, with a synthetic code. */
function page(code: string) {
  return {
    url: `https://dashboard.copilotkit.ai/cli-auth/device?user_code=${code}&source=cli&mode=openbot`,
    userCode: code,
  };
}

/*
 * The first Try again after "Sign-in didn't finish" showed the code that had just timed out, on
 * two Windows computers, and approving it said it had expired. A code belongs to the sign-in that
 * printed it: a new sign-in shows nothing but its own, even while the earlier sign-in's answer is
 * still on its way.
 */
test("a new sign-in shows only its own code, never the one before, even when the old answer lands late", async () => {
  const old: { lateAnswer?: (found: unknown) => void } = {};
  let asksForOld = 0;
  invokeHandler = async ({ command, args }) => {
    if (command !== "copilotkit_sign_in_page")
      throw new Error(`unexpected ${command}`);
    if (args?.attempt === "timed-out") {
      asksForOld += 1;
      // The first ask answers at once; the next one is still on its way when Try again starts.
      if (asksForOld === 1) return page("OLDC-0001");
      return new Promise((resolve) => {
        old.lateAnswer = resolve;
      });
    }
    // The new sign-in's CLI has not printed its code yet.
    return null;
  };
  const screen = render(
    <CopilotKitSignInWait
      attempt="timed-out"
      waiting="Finish signing in to OpenBot in your browser…"
      onCancel={() => {}}
    />,
  );
  await screen.findByText("OLDC-0001");
  // Wait until the next ask for the old sign-in is in flight.
  await waitFor(() => expect(old.lateAnswer).toBeDefined());

  screen.rerender(
    <CopilotKitSignInWait
      attempt="try-again"
      waiting="Finish signing in to OpenBot in your browser…"
      onCancel={() => {}}
    />,
  );
  expect(screen.queryByText("OLDC-0001")).toBeNull();
  // The old sign-in's answer lands after Try again: still not shown.
  old.lateAnswer?.(page("OLDC-0001"));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText("OLDC-0001")).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Open the sign-in page" }),
  ).toBeNull();

  // The new sign-in's own code, once its CLI prints it.
  invokeHandler = async ({ command, args }) => {
    if (command !== "copilotkit_sign_in_page")
      throw new Error(`unexpected ${command}`);
    return args?.attempt === "try-again"
      ? page("NEWC-0002")
      : page("OLDC-0001");
  };
  expect((await screen.findByText("NEWC-0002")).tagName).toBe("STRONG");
  expect(screen.queryByText("OLDC-0001")).toBeNull();
});

test("groups the waiting status, current comparison code and recovery actions as the page opens", async () => {
  let opened: ((found: unknown) => void) | undefined;
  invokeHandler = async ({ command, args }) => {
    expect(command).toBe("copilotkit_sign_in_page");
    expect(args?.attempt).toBe("opening");
    return new Promise((resolve) => {
      opened = resolve;
    });
  };
  const onPage = mock(() => {});
  const onCancel = mock(() => {});
  const screen = render(
    <CopilotKitSignInWait
      attempt="opening"
      before="Checking your sign-in…"
      waiting="Finish signing in in your browser…"
      onPage={onPage}
      onCancel={onCancel}
    />,
  );
  const group = screen.container.querySelector<HTMLElement>(".sign-in-wait");
  expect(group).not.toBeNull();
  expect(
    screen.getByText("Checking your sign-in…").closest(".status-line")
      ?.parentElement,
  ).toBe(group);
  expect(
    screen.getByRole("button", { name: "Cancel" }).parentElement?.parentElement,
  ).toBe(group);
  expect(screen.queryByRole("link")).toBeNull();
  expect(onPage).not.toHaveBeenCalled();

  opened?.(page("TEST-0042"));
  const code = await screen.findByText("TEST-0042");
  const row = code.parentElement;
  expect(row?.classList.contains("sign-in-code-row")).toBe(true);
  expect(row?.parentElement).toBe(group);
  expect(row?.firstElementChild?.textContent).toBe(
    "Check that the page shows this code:",
  );
  expect(code.tagName).toBe("STRONG");
  expect(
    screen
      .getByText("Finish signing in in your browser…")
      .closest(".status-line")?.parentElement,
  ).toBe(group);
  const link = screen.getByRole("link", { name: "Open the sign-in page" });
  expect(link.getAttribute("href")).toBe(page("TEST-0042").url);
  expect(link.parentElement?.parentElement).toBe(group);
  expect(
    screen.getByText(/If your browser shows a dashboard/).parentElement,
  ).toBe(group);
  expect(onPage).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("heading")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("the optional instruction heading appears only for the current browser page", async () => {
  let answer: ((found: unknown) => void) | undefined;
  invokeHandler = async () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const props = {
    waiting: "Finish signing in to OpenBot in your browser…",
    waitingStatus: "Waiting for you to finish signing in…",
    before: "Checking your OpenBot account…",
    onCancel: () => {},
  };
  const screen = render(<CopilotKitSignInWait {...props} attempt="first" />);
  expect(screen.queryByRole("heading")).toBeNull();
  expect(screen.getByText(props.before).closest(".status-line")).not.toBeNull();
  answer?.(page("TEST-0042"));
  await screen.findByRole("heading", { level: 3, name: props.waiting });
  expect(
    screen.getByText(props.waitingStatus).closest(".status-line"),
  ).not.toBeNull();
  screen.rerender(<CopilotKitSignInWait {...props} attempt="retry" />);
  expect(screen.queryByRole("heading")).toBeNull();
  expect(screen.queryByText(props.waitingStatus)).toBeNull();
  expect(screen.getByText(props.before).closest(".status-line")).not.toBeNull();
});
