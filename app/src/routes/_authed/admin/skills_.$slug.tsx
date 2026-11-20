import { createFileRoute } from "@tanstack/react-router";
import { SkillPage } from "@/components/manage/skill-page";

export const Route = createFileRoute("/_authed/admin/skills_/$slug")({
  component: function SkillRoute() {
    const { slug } = Route.useParams();
    return <SkillPage slug={slug} />;
  },
});
