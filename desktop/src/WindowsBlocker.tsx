import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { asProblem, Failure, type Problem } from "./Problem";
import { StatusLine } from "./SetupProgress";

export type Blocker =
  | "wsl-absent"
  | "wsl-one"
  | "wsl-no-kernel"
  | "virtual-machine-platform-disabled"
  | "virtualization-disabled"
  | "nested-virtualization-unavailable"
  | "not-administrator";

/** What running a blocker's fix came to: Windows restarts before it counts, or it already does. */
type Fixed = "restart-needed" | "done";

const WHY_WSL =
  "OpenBot runs its services in Linux containers. On Windows, those need Windows Subsystem for Linux (WSL 2).";

/**
 * What each blocker is called, why it matters, and how OpenBot clears it.
 *
 * `fix` is the button: what it says, and what Windows will ask on the way. Firmware has none,
 * because nothing running in Windows can change it.
 */
const SCREENS: Record<
  Blocker,
  {
    title: string;
    why: string;
    fix?: { action: string; asks: string };
    administrator?: "you" | "someone-else";
  }
> = {
  "wsl-absent": {
    title: "Turn on Windows Subsystem for Linux",
    why: `${WHY_WSL} It's a one-time setup.`,
    fix: {
      action: "Set up Windows",
      asks: "Windows will ask for permission, then needs one restart.",
    },
    administrator: "you",
  },
  "wsl-one": {
    title: "Switch Windows Subsystem for Linux to version 2",
    why: "WSL is installed but set to version 1. OpenBot's containers need version 2.",
    fix: { action: "Switch to WSL 2", asks: "This takes a few seconds." },
    administrator: "you",
  },
  "wsl-no-kernel": {
    title: "Finish installing Windows Subsystem for Linux",
    why: "WSL is turned on, but its Linux kernel is missing, so nothing can run in it yet.",
    fix: {
      action: "Finish setting up WSL",
      asks: "Windows will ask for permission, then needs one restart.",
    },
    administrator: "you",
  },
  "virtual-machine-platform-disabled": {
    title: "Turn on Virtual Machine Platform",
    why: "WSL 2 needs this Windows feature, and it is turned off.",
    fix: {
      action: "Set up Windows",
      asks: "Windows will ask for permission, then needs one restart.",
    },
    administrator: "you",
  },
  "not-administrator": {
    title: "An administrator needs to turn on WSL",
    why: `${WHY_WSL} Turning it on needs administrator rights, which this account does not have.`,
    fix: {
      action: "Set up Windows",
      asks: "Windows will ask for an administrator's name and password, then needs one restart.",
    },
    administrator: "someone-else",
  },
  "virtualization-disabled": {
    title: "Turn on virtualization",
    why: "WSL 2 runs a small virtual machine, and virtualization is turned off in this computer's firmware. OpenBot cannot change that setting.",
  },
  "nested-virtualization-unavailable": {
    title: "Turn on nested virtualization",
    why: "This Windows runs in a virtual machine, and its host does not pass virtualization through to it. WSL 2 needs it to run, and nothing inside this virtual machine can turn it on.",
  },
};

