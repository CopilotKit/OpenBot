import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let answer: (command: string) => Promise<unknown> = async () => null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return answer(command);
  },
}));

const { commandsIn, WindowsBlocker, WindowsRestart } = await import(
  "./WindowsBlocker"
);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  invokeCalls = [];
  answer = async () => null;
});
afterAll(() => GlobalRegistrator.unregister());

const ADMINISTRATOR_INSTRUCTION =
  "Setting up Windows Subsystem for Linux needs administrator rights. Ask an administrator to open Windows Terminal or PowerShell as an administrator and run `dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart`, `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, and `wsl --install`. Restart Windows, then start OpenBot again in your own account.";

const noRestart = () => {
  throw new Error("no restart expected");
};

test("the commands are read from the native instruction, in order", () => {
  expect(commandsIn(ADMINISTRATOR_INSTRUCTION)).toEqual([
    "dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart",
    "dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart",
    "wsl --install",
  ]);
});

/*
 * David's direction for 1.0.1: no button before an install step's prompt. The screen says what
 * Windows will ask and why, and OpenBot starts the change by itself after a moment; Windows shows
 * its own administrator prompt. Here no click is made, and the fix still runs.
 */
test("turning on WSL starts by itself, with no click, and hands over to the restart", async () => {
  let restartNeeded = false;
  answer = async () => "restart-needed";
  const view = render(
    <WindowsBlocker
      blocker="wsl-absent"
      instruction="Run `wsl --install`."
      onRestartNeeded={() => {
        restartNeeded = true;
      }}
      beforePromptMs={50}
    />,
  );
  // Said before Windows asks, with no button to press.
  expect(
    view.getByText(
      "Windows will ask for your permission so OpenBot can turn it on. Then Windows needs one restart.",
    ),
  ).toBeTruthy();
  expect(
    view.queryAllByRole("button", { name: /Set up|Switch|Finish/ }),
  ).toEqual([]);
  expect(invokeCalls).toEqual([]);
  await waitFor(() => expect(restartNeeded).toBe(true));
  expect(invokeCalls).toEqual([
    { command: "windows_fix", args: { blocker: "wsl-absent" } },
  ]);
});

test("a fix with no restart checks the machine again, with no click", async () => {
  let cleared = false;
  answer = async () => "done";
  render(
    <WindowsBlocker
      blocker="wsl-one"
      instruction="Run `wsl --set-default-version 2`."
      onRestartNeeded={noRestart}
      onCleared={() => {
        cleared = true;
      }}
      beforePromptMs={10}
    />,
  );
  await waitFor(() => expect(cleared).toBe(true));
});

/** Saying no to Windows' prompt is recoverable: said plainly, asked again by itself, and Try again. */
test("a declined prompt is said without an error, and asked again by itself and on Try again", async () => {
  let asked = 0;
  answer = async () => {
    asked += 1;
    return "declined";
  };
  const view = render(
    <WindowsBlocker
      blocker="wsl-absent"
      instruction="Run `wsl --install`."
      onRestartNeeded={noRestart}
      beforePromptMs={10}
      askAgainMs={200}
    />,
  );
  await view.findByText(
    "OpenBot needs Windows' permission to turn on a feature it needs. It asks again in a moment, or choose Try again.",
  );
  expect(view.queryByRole("alert")).toBeNull();
  // Asked again by itself after the wait.
  await waitFor(() => expect(asked).toBe(2), { timeout: 2000 });
  // And at once on Try again.
  fireEvent.click(await view.findByRole("button", { name: "Try again" }));
  await waitFor(() => expect(asked).toBe(3));
  expect(view.getByText("Or run the commands yourself")).toBeTruthy();
  expect(view.getByText("wsl --install")).toBeTruthy();
});

test("a fix that fails says so, with Try again and the commands", async () => {
  answer = async () => {
    throw {
      said: "OpenBot could not set up Windows Subsystem for Linux. Try again, or run the commands yourself.",
    };
  };
  const view = render(
    <WindowsBlocker
      blocker="wsl-absent"
      instruction="Run `wsl --install`."
      onRestartNeeded={noRestart}
      beforePromptMs={10}
    />,
  );
  expect(
    (await view.findByRole("alert")).textContent?.includes("could not set up"),
  ).toBe(true);
  const button = view.getByRole("button", {
    name: "Try again",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(view.getByText("wsl --install")).toBeTruthy();
});

test("a standard account sets up with an administrator's password, and Copy copies every command", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  answer = () => new Promise(() => {});
  const view = render(
    <WindowsBlocker
      blocker="not-administrator"
      instruction={ADMINISTRATOR_INSTRUCTION}
      onRestartNeeded={noRestart}
      beforePromptMs={10}
    />,
  );
  expect(
    view.getByRole("heading", {
      name: "An administrator needs to turn on WSL",
    }),
  ).toBeTruthy();
  expect(view.getByText(/administrator's name and password/)).toBeTruthy();
  await waitFor(() =>
    expect(invokeCalls.map((call) => call.command)).toContain("windows_fix"),
  );
  expect(view.getByText(/Ask an administrator/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(view.getByRole("button", { name: "Copied" })));
  expect(written).toEqual([commandsIn(ADMINISTRATOR_INSTRUCTION).join("\n")]);
});

test("firmware virtualization has steps and nothing to run", () => {
  const view = render(
    <WindowsBlocker
      blocker="virtualization-disabled"
      instruction="Virtualization is switched off in this machine's firmware."
      onRestartNeeded={noRestart}
    />,
  );
  expect(
    view.getByRole("heading", { name: "Turn on virtualization" }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Copy" })).toBeNull();
  expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(invokeCalls).toEqual([]);
  expect(view.getByText(/nested virtualization/)).toBeTruthy();
});

test("a virtual machine without nested virtualization is told what to change on its host", () => {
  const view = render(
    <WindowsBlocker
      blocker="nested-virtualization-unavailable"
      instruction="This Windows runs in a virtual machine whose host does not pass virtualization through to it."
      onRestartNeeded={noRestart}
    />,
  );
  expect(
    view.getByRole("heading", { name: "Turn on nested virtualization" }),
  ).toBeTruthy();
  expect(view.getByText(/Shut down this virtual machine/)).toBeTruthy();
  expect(view.getByText(/ExposeVirtualizationExtensions/)).toBeTruthy();
  expect(view.getByText(/Apple silicon cannot do this/)).toBeTruthy();
  expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(view.queryByText(/firmware settings/)).toBeNull();
});

test("Restart now restarts Windows, and a refusal is said with the button back", async () => {
  answer = async () => {
    throw {
      said: "OpenBot could not restart Windows. Restart it from the Start menu.",
    };
  };
  const view = render(<WindowsRestart />);
  expect(
    view.getByRole("heading", { name: "Restart Windows to finish" }),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Restart now" }));
  expect(
    (await view.findByRole("alert")).textContent?.includes(
      "could not restart Windows",
    ),
  ).toBe(true);
  expect(invokeCalls).toEqual([
    { command: "windows_restart", args: undefined },
  ]);
  const button = view.getByRole("button", {
    name: "Restart now",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
});
