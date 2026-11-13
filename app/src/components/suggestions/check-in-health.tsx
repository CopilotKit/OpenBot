import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  changeProactiveSettingMutationOptions,
  type ProactiveSetting,
} from "@/lib/proactive";
import { queryClient } from "@/query-client";

/**
 * The one step that fixes a check-in that can't look (`CheckInHealth`), as a button: connect an app,
 * open that app's page or the check-in's own, or remove a check-in whose Bot is gone.
 *
 * `onRemove` replaces the removal where the screen asks first (the check-in's own page); `onPage` is
 * set on that page, where "Open check-in" would open the page it is on, so that button is left out.
 */
export function CheckInHealthFix({
  setting,
  onRemove,
  onPage = false,
}: {
  setting: Pick<ProactiveSetting, "id" | "enabled" | "health">;
  onRemove?: () => void;
  onPage?: boolean;
}) {
  const change = useMutation(
    changeProactiveSettingMutationOptions(queryClient),
  );
  const health = setting.health;
  if (!health) return null;
  const app = health.app;
  if (health.fix === "remove")
    return (
      <Button
        disabled={change.isPending}
        onClick={() =>
          onRemove
            ? onRemove()
            : change.mutate({ setting, change: { kind: "remove" } })
        }
        size="sm"
        variant="outline"
      >
        {change.isPending ? "Removing…" : "Remove check-in"}
      </Button>
    );
  if (app)
    return (
      <Button
        render={<Link params={{ key: app.serverId }} to="/connections/$key" />}
        size="sm"
        variant="outline"
      >
        {health.fix === "connect"
          ? `Connect ${app.title}`
          : `Open ${app.title}`}
      </Button>
    );
  if (health.fix === "connect")
    return (
      <Button render={<Link to="/connections" />} size="sm" variant="outline">
        Connect an app
      </Button>
    );
  if (onPage) return null;
  return (
    <Button
      render={
        <Link
          params={{ checkInId: setting.id }}
          to="/routines/check-ins/$checkInId"
        />
      }
      size="sm"
      variant="outline"
    >
      Open check-in
    </Button>
  );
}
