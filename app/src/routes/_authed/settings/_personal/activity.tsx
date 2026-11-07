import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AuditPage } from "@/components/manage/audit-page";

/** `bot` narrows the trail to one Bot, which is how a Bot's own Activity page links here. */
export const Route = createFileRoute("/_authed/settings/_personal/activity")({
  validateSearch: z.object({ bot: z.string().optional() }),
  component: ActivityPage,
});

function ActivityPage() {
  const { bot } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AuditPage
      bot={bot}
      onClearBot={() => navigate({ search: { bot: undefined } })}
    />
  );
}
