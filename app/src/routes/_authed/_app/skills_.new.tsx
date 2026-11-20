import { createFileRoute } from "@tanstack/react-router";
import { NewSkillPage } from "@/components/manage/new-skill-page";
import { personalOnly } from "@/lib/edition-guard";

/** The personal edition's form for a skill written for every Bot. The team edition writes one on Skills. */
export const Route = createFileRoute("/_authed/_app/skills_/new")({
  beforeLoad: personalOnly("/skills"),
  component: NewSkillPage,
});
