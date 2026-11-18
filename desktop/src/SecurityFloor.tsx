import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { DOESNT_UPDATE_ITSELF } from "../../shared/desktop-updates";
import {
  SECURITY_FLOOR_ACTION,
  SECURITY_FLOOR_HEADING,
  SECURITY_FLOOR_LINE,
} from "../../shared/security-floor";
import { asProblem } from "./Problem";
import { type AppUpdate, describe } from "./UpdateOffer";

/**
 * What the shell says of the security floor (`security_floor.rs`): whether this version is below
 * it here. The shell decides, from the last floor it verified, and stops OpenBot on this computer
 * while it is. Connected to a company's own OpenBot, it never is.
 */
export type FloorStatus = { blocked: boolean };

/** The setup page's fragment the native side opens to show this screen alone. */
const SECURITY_FLOOR_HASH = "#security-floor";

export function isSecurityFloorPage(hash: string): boolean {
  return hash === SECURITY_FLOOR_HASH;
}

/** How often the window asks the shell again: a read of the shell's memory, not of the network. */
const ASK_EVERY_MS = 5_000;
const ASK_WHILE_INSTALLING_MS = 500;

/**
 * Whether the shell says this version is below the security floor: null until its first answer,
 * which is a read of memory and comes at once. A shell that can't answer says false.
 */
export function useBelowSecurityFloor(): boolean | null {
  const [blocked, setBlocked] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const status = await invoke<FloorStatus | null>("security_floor");
        if (current) setBlocked(status?.blocked === true);
      } catch {
        // A shell from before the floor has nothing to say.
        if (current) setBlocked((known) => known ?? false);
      }
      if (current) timer = setTimeout(ask, ASK_EVERY_MS);
    };
    void ask();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, []);
  return blocked;
}

/**
 * Everything the window shows, unless this version is below the security floor; then the notice
 * alone, in place of setup, Start and the update offer. Nothing is drawn before the shell's first
 * answer, so setup never starts behind a notice about to cover it.
 */
export function SecurityFloorGate({ children }: { children: ReactNode }) {
  const blocked = useBelowSecurityFloor();
  if (blocked === null) return null;
  return blocked ? <SecurityFloorNotice /> : children;
}

/**
 * The one screen below the security floor. OpenBot on this computer is stopped and nothing else can
 * be done here, so the only way on is Update and restart. A build that never updates itself says
 * how to get one that does.
 */
export function SecurityFloorNotice() {
  const [offer, setOffer] = useState<AppUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const found = await invoke<AppUpdate>("app_update_offer");
        if (current) setOffer(found);
      } catch {
        // Update and restart still asks the shell itself.
      }
      if (current)
        timer = setTimeout(
          ask,
          installing ? ASK_WHILE_INSTALLING_MS : ASK_EVERY_MS,
        );
    };
    void ask();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [installing]);

  const install = useCallback(async () => {
    setInstalling(true);
    setFailure(null);
    try {
      // Returns only when it failed: on success the app restarts into the new version.
      await invoke("install_app_update");
    } catch (error) {
      setInstalling(false);
      setFailure(asProblem(error).said);
    }
  }, []);

  const progress = offer?.installing ?? null;
  const busy = installing || progress !== null;
  const updatesItself = offer?.updatesItself !== false;
  return (
    <main>
      <div className="sheet connection-sheet">
        <h1>{SECURITY_FLOOR_HEADING}</h1>
        <p className="lede">{SECURITY_FLOOR_LINE}</p>
        {updatesItself ? (
          <div className="row">
            <button type="button" disabled={busy} onClick={install}>
              {busy ? describe(progress) : SECURITY_FLOOR_ACTION}
            </button>
          </div>
        ) : (
          <p>{DOESNT_UPDATE_ITSELF}</p>
        )}
        {failure && (
          <p className="caution" role="alert">
            OpenBot could not install the update: {failure}
          </p>
        )}
      </div>
    </main>
  );
}
