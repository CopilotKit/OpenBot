import { createFileRoute, redirect } from "@tanstack/react-router";

/** The form for a skill written for every Bot is under Skills now, in the main menu. */
export const Route = createFileRoute("/_authed/settings/_personal/skills_/new")(
  {
    beforeLoad: () => {
      throw redirect({ to: "/skills/new", replace: true });
    },
  },
);
