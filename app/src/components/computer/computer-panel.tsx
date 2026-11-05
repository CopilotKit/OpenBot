import { IconDeviceDesktop, IconTerminal2 } from "@tabler/icons-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivityLog } from "./activity-log";
import { ComputerTerminal } from "./computer-terminal";
import { ComputerView } from "./computer-view";

/**
 * The current live computer, separate from screenshots kept in historical tool results.
 *
 * Two views of the one computer: its screen, and its terminal (the Bot's live shell). The Terminal
 * tab mounts only while it is open, so a closed one holds no socket; the screen stays mounted, and
 * stops polling on its own while it cannot be seen.
 */
export function ComputerViewPanel({
  agentId,
  name,
}: {
  agentId: string;
  name?: string;
}) {
  return (
    <section aria-label="Computer sidebar" className="p-4">
      <Tabs defaultValue="screen">
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
