import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink } from "./ExternalLink";
import { asProblem, type Problem } from "./Problem";
import { StatusLine } from "./SetupProgress";

/**
 * What the screen offers after something went wrong, chosen by the problem's `kind`. The sentence
 * is the shell's, shown as given.
 *
 * `field`: the address is what to fix, so the sentence sits under the field and the field has the
 * focus. `sign-in` and `retry`: the screen's one button says Sign in again or Try again. `browser`:
 * this app can't connect to that OpenBot, and a link opens it in the browser. A kind this app does
 * not know is offered Try again.
 */
type Offer = "field" | "retry" | "sign-in" | "browser";

function offerFor(kind: string | null | undefined): Offer {
  switch (kind) {
    case "address-invalid":
    case "not-openbot":
    case "single-person":
      return "field";
    case "too-old":
      return "browser";
    case "sign-in-cancelled":
    case "sign-in-failed":
    case "session-ended":
      return "sign-in";
    default:
      return "retry";
  }
}

/** The typed address as a link the browser can open. The shell takes no scheme as https too. */
function browserAddress(address: string) {
  const typed = address.trim();
  return /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
}

type Phase = "idle" | "checking" | "waiting" | "opening" | "leaving";

/** What went wrong, and what the screen offers for it. `null` offers nothing of its own. */
type Trouble = { problem: Problem; offer: Offer | null };

export type Connecting = ReturnType<typeof useConnectToOpenBot>;

/**
 * Connecting this app to an OpenBot that runs elsewhere: the address, the sign-in in the person's
 * browser, and what went wrong. Held by the first screen, above the choice of where OpenBot runs,
 * so an address typed is still there after a look at the other choice.
 *
 * The shell does the work. `check_openbot_address` says whether there is an OpenBot this app can
 * connect to at the address, and gives it back as it understood it. `connect_to_openbot` opens the
 * browser, waits for the sign-in and then shows that OpenBot in this window. Nothing is installed
 * or started on this computer.
 */
export function useConnectToOpenBot({
  address: remembered = "",
  problem: found = null,
  reopen,
  onThisComputer,
}: {
  /** The address connected to before, when there is one. */
  address?: string;
  /** What the launch found: a sign-in that ended, or an OpenBot it could not open. */
  problem?: Problem | null;
  /**
   * Opens OpenBot with the sign-in this computer already has. Given when the launch tried that and
   * it failed: Try again does it again, without a new sign-in, while the address is the same.
   */
  reopen?: () => Promise<void>;
  /** Back to OpenBot on this computer. May fail, when a saved connection has to be switched. */
  onThisComputer: () => void | Promise<void>;
}) {
  const [address, setAddress] = useState(remembered);
  const [phase, setPhase] = useState<Phase>("idle");
  const [trouble, setTrouble] = useState<Trouble | null>(
    found ? { problem: found, offer: offerFor(found.kind) } : null,
  );
  const [reopens, setReopens] = useState(Boolean(reopen));
  // Each go at connecting: one that was cancelled or left behind says nothing when it ends.
  const attempt = useRef(0);
  const waiting = useRef(false);
  const alive = useRef(true);
  const field = useRef<HTMLInputElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  // Where the focus goes once the form is back: it was on a control that was disabled meanwhile.
  const [focus, setFocus] = useState<{ on: "field" | "action" } | null>(null);
  useEffect(() => {
    if (!focus) return;
    (focus.on === "field" ? field : action).current?.focus();
  }, [focus]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Leaving the screen while the browser is waited on stops that sign-in.
      if (waiting.current) {
        waiting.current = false;
        invoke("cancel_connect").catch(() => {});
      }
    };
  }, []);

  async function submit() {
    const typed = address.trim();
    if (!typed || phase !== "idle") return;
    attempt.current += 1;
    const mine = attempt.current;
    const current = () => alive.current && attempt.current === mine;
    setTrouble(null);
    try {
      if (reopens && reopen) {
        setPhase("opening");
        await reopen();
        return;
      }
      setPhase("checking");
      const checked = await invoke<{ address: string }>(
        "check_openbot_address",
        { address: typed },
      );
      if (!current()) return;
      setAddress(checked.address);
      setPhase("waiting");
      waiting.current = true;
      await invoke("connect_to_openbot", { address: checked.address });
      if (!current()) return;
      waiting.current = false;
      // Signed in: the shell is showing that OpenBot in this window.
      setPhase("opening");
    } catch (error) {
      if (!current()) return;
      waiting.current = false;
      const problem = asProblem(error);
      const offer = offerFor(problem.kind);
      setTrouble({ problem, offer });
      // Only Try again opens it with the sign-in this computer has: any other way on signs in anew.
      if (offer !== "retry") setReopens(false);
      setPhase("idle");
      // To the field when the address is what to fix, to the button when it is the way on.
      if (offer !== "browser")
        setFocus({ on: offer === "field" ? "field" : "action" });
    }
  }

  /** Stops the sign-in the browser is waited on for. The person chose it, so nothing is said. */
  async function cancel() {
    attempt.current += 1;
    waiting.current = false;
    setPhase("idle");
    setFocus({ on: "field" });
    await invoke("cancel_connect").catch(() => {});
  }

  async function leave() {
    if (phase !== "idle") return;
    setTrouble(null);
    setPhase("leaving");
    try {
      await onThisComputer();
    } catch (error) {
      if (alive.current) setTrouble({ problem: asProblem(error), offer: null });
    } finally {
      if (alive.current) setPhase("idle");
    }
  }

  return {
    address,
    phase,
    trouble,
    busy: phase !== "idle",
    field,
    action,
    /** A sentence about the address, or about opening it, is not about the next one typed. */
    change(next: string) {
      setAddress(next);
      setTrouble(null);
      setReopens(false);
    },
    submit,
    cancel,
    leave,
  };
}

