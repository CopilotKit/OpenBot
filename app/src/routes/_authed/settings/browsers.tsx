import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The browsers signed in to the Recorder are a section of Settings → Computer now. Kept for links
 * and bookmarks made before.
 */
export const Route = createFileRoute("/_authed/settings/browsers")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/computer", replace: true });
  },
});
