import { IconBrandWindows } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import { agentQueryOptions } from "@/lib/agents/queries";
import { windowsComputerQueryOptions } from "@/lib/windows-computer/queries";
import { queryClient } from "@/query-client";

/**
 * Whether this Bot works on the person's Windows computer instead of its browser computer (Bot.computer).
 *
 * Shown only on the Bot a Windows computer is set up for: every other Bot has its browser computer and nothing
 * to choose. Off by default, and one computer at a time, as Sam put it: most work needs only the browser.
 * The words and the place are placeholders until Guido's UX for choosing a computer.
 */
export function WindowsComputerChoice({ agentId }: { agentId: string }) {
  const computer = useQuery(windowsComputerQueryOptions());
  const bot = useQuery(agentQueryOptions(agentId));
  const update = useMutation(updateAgentMutationOptions(queryClient));
  if (!computer.data || computer.data.botId !== agentId || !bot.data)
    return null;
  const profile = bot.data;
  const onWindows = profile.computer === "windows";
  return (
    <PageSection title="Windows computer">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconBrandWindows />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Work on your Windows computer</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {update.error
                ? update.error.message
                : onWindows
                  ? "This Bot uses your Windows computer instead of its browser. "
                  : "This Bot uses its browser. Turn this on to have it use your Windows computer instead. "}
              <Link
                className="underline underline-offset-4"
                to="/windows-computer"
              >
                Open your Windows computer
              </Link>
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="Work on your Windows computer"
              checked={onWindows}
              disabled={update.isPending || !profile.canManage}
              onCheckedChange={(checked: boolean) =>
                update.mutate({
                  agentId,
                  input: {
                    name: profile.name,
                    title: profile.title,
                    roleDescription: profile.roleDescription,
                    visibility: profile.visibility,
                    computer: checked ? "windows" : "browser",
                  },
                })
              }
            />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
