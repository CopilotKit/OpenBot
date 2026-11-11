import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/** Capabilities → Skills is Skills now. The panel's `new` and `edit` travel with it. */
export const Route = createFileRoute("/_authed/_app/capabilities/skills")({
  validateSearch: z.object({
    new: z.boolean().optional(),
    edit: z.string().optional(),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/skills", search, replace: true });
  },
});
