import { createFileRoute } from "@tanstack/react-router";
import { NewSkillPage } from "@/components/manage/new-skill-page";

export const Route = createFileRoute("/_authed/settings/_personal/skills_/new")(
  {
    component: NewSkillPage,
  },
);
