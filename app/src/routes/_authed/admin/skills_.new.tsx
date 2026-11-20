import { createFileRoute } from "@tanstack/react-router";
import { NewSkillPage } from "@/components/manage/new-skill-page";

export const Route = createFileRoute("/_authed/admin/skills_/new")({
  component: NewSkillPage,
});
