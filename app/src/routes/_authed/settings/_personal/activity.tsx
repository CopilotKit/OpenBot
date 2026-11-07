import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { z } from "zod";
import { AuditPage } from "@/components/manage/audit-page";

/** `bot` narrows the trail to one Bot, which is how a Bot's own Activity page links here. */
export const Route = createFileRoute("/_authed/settings/_personal/activity")({
  validateSearch: z.object({ bot: z.string().optional() }),
  component: ActivityPage,
});

/**
 * Read without `strict`, so the page also renders where it is mounted on a route of another name,
 * as the audit tests do. The route's own `validateSearch` has already checked it.
 */
function ActivityPage() {
  const { bot } = useSearch({ strict: false }) as { bot?: string };
  const navigate = useNavigate();
  return (
    <AuditPage
      bot={bot}
      description="See what your Bots did, and which of their actions were allowed, blocked or didn't happen."
      onClearBot={() => navigate({ to: "/settings/activity" })}
    />
  );
}
