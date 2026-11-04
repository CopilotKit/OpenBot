import { createFileRoute } from "@tanstack/react-router";
import { ComputersPage } from "@/components/manage/computers-page";

export const Route = createFileRoute("/_authed/settings/_personal/computer")({
  component: ComputersPage,
});
