import { useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect } from "react";
import { postToShell, tabForPath } from "./bridge";
import { nativeShell } from "./shell";

/** `ready` goes once per page load, not once per mount (StrictMode mounts twice in development). */
let readySent = false;

/** For tests: let the next mount say `ready` again. */
export function forgetReadyForTests(): void {
  readySent = false;
}

/**
 * Tells the native shell the router is up, then where the page is after every navigation that
 * settled: the pathname, the shell's tab for it, and whether the page is behind the sign-in gate
 * (`/_authed`), which only a signed-in person reaches. Nothing outside the shell.
 *
 * Mounted once, at the root, so pages outside the gate (`/sign`) are told too.
 */
export function useNativeShellRouteReports(): void {
  const inShell = nativeShell() !== null;
  const settled = useRouterState({
    select: (state) =>
      state.status === "idle" && state.resolvedLocation
        ? `${state.matches.some((match) => match.routeId === "/_authed") ? "1" : "0"}${state.resolvedLocation.pathname}`
        : null,
  });

  // A layout effect, so `ready` goes before anything a page says from its own effects (`signed-out`).
  useLayoutEffect(() => {
    if (!inShell || readySent) return;
    readySent = true;
    postToShell({ type: "ready" });
  }, [inShell]);

  useEffect(() => {
    if (!inShell || settled === null) return;
    const path = settled.slice(1);
    postToShell({
      type: "route",
      path,
      tab: tabForPath(path),
      signedIn: settled.startsWith("1"),
    });
  }, [inShell, settled]);
}
