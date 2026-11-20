import { createFileRoute } from "@tanstack/react-router";
import { SkillsPage } from "@/components/manage/skills-page";

export const Route = createFileRoute("/_authed/admin/skills")({
  component: SkillsPage,
});
