import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/** Settings → Skills is Skills in the main menu now. The panel's `new` and `edit` travel with it. */
export const Route = createFileRoute("/_authed/settings/skills")({
  validateSearch: z.object({
    new: z.boolean().optional(),
    edit: z.string().optional(),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/skills", search, replace: true });
  },
});
