import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { commandsIn, WindowsBlocker } from "./WindowsBlocker";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const ADMINISTRATOR_INSTRUCTION =
  "Setting up Windows Subsystem for Linux needs administrator rights. Ask an administrator to open Windows Terminal or PowerShell as an administrator and run `dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart`, `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, and `wsl --install`. Restart Windows, then start OpenBot again in your own account.";

test("the commands are read from the native instruction, in order", () => {
  expect(commandsIn(ADMINISTRATOR_INSTRUCTION)).toEqual([
    "dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart",
    "dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart",
    "wsl --install",
  ]);
});

test("a standard account is told who has to run the commands, and Copy copies all of them", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  const view = render(
    <WindowsBlocker
      blocker="not-administrator"
      instruction={ADMINISTRATOR_INSTRUCTION}
    />,
  );
  expect(
    view.getByRole("heading", {
      name: "An administrator needs to turn on WSL",
    }),
  ).toBeTruthy();
  expect(view.getByText(/Ask an administrator/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(view.getByRole("button", { name: "Copied" })));
  expect(written).toEqual([commandsIn(ADMINISTRATOR_INSTRUCTION).join("\n")]);
});

test("firmware virtualization has steps and no command to copy", () => {
  const view = render(
    <WindowsBlocker
      blocker="virtualization-disabled"
      instruction="Virtualization is switched off in this machine's firmware."
    />,
  );
  expect(
    view.getByRole("heading", { name: "Turn on virtualization" }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Copy" })).toBeNull();
  expect(view.getByText(/nested virtualization/)).toBeTruthy();
});
