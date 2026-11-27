import { useEffect } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { postToShell } from "@/lib/native-shell/bridge";

/**
 * The sign-in page inside the phone app's native shell, which shows its own sign-in screen over the
 * web view: the shell is told nobody is signed in (`signed-out`), and the page shows only OpenBot's
 * orb on the plain ground, as it does while it starts. No buttons: a second way in under the shell's
 * would be one too many.
 *
 * Reached however the app ends up at `/sign`: opened signed out, a session that ran out (the
 * sign-in gate in `_authed.tsx` sends the next page here), or Sign out.
 */
export function NativeSignedOut() {
  useEffect(() => {
    postToShell({ type: "signed-out" });
  }, []);
  return (
    <div
      className="flex h-dvh w-full items-center justify-center"
      data-slot="native-signed-out"
    >
      <div aria-hidden="true">
        <AgentOrb size="56px" />
      </div>
    </div>
  );
}
