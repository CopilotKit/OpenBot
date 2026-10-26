import { useState } from "react";

export type Blocker =
  | "wsl-absent"
  | "wsl-one"
  | "wsl-no-kernel"
  | "virtual-machine-platform-disabled"
  | "virtualization-disabled"
  | "not-administrator";

const WHY_WSL =
  "OpenBot runs its services in Linux containers. On Windows, those need Windows Subsystem for Linux (WSL 2).";

/** What each blocker is called, why it matters, and who can fix it. */
const SCREENS: Record<
  Blocker,
  { title: string; why: string; administrator?: "you" | "someone-else" }
> = {
  "wsl-absent": {
    title: "Turn on Windows Subsystem for Linux",
    why: `${WHY_WSL} It's a one-time setup.`,
    administrator: "you",
  },
  "wsl-one": {
    title: "Switch Windows Subsystem for Linux to version 2",
    why: "WSL is installed but set to version 1. OpenBot's containers need version 2.",
    administrator: "you",
  },
  "wsl-no-kernel": {
    title: "Finish installing Windows Subsystem for Linux",
    why: "WSL is turned on, but its Linux kernel is missing, so nothing can run in it yet.",
    administrator: "you",
  },
  "virtual-machine-platform-disabled": {
    title: "Turn on Virtual Machine Platform",
    why: "WSL 2 needs this Windows feature, and it is turned off.",
    administrator: "you",
  },
  "not-administrator": {
    title: "An administrator needs to turn on WSL",
    why: `${WHY_WSL} Turning it on needs administrator rights, which this account does not have.`,
    administrator: "someone-else",
  },
  "virtualization-disabled": {
    title: "Turn on virtualization",
    why: "WSL 2 runs a small virtual machine, and virtualization is turned off in this computer's firmware. OpenBot cannot change that setting.",
  },
};

/** The commands the native instruction names, in order: each one sits in backticks there. */
export function commandsIn(instruction: string): string[] {
  return [...instruction.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/**
 * The screen for a Windows machine that cannot run OpenBot yet, and what to do about it.
 *
 * The commands come from the native side's instruction, which is what its tests hold to; this
 * screen only lays them out as steps, in a block that copies whole, because nobody should have to
 * retype `dism.exe /online /enable-feature …` from a sentence.
 */
export function WindowsBlocker({
  blocker,
  instruction,
}: {
  blocker: Blocker;
  /** The native instruction; only the commands in it are shown. */
  instruction: string;
}) {
  const screen = SCREENS[blocker];
  const commands = commandsIn(instruction);
  return (
    <main>
      <div className="sheet blocker-sheet">
        <p className="steps-of">Before OpenBot can start</p>
        <h1>{screen.title}</h1>
        <p className="lede">{screen.why}</p>
        {screen.administrator ? (
          <ol className="blocker-steps">
            <li>
              {screen.administrator === "someone-else"
                ? "Ask an administrator to open PowerShell as an administrator: "
                : "Open PowerShell as an administrator: "}
              right-click the Start button and choose{" "}
              <strong>Terminal (Admin)</strong>.
            </li>
            {commands.length > 0 && (
              <li>
                {screen.administrator === "someone-else"
                  ? "Have them paste these commands and press Enter:"
                  : "Paste these commands and press Enter:"}
                <Command lines={commands} />
              </li>
            )}
            <li>
              Restart Windows, then open OpenBot again
              {screen.administrator === "someone-else"
                ? " from your own account."
                : "."}
            </li>
          </ol>
        ) : (
          <>
            <ol className="blocker-steps">
              <li>
                Restart and open the firmware settings (UEFI or BIOS). The key
                is usually F2, F10, F12 or Delete while the computer starts.
              </li>
              <li>
                Turn on <strong>Intel VT-x</strong> (Intel Virtualization
                Technology) or <strong>AMD-V</strong> (SVM Mode), then save and
                restart.
              </li>
              <li>Open OpenBot again.</li>
            </ol>
            <p className="footnote">
              In a virtual machine, turn on nested virtualization for it in the
              host's settings instead.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

/** Commands to run, one per line, copied as a whole: PowerShell runs a pasted block line by line. */
function Command({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join("\n");
  return (
    <div className="command">
      <pre>
        <code>{text}</code>
      </pre>
      <button
        type="button"
        className="quiet"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
