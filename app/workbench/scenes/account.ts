import type { AppScene, Session } from "../../../desktop/workbench/appContract";
import { connectedAnswers } from "../pageDefaults";
import { DEFAULT_SESSION, SAM } from "../session";

const ADDRESS = "https://openbot.example.com";

/** DEFAULT_SESSION is typed as any Session, so the signed-in fields are written out here. */
const NOT_ONBOARDED = {
  signedIn: true,
  role: "member",
  name: SAM.name,
  email: SAM.email,
  organization: { id: "default", name: "Acme" },
  onboarded: false,
} satisfies Session;

export const ACCOUNT_SCENES: readonly AppScene[] = [
  {
    kind: "app",
    id: "app-onboarding",
    title: "First open after an install",
    group: "App: Account",
    // A person whose onboarding has no completedAt: the `_authed` gate (needsOnboarding) sends
    // every route to /onboarding.
    start: {
      route: "/",
      host: "desktop",
      session: NOT_ONBOARDED,
    },
  },
  {
    kind: "app",
    id: "app-signed-out",
    title: "Signed out",
    group: "App: Account",
    // No person: the `_authed` gate redirects to /sign. The window runs here (local), so the
    // gate does not ask OpenBot Desktop to sign out first.
    start: { route: "/", host: "desktop", session: { signedIn: false } },
  },
  {
    kind: "app",
    id: "app-connection-lost",
    title: "The connection to OpenBot is lost",
    group: "App: Account",
    start: {
      route: "/",
      host: "desktop",
      session: DEFAULT_SESSION,
      answers: connectedAnswers(ADDRESS),
    },
    /*
     * Follows lib/desktop/reachability.ts, lib/desktop/connection-lost.ts and
     * components/layout/connection-banner.tsx:
     * - a fetch that rejects (the "offline" answer) marks OpenBot unreachable, and in connected
     *   mode the connection line shows and the reads wait;
     * - while the line shows, the banner asks for the deployment 5 s after it appears, then 10 s
     *   later, and so on (FIRST_CHECK_MS, doubling). The first answered request clears the line.
     * The line appears at 2 s: a read that polls (people/me/browser) goes out then and fails, and
     * the requests of /settings at 3 s fail too. So the first check is 5 s later (the shots show it
     * between 7 and 8.5 s), and the second would be about 10 s after that, too late for the end
     * at 13. The answer goes away at 6.5 s, after the line has shown for a while and before the
     * first check, which clears it.
     * The spec's time for this step was 9; with the banner's 5 s and 10 s checks, 9 would keep
     * the line past 13.
     */
    run: [
      { at: 2, api: "ALL /api/*", with: { mode: "offline" } },
      { at: 3, navigate: "/settings" },
      { at: 6.5, api: "ALL /api/*", with: null },
      // The same route again: it changes nothing, and a scene ends at its last step, so the end
      // is 13, when the reads have filled in again.
      { at: 13, navigate: "/settings" },
    ],
  },
];
