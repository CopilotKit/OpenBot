import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/**
 * `/skills` moved to Settings → Skills. Kept as a redirect because a skill proposed in a conversation links
 * to it, and those messages stay in people's history. The panel's `new` and `edit` travel with it.
 */
export const Route = createFileRoute("/_authed/_app/skills")({
  validateSearch: z.object({
    new: z.boolean().optional(),
    edit: z.string().optional(),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/skills", search, replace: true });
  },
});
