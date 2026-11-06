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

test("Set up Windows runs the fix for this blocker and hands over to the restart", async () => {
  let restartNeeded = false;
  answer = async () => "restart-needed";
  const view = render(
    <WindowsBlocker
      blocker="wsl-absent"
      instruction="Run `wsl --install`."
      onRestartNeeded={() => {
        restartNeeded = true;
      }}
    />,
  );
  expect(view.getByText(/Windows will ask for permission/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Set up Windows" }));
  await waitFor(() => expect(restartNeeded).toBe(true));
  expect(invokeCalls).toEqual([
    { command: "windows_fix", args: { blocker: "wsl-absent" } },
  ]);
});

test("a fix with no restart checks the machine again", async () => {
  let cleared = false;
  answer = async () => "done";
  const view = render(
    <WindowsBlocker
      blocker="wsl-one"
      instruction="Run `wsl --set-default-version 2`."
      onRestartNeeded={noRestart}
      onCleared={() => {
        cleared = true;
      }}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Switch to WSL 2" }));
  await waitFor(() => expect(cleared).toBe(true));
});

test("a declined prompt is said, and the button and the commands stay", async () => {
  answer = async () => {
    throw {
      said: "Windows did not get permission to make the change. Choose Set up Windows again and approve the prompt, or run the commands yourself.",
    };
  };
  const view = render(
    <WindowsBlocker
      blocker="wsl-absent"
      instruction="Run `wsl --install`."
      onRestartNeeded={noRestart}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Set up Windows" }));
  expect(
    (await view.findByRole("alert")).textContent?.includes(
      "did not get permission",
    ),
  ).toBe(true);
  const button = view.getByRole("button", {
    name: "Set up Windows",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(view.getByText("Or run the commands yourself")).toBeTruthy();
  expect(view.getByText("wsl --install")).toBeTruthy();
});

test("a standard account can still set up, with an administrator's password, and Copy copies every command", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  const view = render(
    <WindowsBlocker
      blocker="not-administrator"
      instruction={ADMINISTRATOR_INSTRUCTION}
      onRestartNeeded={noRestart}
    />,
  );
  expect(
    view.getByRole("heading", {
      name: "An administrator needs to turn on WSL",
    }),
  ).toBeTruthy();
  expect(view.getByText(/administrator's name and password/)).toBeTruthy();
  expect(view.getByRole("button", { name: "Set up Windows" })).toBeTruthy();
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
  expect(view.queryByRole("button", { name: "Set up Windows" })).toBeNull();
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
  expect(view.queryByRole("button", { name: "Set up Windows" })).toBeNull();
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
