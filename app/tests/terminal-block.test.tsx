import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { ActivityLog } from "@/components/computer/activity-log";
import {
  commandStatus,
  TerminalBlock,
} from "@/components/computer/terminal-block";
import { recordActivity } from "@/lib/computers/activity";
import { onComputerViewRequest } from "@/lib/computers/panel-view";

/**
 * A command the Bot ran, as the chat and the Activity pane draw it: a terminal block with the prompt
 * and the command, the end of what it printed, how it exited, and a way into the live terminal.
 */

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const OUTPUT = Array.from({ length: 12 }, (_, line) => `line ${line + 1}`).join(
  "\n",
);

test("a command reads as a terminal: the prompt and the command, the end of its output, and how it exited", () => {
  const view = render(
    <TerminalBlock
      command="nmap 127.0.0.1"
      output={OUTPUT}
      status={commandStatus({ running: false, exitCode: 0 })}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("$nmap 127.0.0.1");
  expect(text).toContain("Exit 0");
  // Folded to its last lines, with the rest one click away.
  expect(text).toContain("line 12");
  expect(text).not.toContain("line 1\n");
  expect(text).toContain("8 earlier lines");
  const showAll = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent?.includes("Show all 12 lines"),
  ) as HTMLButtonElement;
  act(() => showAll.click());
  expect(view.container.textContent).toContain("line 1\nline 2");
  expect(showAll.getAttribute("aria-expanded")).toBe("true");
});

test("a failure shows its exit code as a status, not a sentence", () => {
  const view = render(
    <TerminalBlock
      command="which nmap"
      output=""
      status={commandStatus({ running: false, exitCode: 1 })}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Exit 1");
  expect(text).not.toContain("didn't work");
});

test("clicking a command asks for its computer's terminal", () => {
  const asked: Array<{ computerId: string; view: string }> = [];
  const stop = onComputerViewRequest((request) => asked.push(request));
  const view = render(
    <TerminalBlock
      command="pwd"
      computerId="notes-bot"
      output="/tmp"
      status={commandStatus({ running: false, exitCode: 0 })}
    />,
  );
  const body = [...view.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("pwd"),
  ) as HTMLButtonElement;
  act(() => body.click());
  stop();
  expect(asked).toEqual([{ computerId: "notes-bot", view: "terminal" }]);
});

test("a command still running says so, and a blocked one says it did not run", () => {
  const running = render(
    <TerminalBlock
      command="apt-get update"
      output=""
      status={commandStatus({ running: true })}
    />,
  );
  expect(running.container.textContent).toContain("Running");
  cleanup();
  const blocked = render(
    <TerminalBlock
      command="rm -rf /"
      output="An admin's rule doesn't allow this."
      status={commandStatus({ running: false, refused: true })}
    />,
  );
  expect(blocked.container.textContent).toContain("Blocked");
});

test("the Activity pane draws a command as the same terminal block", () => {
  recordActivity("activity-bot", [
    {
      id: "call-1",
      did: {
        kind: "command",
        subject: "nmap 127.0.0.1",
        output: "Nmap done: 1 IP address (1 host up)",
        exitCode: 0,
      },
    },
  ]);
  const view = render(<ActivityLog computerId="activity-bot" />);
  const block = view.container.querySelector("section");
  expect(block?.textContent).toContain("$nmap 127.0.0.1");
  expect(block?.textContent).toContain("Exit 0");
  expect(block?.textContent).toContain("Nmap done");
  // In the terminal's own dark ground, not plain text on the page.
  expect(
    view.container
      .querySelector('[style*="background"]')
      ?.getAttribute("style"),
  ).toContain("#0b0a10");
});