/**
 * The first screen's lower half when OpenBot runs elsewhere: one field for its address, what
 * happens next, and Connect. While the browser is waited on, Cancel is the only control.
 */
export function ConnectToOpenBot({ connecting }: { connecting: Connecting }) {
  const id = useId();
  const { address, phase, trouble, busy } = connecting;
  const underField = trouble?.offer === "field";
  return (
    <form
      className="connect-to-openbot"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void connecting.submit();
      }}
    >
      <div className="field">
        <label htmlFor={`${id}-address`}>OpenBot address</label>
        <input
          id={`${id}-address`}
          ref={connecting.field}
          // Not `url`: an address with no scheme is fine, and the shell says what is wrong with one.
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://openbot.example.com"
          value={address}
          // Held, not greyed out: the address being signed in to stays readable while it waits.
          readOnly={busy}
          aria-invalid={underField || undefined}
          aria-describedby={underField ? `${id}-problem` : `${id}-next`}
          onChange={(event) => connecting.change(event.target.value)}
        />
        {trouble && underField && (
          <p
            id={`${id}-problem`}
            className="inline-error address-problem"
            role="alert"
          >
            {trouble.problem.said}
          </p>
        )}
      </div>
      {phase === "waiting" ? (
        <>
          <StatusLine>Finish signing in in your browser.</StatusLine>
          <div className="row">
            <button
              type="button"
              className="quiet"
              onClick={() => void connecting.cancel()}
            >
              Cancel
            </button>
          </div>
        </>
      ) : phase === "opening" ? (
        <StatusLine>Opening OpenBot…</StatusLine>
      ) : (
        <>
          <p id={`${id}-next`} className="footnote">
            You'll sign in to it in your browser. Nothing is installed on this
            computer.
          </p>
          {trouble && !underField && <Trouble trouble={trouble} />}
          <div className="row">
            <button
              type="submit"
              ref={connecting.action}
              disabled={busy || !address.trim()}
            >
              {trouble?.offer === "sign-in"
                ? "Sign in again"
                : trouble?.offer === "retry"
                  ? "Try again"
                  : "Connect"}
            </button>
            {trouble?.offer === "browser" && address.trim() && (
              <ExternalLink
                className="button-link"
                href={browserAddress(address)}
              >
                Open in browser
              </ExternalLink>
            )}
          </div>
          {phase === "checking" && (
            <StatusLine>Checking the address…</StatusLine>
          )}
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => void connecting.leave()}
          >
            Use OpenBot on this computer instead
          </button>
        </>
      )}
    </form>
  );
}

/**
 * The sentence, in a calm notice: the card that waits on the person. A connection that didn't work
 * is not a failed install, so it is not drawn as one: no failure heading and no troubleshooting
 * logs, which are about OpenBot on this computer. The way on is the screen's button, or the link
 * beside it when that OpenBot can only be opened in the browser.
 */
function Trouble({ trouble }: { trouble: Trouble }) {
  return (
    <div className="local-alert needs" role="alert">
      <p>{trouble.problem.said}</p>
    </div>
  );
}
