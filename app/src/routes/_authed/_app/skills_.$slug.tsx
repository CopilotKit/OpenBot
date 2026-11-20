import { createFileRoute } from "@tanstack/react-router";
import { SkillPage } from "@/components/manage/skill-page";
import { personalOnly } from "@/lib/edition-guard";

/** The personal edition's page for a skill written for every Bot, with a switch per Bot. */
export const Route = createFileRoute("/_authed/_app/skills_/$slug")({
  beforeLoad: personalOnly("/skills"),
  component: function SkillRoute() {
    const { slug } = Route.useParams();
    return <SkillPage slug={slug} />;
  },
});
