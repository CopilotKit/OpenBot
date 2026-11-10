import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
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

/**
 * What running a blocker's fix came to: Windows restarts before it counts, or it already does, or
 * the person said no to Windows' administrator prompt and nothing changed.
 */
type Fixed = "restart-needed" | "done" | "declined";

/** How long the line saying Windows will ask stays on screen before its prompt covers it. */
export const BEFORE_PROMPT_MS = 2500;
/** How long after a declined prompt OpenBot asks again by itself. */
export const ASK_AGAIN_MS = 15_000;

const DECLINED =
  "OpenBot needs Windows' permission to turn on a feature it needs. It asks again in a moment, or choose Try again.";

/*
 * Windows Subsystem for Linux is named here because it is the Windows feature the person turns on:
 * Windows calls it that in every window it shows about it.
 */
const WHY_WSL =
  "OpenBot needs a Windows feature called Windows Subsystem for Linux (WSL 2) to run.";

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
    fix?: { asks: string };
    administrator?: "you" | "someone-else";
  }
> = {
  "wsl-absent": {
    title: "Turn on Windows Subsystem for Linux",
    why: `${WHY_WSL} It's a one-time setup.`,
    fix: {
      asks: "Windows will ask for your permission so OpenBot can turn it on. Then Windows needs one restart.",
    },
    administrator: "you",
  },
  "wsl-one": {
    title: "Switch Windows Subsystem for Linux to version 2",
    why: "WSL is installed but set to version 1. OpenBot needs version 2.",
    fix: { asks: "OpenBot switches it now. This takes a few seconds." },
    administrator: "you",
  },
  "wsl-no-kernel": {
    title: "Finish installing Windows Subsystem for Linux",
    why: "WSL is turned on, but part of it is missing, so OpenBot can't run yet.",
    fix: {
      asks: "Windows will ask for your permission so OpenBot can finish setting it up. Then Windows needs one restart.",
    },
    administrator: "you",
  },
  "virtual-machine-platform-disabled": {
    title: "Turn on Virtual Machine Platform",
    why: "WSL 2 needs this Windows feature, and it is turned off.",
    fix: {
      asks: "Windows will ask for your permission so OpenBot can turn it on. Then Windows needs one restart.",
    },
    administrator: "you",
  },
  "not-administrator": {
    title: "An administrator needs to turn on WSL",
    why: `${WHY_WSL} Turning it on needs administrator rights, which this account does not have.`,
    fix: {
      asks: "Windows will ask for an administrator's name and password so OpenBot can turn it on. Then Windows needs one restart.",
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
 * No button first: the screen says what Windows will ask and why, leaves it a moment to be read,
 * and OpenBot runs the commands behind Windows's own administrator prompt by itself, then hands
 * over to the restart. An install step informs the person and moves forward (the product's call
 * for 1.0.1). A prompt the person says no to is said plainly and asked again by itself, with Try
 * again for now; only a failure asks for Try again alone. The commands are still here, for somebody
 * who would rather run them, or whose machine will not let OpenBot. They come from the native
 * side's instruction, which is what its tests hold to, in a block that copies whole, because nobody
 * should have to retype `dism.exe /online /enable-feature …` from a sentence.
 *
 * The restart after it is the one step that waits for a click (`WindowsRestart`): OpenBot never
 * restarts the computer on its own, because the person may have unsaved work open.
 */
export function WindowsBlocker({
  blocker,
  instruction,
  onRestartNeeded,
  onCleared = () => window.location.reload(),
  beforePromptMs = BEFORE_PROMPT_MS,
  askAgainMs = ASK_AGAIN_MS,
}: {
  blocker: Blocker;
  /** The native instruction; only the commands in it are shown. */
  instruction: string;
  /** The fix ran and Windows has to restart before it counts. */
  onRestartNeeded: () => void;
  /** The fix ran and nothing else is needed: check the machine again. */
  onCleared?: () => void;
  beforePromptMs?: number;
  askAgainMs?: number;
}) {
  const screen = SCREENS[blocker];
  const commands = commandsIn(instruction);
  const [fixing, setFixing] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [failure, setFailure] = useState<Problem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);

  async function fix() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (running.current) return;
    running.current = true;
    setFixing(true);
    setDeclined(false);
    setFailure(null);
    try {
      const fixed = await invoke<Fixed>("windows_fix", { blocker });
      if (fixed === "restart-needed") onRestartNeeded();
      else if (fixed === "declined") {
        // Said plainly, and asked again by itself after a while.
        setDeclined(true);
        timer.current = setTimeout(() => void fix(), askAgainMs);
      } else onCleared();
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      running.current = false;
      setFixing(false);
    }
  }
  const fixLatest = useRef(fix);
  fixLatest.current = fix;

  // Starts by itself, once the line saying what Windows will ask has had a moment on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per blocker.
  useEffect(() => {
    if (!screen.fix) return;
    timer.current = setTimeout(() => void fixLatest.current(), beforePromptMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [blocker]);

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
      <li>Start OpenBot again.</li>
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
            {!declined && !failure && (
              <StatusLine>
                {fixing
                  ? "Setting up Windows. Approve the Windows prompt when it asks. This can take a few minutes."
                  : "Getting ready to set up Windows…"}
              </StatusLine>
            )}
            {declined && (
              <p className="caution" role="status">
                {DECLINED}
              </p>
            )}
            {failure && <Failure problem={failure} />}
            {/* Only after a prompt said no or a failure: never a gate before the prompt. */}
            {(declined || failure) && (
              <div className="row">
                <button type="button" disabled={fixing} onClick={() => fix()}>
                  Try again
                </button>
              </div>
            )}
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
export function Command({ lines }: { lines: string[] }) {
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
