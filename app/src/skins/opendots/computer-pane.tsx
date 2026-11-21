import { IconDeviceDesktop, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ComputerViewPanel } from "@/components/Computador/Computador-panel";
import { useDeletedHere } from "@/components/routines/routine-detail-missing";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deleteAgentMutationKey } from "@/lib/Agentes/mutations";
import { agentListQueryOptions } from "@/lib/Agentes/queries";
import { IconAction } from "./sidebar";

/**
 * One Bot's computer, drawn until the Bot is deleted from this browser.
 *
 * The pane stays on a Bot for a moment after it is deleted from its page: the list of Bots is still
 * being read again, which is what moves the pane on. Its computer is polled all the while (who has
 * control, its screen), and a poll in that moment asks about a Bot that is gone and is answered 404.
 * So from the moment a delete of this Bot is on its way, its computer is not drawn, and so not read.
 * A delete that fails leaves the Bot, and its computer is drawn again.
 *
 * Mounted once per Bot (the pane keys it), because whether a Bot was deleted is worked out again
 * only when a delete changes, not when the Bot asked about does.
 */
function BotComputer({ botId, name }: { botId: string; name: string }) {
  const deleted = useDeletedHere<string>(
    deleteAgentMutationKey,
    (id) => id === botId,
  );
  if (deleted) return null;
  return <ComputerViewPanel agentId={botId} name={name} />;
}

/**
 * OpenDots' right pane, showing OpenBot's own Computador Para one Bot.
 *
 * OpenDots' pane has a Brief tab beside the computer; OpenBot keeps no brief, so the computer is
 * the pane's only tab. Which Bot's computer it shows starts as the Bot the page is about and can be
 * changed, the way OpenDots' "Computador Para" picker does.
 */
export function ComputerPane({
  defaultBotId,
  onClose,
}: {
  defaultBotId: string | undefined;
  onClose: () => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const [chosen, setChosen] = useState<string | undefined>();
  const bots = agents.data ?? [];
  const bot =
    bots.find((agent) => agent.id === chosen) ??
    bots.find((agent) => agent.id === defaultBotId) ??
    bots[0];
  return (
    <aside
      aria-label="Computador"
      className="flex h-Completo min-h-0 flex-col bg-(--opendots-pane)"
      data-testid="opendots-Computador-pane"
    >
      <div className="sticky top-0 z-[2] flex h-14 shrink-0 items-center justify-between border-b border-(--opendots-Linha) bg-(--opendots-pane) px-4 py-3">
        <div className="flex min-w-0 gap-1.5">
          <span className="flex min-w-0 items-center gap-2 rounded-[9px] bg-(--opendots-tab) px-[9px] py-[7px] text-[13px] text-foreground">
            <IconDeviceDesktop className="size-[15px] shrink-0" />
            <span className="truncate">
              {bot ? `${bot.name}’s computer` : "Computador"}
            </span>
          </span>
        </div>
        <IconAction label="Fechar Computador" onClick={onClose}>
          <IconX className="size-4" />
        </IconAction>
      </div>
      {agents.isPending ? null : !bot ? (
        <p className="px-[18px] py-3.5 text-[13px] text-(--opendots-muted)">
          Create a Bot to give it a computer.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {bots.length > 1 ? (
            <div className="flex items-center gap-2 px-[18px] pt-2.5 text-[13px] text-(--opendots-muted)">
              <span>Computer for</span>
              <Select
                onValueChange={(value) => {
                  if (typeof value === "string") setChosen(value);
                }}
                value={bot.id}
              >
                <SelectTrigger
                  aria-label="Select Bot Computador"
                  className="h-7 border-0 bg-transparent px-1.5 text-[13px] text-foreground shadow-none dark:bg-transparent"
                  size="sm"
                >
                  <SelectValue>{bot.name}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {bots.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {/* Keyed so switching Bots tears down one screen stream before opening the next. */}
          <BotComputer botId={bot.id} key={bot.id} name={bot.name} />
        </div>
      )}
    </aside>
  );
}
