import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { legacyAgentsTarget } from "@/lib/agents/legacy-routes";

/**
 * OpenBot has no Agents page: a person has Bots. The address stays for old links: `/agents` goes to
 * the Bots, `/agents?new` to New Bot and `/agents?agent=<id>` to that Bot's page.
 */
export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: z.object({
    new: z.boolean().optional(),
    agent: z.string().optional(),
  }),
  beforeLoad: ({ search }) => {
    throw redirect(legacyAgentsTarget(search));
  },
});