/** The commands the native instruction names, in order: each one sits in backticks there. */
export function commandsIn(instruction: string): string[] {
  return [...instruction.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/**
 * The screen for a Windows machine that cannot run OpenBot yet, and what to do about it.
 *
 * One button does it: OpenBot runs the commands behind Windows's own administrator prompt, then
 * hands over to the restart. The commands are still here, under the button, for somebody who would
 * rather run them, or whose machine will not let OpenBot. They come from the native side's
 * instruction, which is what its tests hold to, in a block that copies whole, because nobody
 * should have to retype `dism.exe /online /enable-feature …` from a sentence.
 */
export function WindowsBlocker({
  blocker,
  instruction,
  onRestartNeeded,
  onCleared = () => window.location.reload(),
}: {
  blocker: Blocker;
  /** The native instruction; only the commands in it are shown. */
  instruction: string;
  /** The fix ran and Windows has to restart before it counts. */
  onRestartNeeded: () => void;
  /** The fix ran and nothing else is needed: check the machine again. */
  onCleared?: () => void;
}) {
  const screen = SCREENS[blocker];
  const commands = commandsIn(instruction);
  const [fixing, setFixing] = useState(false);
  const [failure, setFailure] = useState<Problem | null>(null);

  async function fix() {
    setFixing(true);
    setFailure(null);
    try {
      const fixed = await invoke<Fixed>("windows_fix", { blocker });
      if (fixed === "restart-needed") onRestartNeeded();
      else onCleared();
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setFixing(false);
    }
  }

  const steps = screen.administrator ? (
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
  ) : blocker === "nested-virtualization-unavailable" ? (
    <ol className="blocker-steps">
      <li>Shut down this virtual machine.</li>
      <li>
        In the virtual machine app on the host, turn on nested virtualization
        for it. In Hyper-V, run{" "}
        <code>
          Set-VMProcessor -VMName &lt;name&gt; -ExposeVirtualizationExtensions
          $true
        </code>
        ; in VMware, <strong>Enable hypervisor applications</strong>; in
        Parallels, <strong>Enable nested virtualization</strong>. In the cloud,
        choose a size that supports it.
      </li>
      <li>Start the virtual machine, then open OpenBot again.</li>
    </ol>
  ) : (
    <ol className="blocker-steps">
      <li>
        Restart and open the firmware settings (UEFI or BIOS). The key is
        usually F2, F10, F12 or Delete while the computer starts.
      </li>
      <li>
        Turn on <strong>Intel VT-x</strong> (Intel Virtualization Technology) or{" "}
        <strong>AMD-V</strong> (SVM Mode), then save and restart.
      </li>
      <li>Open OpenBot again.</li>
    </ol>
  );

  return (
    <main>
      <div className="sheet blocker-sheet">
        <p className="steps-of">Before OpenBot can start</p>
        <h1>{screen.title}</h1>
        <p className="lede">{screen.why}</p>
        {screen.fix ? (
          <>
            <p className="blocker-asks">{screen.fix.asks}</p>
            {fixing && (
              <StatusLine>
                Setting up Windows. Approve the Windows prompt if it asks; this
                can take a few minutes.
              </StatusLine>
            )}
            {failure && <Failure problem={failure} />}
            <div className="row">
              <button type="button" disabled={fixing} onClick={fix}>
                {screen.fix.action}
              </button>
            </div>
            <details className="blocker-manual">
              <summary>Or run the commands yourself</summary>
              {steps}
            </details>
          </>
        ) : (
          <>
            {steps}
            <p className="footnote">
              {blocker === "nested-virtualization-unavailable"
                ? "Windows on a Mac with Apple silicon cannot do this in any virtual machine app. Use a Windows PC, or an x64 cloud virtual machine whose size supports nested virtualization."
                : "In a virtual machine, turn on nested virtualization for it in the host's settings instead."}
            </p>
          </>
        )}
      </div>
    </main>
  );
}

/**
 * After a fix that only counts once Windows restarts: say so, and offer to do it.
 *
 * Also what OpenBot opens on while that restart is still owed, so a feature that reads as on but is
 * not running yet never lets setup carry on into a Docker that cannot start.
 */
export function WindowsRestart() {
  const [restarting, setRestarting] = useState(false);
  const [failure, setFailure] = useState<Problem | null>(null);
  return (
    <main>
      <div className="sheet blocker-sheet">
        <p className="steps-of">Before OpenBot can start</p>
        <h1>Restart Windows to finish</h1>
        <p className="lede">
          Windows Subsystem for Linux is set up. Windows needs to restart before
          OpenBot can use it. OpenBot opens again after you sign back in.
        </p>
        {restarting && <StatusLine>Restarting Windows…</StatusLine>}
        {failure && <Failure problem={failure} />}
        <div className="row">
          <button
            type="button"
            disabled={restarting}
            onClick={async () => {
              setRestarting(true);
              setFailure(null);
              try {
                await invoke("windows_restart");
              } catch (error) {
                setFailure(asProblem(error));
                setRestarting(false);
              }
            }}
          >
            Restart now
          </button>
        </div>
        <p className="footnote">
          Save your work in other apps first. To restart later, use the Start
          menu, then open OpenBot.
        </p>
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
