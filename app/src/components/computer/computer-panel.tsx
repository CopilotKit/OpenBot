import { IconDeviceDesktop, IconTerminal2 } from "@tabler/icons-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  followedView,
  onComputerViewRequest,
  type PanelView,
  subscribeToViews,
  takeRequestedView,
} from "@/lib/computers/panel-view";
import { useComputerControl } from "@/lib/computers/use-control";
import { ActivityLog } from "./activity-log";
import { ComputerTerminal } from "./computer-terminal";
import { ComputerView } from "./computer-view";

/**
 * The current live computer, separate from screenshots kept in historical tool results.
 *
 * Two views of the one computer: its screen, and its terminal (the Bot's live shell).
 *
 * WHICH ONE IS IN FRONT. The one the Bot last worked in: a command puts the terminal in front, a page
 * the screen, and a Bot that has only used its shell opens on the terminal (panel-view.ts). Once the
 * person picks a tab, or clicks a command in the chat to see it here, their choice holds until the
 * panel closes; opened again, it follows the Bot again.
 *
 * The Terminal tab mounts only while it is open, so a closed one holds no socket; the screen stays
 * mounted, and stops polling on its own while it cannot be seen.
 */
export function ComputerViewPanel({
  agentId,
  name,
}: {
  agentId: string;
  name?: string;
}) {
  const following = useSyncExternalStore(
    subscribeToViews,
    () => followedView(agentId),
    () => followedView(agentId),
  );
  /** The person's own choice, for this Bot, until the panel closes. */
  const [picked, setPicked] = useState<{
    agentId: string;
    view: PanelView;
  } | null>(() => {
    const asked = takeRequestedView(agentId);
    return asked ? { agentId, view: asked } : null;
  });
  // Asked for while the panel is open: a command in the chat clicked.
  useEffect(
    () =>
      onComputerViewRequest((request) => {
        if (request.computerId !== agentId) return;
        takeRequestedView(agentId);
        setPicked({ agentId, view: request.view });
      }),
    [agentId],
  );
  const view =
    (picked?.agentId === agentId ? picked.view : undefined) ??
    following ??
    "screen";

  // One wheel for the whole computer: whoever holds it holds the screen and the terminal both.
  const { control, someoneElse } = useComputerControl(agentId);
  const youHaveIt =
    control?.holder === "human" && !control.transitioning && !someoneElse;

  return (
    <section aria-label="Computer sidebar" className="p-4">
      <Tabs
        onValueChange={(next) =>
          setPicked({ agentId, view: next as PanelView })
        }
        value={view}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList aria-label="Computer view">
            <TabsTrigger value="screen">
              <IconDeviceDesktop data-icon="inline-start" />
              Screen
            </TabsTrigger>
            <TabsTrigger value="terminal">
              <IconTerminal2 data-icon="inline-start" />
              Terminal
            </TabsTrigger>
          </TabsList>
          {youHaveIt ? (
            <span
              className="rounded-full bg-amber-500/15 px-2.5 py-1 font-medium text-amber-800 text-xs dark:text-amber-300"
              role="status"
            >
              You have control
            </span>
          ) : null}
        </div>
        <TabsContent keepMounted value="screen">
          <ComputerView active computerId={agentId} name={name} minWidth={0} />
        </TabsContent>
        <TabsContent value="terminal">
          <ComputerTerminal computerId={agentId} />
        </TabsContent>
      </Tabs>
      <div className="mt-8">
        <h3 className="mb-2 font-medium text-sm">Activity</h3>
        <ActivityLog computerId={agentId} />
      </div>
    </section>
  );
}
