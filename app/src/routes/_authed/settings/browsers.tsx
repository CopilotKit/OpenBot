import { createFileRoute, redirect } from "@tanstack/react-router";
import { COMPUTER_SECTION } from "@/lib/settings/computer-sections";

/**
 * The browsers signed in to the Recorder are a section of Settings → Computer now. Kept for links
 * and bookmarks made before, and for browser extensions from before their popup opened
 * `/settings/computer#browsers` itself.
 */
export const Route = createFileRoute("/_authed/settings/browsers")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings/computer",
      hash: COMPUTER_SECTION.browsers,
      replace: true,
    });
  },
});
