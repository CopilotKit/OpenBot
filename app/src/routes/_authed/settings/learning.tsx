import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Learning is part of Settings → Skills now: learned skills are rows of Your skills, with their
 * sharing choice, and what waits for review is its own section there.
 */
export const Route = createFileRoute("/_authed/settings/learning")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/skills", replace: true });
  },
});
