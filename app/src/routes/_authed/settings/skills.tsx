import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SkillsSettingsPage } from "@/components/skills/skills-settings-page";

/**
 * Settings → Skills, the every-Bot page of Skills, in both editions. See `SkillsSettingsPage`.
 *
 * Writing a skill is a search parameter rather than a route, so the list stays on screen behind the
 * panel and the form is linkable, reloadable, and closed by Back. `/settings/skills/new` and
 * `/settings/skills/$slug` stay, as the personal edition's pages for a skill written for every Bot.
 */
const skillsSearchSchema = z.object({
  new: z.boolean().optional(),
  /** The slug being edited. Absent means nothing is. */
  edit: z.string().optional(),
});

export const Route = createFileRoute("/_authed/settings/skills")({
  validateSearch: skillsSearchSchema,
  component: SkillsRoute,
});

function SkillsRoute() {
  const { new: creating, edit } = Route.useSearch();
  return <SkillsSettingsPage creating={creating === true} editing={edit} />;
}
