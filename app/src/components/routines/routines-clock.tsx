import { IconClock } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageEmpty } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useBotRoutines } from "./bot-routines";
import { RoutinesList } from "./routines-list";

/**
 * The clock in a one-Bot conversation's header, before the computer and the gear: how many of this
 * Bot's routines are on, and one press lists them without leaving the conversation.
 *
 * The number is counted as the Bot's page counts its Routines section (`useBotRoutines`), so the two
 * always agree, and it takes the amber the computer's dot has when one can't look or failed last
 * time. The message box keeps its own clock, "Set up a routine": that one sets a routine up, this
 * one shows what there is.
 */
export function RoutinesClock({
  agentId,
  channelId,
  botName,
}: {
  /** The conversation's Bot, once known; until then the clock is disabled. */
  agentId: string | undefined;
  channelId: string;
  botName: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { on, needsLook } = useBotRoutines(agentId);
  const count = on.length;
  const name = botName ?? "This Bot";
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={
                count ? `${name}'s routines, ${count} on` : `${name}'s routines`
              }
              aria-expanded={open}
              className={open ? "relative bg-foreground/5" : "relative"}
              data-slot="conversation-routines"
              disabled={agentId === undefined}
              onClick={() => setOpen(true)}
              size="icon"
              variant="ghost"
            >
              <IconClock className="size-4.5" />
              {count ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-0.5 right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full px-0.5 font-medium text-[9px] leading-none tabular-nums ring-2 ring-background",
                    needsLook
                      ? "bg-amber-500 text-white"
                      : "bg-foreground text-background",
                  )}
                  data-needs-look={needsLook || undefined}
                >
                  {count}
                </span>
              ) : null}
            </Button>
          }
        />
        <TooltipContent side="bottom">Routines</TooltipContent>
      </Tooltip>
      {agentId ? (
        <RoutinesDialog
          agentId={agentId}
          channelId={channelId}
          name={name}
          onOpenChange={setOpen}
          open={open}
        />
      ) : null}
    </>
  );
}

/**
 * The Bot's Routines page in a dialog: every one of its routines, goals and check-ins, on and off,
 * drawn by `RoutinesList`, so nothing about a row is decided twice. A row opens its own page, whose
 * back button returns to this conversation; leaving the conversation closes the dialog with it.
 */
function RoutinesDialog({
  agentId,
  channelId,
  name,
  open,
  onOpenChange,
}: {
  agentId: string;
  channelId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { rows, pending } = useBotRoutines(agentId);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name}'s routines</DialogTitle>
          <DialogDescription>
            What it does by itself, for you.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {!pending && rows.length === 0 ? (
            <PageEmpty icon={IconClock} title="No routines yet">
              Ask {name} here, or use New routine.
            </PageEmpty>
          ) : (
            <RoutinesList
              agentId={agentId}
              embedded
              from={channelId}
              inDialog
            />
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            render={<Link params={{ agentId }} to="/bots/$agentId/routines" />}
            size="sm"
            variant="outline"
          >
            Open Routines
          </Button>
          <Button
            render={<Link search={{ agentId, channelId }} to="/routines/new" />}
            size="sm"
          >
            New routine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
