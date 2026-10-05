import {
  createRootRouteWithContext,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RouterContext } from "../router-context";
import "@fontsource-variable/inter/wght.css";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  /*
   * An address this build does not know goes home rather than to a dead end. Home sits behind the
   * auth gate, so the guard decides what that means: /sign for a visitor, /onboarding for somebody
   * who has not finished it, the app for everyone else.
   */
  notFoundComponent: () => <Navigate replace to="/" />,
});

/**
 * A FILE DROPPED ON A PART OF THIS APP THAT WANTED NO FILE DOES NOT UNLOAD THIS APP.
 *
 * The browser's default for a file dropped on a document is to NAVIGATE THE TOP-LEVEL DOCUMENT TO
 * THAT FILE. Not "ignore it" — replace the page with it. The single-page app unloads and everything
 * held in memory goes with it: the sentence somebody was typing, the parked queue on a channel
 * (whose teardown effect in `conversation-view.tsx` never runs, because the document is REPLACED
 * rather than unmounted, so the rows behind those parked messages stay orphaned until the 24-hour
 * sweep), every open dialog, the socket. The person sees their raw PNG on a blank page and presses
 * Back. Nothing in the app has to be wrong for this to happen; it is what a browser does when
 * nobody claims a drop.
 *
 * WHY THE ROOT, AND NOT EACH SURFACE THAT MIGHT BE AIMED AT. The composer already guards its own
 * form — see `refuseDragOver` in `composer.tsx` — and that comment argued, correctly, that the
 * app-wide guard could not be installed by a leaf: several composers can be mounted at once, so a
 * `document` listener owned by one of them would be installed once per composer and torn down by
 * whichever unmounted first. The leaf approach also cannot reach every surface even in principle.
 * The onboarding poster (`_authed/onboarding.tsx`) wraps its decorative composer in
 * `pointer-events-none` on purpose, so that composer can never receive a drop at all: the event
 * goes straight past it to the document. So do the transcript, the sidebar, the page margin, and
 * every screen that will ever be added without thinking about drag and drop. The root is the one
 * place where "once" is a fact rather than a hope: `RootComponent` mounts once per app.
 *
 * WHAT MAKES THIS SAFE TO INSTALL APP-WIDE — `defaultPrevented` IS NOT A HEURISTIC, IT IS THE
 * BROWSER'S OWN PREDICATE. An element becomes a drop target only by calling `preventDefault` on
 * `dragover`; a handler that does not do that has already declined the drop as far as the browser
 * is concerned. This listener is on `document` in the BUBBLE phase, so it runs after every handler
 * in the tree has had the event, and it acts only on an event nobody prevented. A future drop
 * target therefore cannot be swallowed by this: the very line it must write to work at all is the
 * line that makes this guard stand down. Capture phase would be the opposite and would break every
 * drop in the app, which is why the phase is load-bearing rather than incidental.
 *
 * `dropEffect = "none"` ON THE UNCLAIMED `dragover`, for the reason `refuseDragOver` records: a
 * prevented `dragover` left at its default effect draws the copy-badge cursor, promising to accept
 * a file that is about to be dropped into nothing. "none" is the no-entry cursor and it is the only
 * part of this refusal the person sees before they let go.
 *
 * THIS IS A FLOOR, NOT AN ANSWER. Refusing the drop is all it does — nothing is said, because at
 * this level there is nothing true to say: the guard does not know what the person was aiming at.
 * A surface that wants to explain itself claims the drop and writes its own sentence, which is what
 * the composer does with `RejectedFiles`. Silence about a file nobody can place is a poorer outcome
 * than an explanation and a far better one than losing the page.
 *
 * Exported for `app/tests/root-drop-guard.test.tsx`, which mounts it on its own rather than
 * standing up a router.
 */
export function useUnclaimedDropGuard() {
  useEffect(() => {
    const refuse = (event: DragEvent) => {
      // Somebody in the tree already claimed it: the composer's container, or any drop target
      // added later. Returning here is what keeps this guard from becoming the thing that breaks
      // them.
      if (event.defaultPrevented) {
        return;
      }
      /*
       * FILES ONLY, AND THIS NARROWING IS THE DIFFERENCE BETWEEN A FLOOR AND A WRECKING BALL.
       *
       * An editable element — a text input, or the composer's own contenteditable editor — is a
       * drop target the BROWSER makes, with no script calling `preventDefault` anywhere. So a
       * guard that refused every unclaimed drop would refuse dragging a selected phrase into the
       * message box, which is a gesture people use and which nothing in this app would have been
       * left to re-implement.
       *
       * `types` carrying "Files" is how a drag says it holds files rather than text, and it is set
       * on `dragover` as well as on `drop` — the browser deliberately exposes the kinds before it
       * exposes the contents. A file is also the only payload worth this guard: dropping one is
       * what unloads the app.
       *
       * THE LIMIT THIS LEAVES, NAMED RATHER THAN HIDDEN. A LINK dragged out of another tab and let
       * go on the page margin still navigates, because its drag carries no file and refusing it
       * here would also refuse dropping that link into the editor as text. Files are the case that
       * costs somebody their unsent message; a dragged link is deliberate and rare.
       */
      if (!event.dataTransfer?.types.includes("Files")) {
        return;
      }
      event.preventDefault();
      if (event.type === "dragover") {
        event.dataTransfer.dropEffect = "none";
      }
    };
    /*
     * Both, and both are needed. `dragover` is what stops the browser treating the document as a
     * plain navigation target and is what fixes the cursor; `drop` is the event that actually
     * carries the file, and a browser that never saw a prevented `dragover` — a drop that arrived
     * some other way, or a `dragover` an extension stopped — would still navigate on it.
     */
    document.addEventListener("dragover", refuse);
    document.addEventListener("drop", refuse);
    return () => {
      document.removeEventListener("dragover", refuse);
      document.removeEventListener("drop", refuse);
    };
  }, []);
}

function RootComponent() {
  useUnclaimedDropGuard();
  return (
    <div className="min-h-dvh w-full antialiased">
      <ThemeProvider>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </ThemeProvider>
    </div>
  );
}
