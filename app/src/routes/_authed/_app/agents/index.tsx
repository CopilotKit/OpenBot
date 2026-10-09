import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { legacyAgentsTarget } from "@/lib/agents/legacy-routes";

/** `/agents` was the coworker screen. The Bots roster and each Bot's own page replaced it. */
export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: z.object({
    new: z.boolean().optional(),
    agent: z.string().optional(),
  }),
  beforeLoad: ({ search }) => {
    throw redirect(legacyAgentsTarget(search));
  },
});
