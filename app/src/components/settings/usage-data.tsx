import { IconChartBar } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { setUsageDataMutationOptions } from "@/lib/desktop/mutations";
import { desktopUsageDataQueryOptions } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";

/** What OpenBot Desktop sends, and what it never does, in full. */
export const USAGE_DATA_DOC =
  "https://github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md";

/**
 * Settings → General's Share usage data: the opt-out that otherwise needs an environment variable,
 * as one switch. Off stops the desktop app's own usage data and the CLI's at once, and the server's
 * the next time OpenBot starts, which is what the row says.
 *
 * Only inside OpenBot Desktop, which sends this data and keeps the choice. A self-hosted OpenBot
 * sets its telemetry in its own configuration, so the section isn't drawn there. An older desktop
 * app that can't say draws nothing either.
 */
export function UsageDataSection() {
  const usageData = useQuery(desktopUsageDataQueryOptions());
  const queryClient = useQueryClient();
  const change = useMutation(setUsageDataMutationOptions(queryClient));
  if (desktopShell() === null || !usageData.data) return null;
  const { shared, offByEnvironment } = usageData.data;
  return (
    <PageSection title="Privacy">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconChartBar />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Share usage data</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {offByEnvironment
                ? "Turned off on this computer. OpenBot sends no usage data."
                : "OpenBot sends usage data, linked to your OpenBot account. It never sends your conversations, files or keys. Changes apply the next time OpenBot starts."}{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={USAGE_DATA_DOC}
                rel="noopener noreferrer"
                target="_blank"
              >
                What OpenBot sends
              </a>
            </ItemDescription>
            {change.error ? (
              <p className="text-destructive text-sm" role="alert">
                Couldn't change this setting. Try again.
              </p>
            ) : null}
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="Share usage data"
              checked={shared}
              disabled={offByEnvironment || change.isPending}
              onCheckedChange={(share) => change.mutate(share)}
            />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
