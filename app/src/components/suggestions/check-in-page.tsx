import {
  IconClock,
  IconPlayerPlay,
  IconRadar,
  IconRepeat,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type LinkProps, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  backLabelFor,
  routinesOf,
} from "@/components/routines/new-routine-page";
import { DeleteRow } from "@/components/routines/delete-row";
import {
  RoutineDetailMissing,
  useDeletedHere,
} from "@/components/routines/routine-detail-missing";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  changeProactiveSettingMutationKey,
  changeProactiveSettingMutationOptions,
  type ProactiveChange,
  type ProactiveSetting,
  proactiveSettingsQueryOptions,
} from "@/lib/proactive";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { CheckInHealthFix } from "./check-in-health";
import {
  checkInStatus,
  intervalItems,
  intervals,
  lastCheckInLine,
  useCheckInsBlocked,
} from "./proactive-panel";

/**
 * A check-in's page at `/routines/check-ins/$checkInId`, reached from its row on a Routines list,
 * as a goal's and a schedule's are. It was a dialog over the list.
 *
 * Read from the check-ins list rather than a read of its own, so the row and the page are the same
 * record. `agentId` is the Bot whose Routines page it came from, for the back link.
 */
export function CheckInRoutePage({
  checkInId,
  agentId,
  from,
}: {
  checkInId: string;
  agentId?: string;
  /** The conversation it was opened from, by its header's clock: the back button returns there. */
  from?: string;
}) {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const blocked = useCheckInsBlocked();
  const deleted = useDeletedHere<{
    setting: { id: string };
    change: ProactiveChange;
  }>(
    changeProactiveSettingMutationKey,
    ({ setting, change }) =>
      change.kind === "remove" && setting.id === checkInId,
  );
  const back = routinesOf(agentId, from);
  const setting = settings.data?.find((row) => row.id === checkInId);
  if (!setting)
    return (
      <RoutineDetailMissing
        back={back}
        deleted={deleted}
        icon={IconRadar}
        kind="check-in"
        read={settings}
      />
    );
  const botName =
    [...(bots.data ?? []), ...(hidden.data ?? [])].find(
      (bot) => bot.id === setting.agentId,
    )?.name ?? "A Bot";
  return (
    <CheckInPage
      back={back}
      blocked={blocked}
      botName={botName}
      key={setting.id}
      setting={setting}
    />
  );
}

/**
 * Everything about one check-in: whether it is on, running it now, how often it looks, and removing
 * it. Each takes effect at once, as it did in the dialog; Remove, the last row, asks first, then
 * returns to the list.
 */
export function CheckInPage({
  setting,
  botName,
  blocked,
  back,
}: {
  setting: ProactiveSetting;
  botName: string;
  /** Why no check-in runs for this person right now, or null. */
  blocked: string | null;
  /** The Routines list it came from. */
  back: LinkProps;
}) {
  const id = useId();
  const navigate = useNavigate();
  const change = useMutation(
    changeProactiveSettingMutationOptions(queryClient),
  );
  const [confirming, setConfirming] = useState(false);
  const last = lastCheckInLine(setting.lastRun);
  const outcome = setting.lastRun?.outcome;
  /*
   * Run now was queued and nothing has started since: say it is on its way until the check-in it
   * queued shows up as the last one, so the press is never followed by nothing.
   */
  const queuedAt =
    change.isSuccess && change.data?.queued ? change.submittedAt : null;
  const onItsWay =
    queuedAt !== null &&
    !(setting.lastRun && Date.parse(setting.lastRun.startedAt) >= queuedAt);
  const removing =
    change.isPending && change.variables.change.kind === "remove";

  return (
    <PageShell
      backButton={{ label: backLabelFor(back), linkProps: back }}
      description={[setting.subject ? botName : null, setting.focus]
        .filter(Boolean)
        .join(" · ")}
      title={setting.subject || `${botName}'s check-ins`}
    >
      {/* What can be done to it now. The page title names it, so this section has no heading. */}
      <PageSection>
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconClock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{checkInStatus(setting, blocked)}</ItemTitle>
              {/* Can't look comes first: it is what to fix, and the last run only says it again. */}
              {setting.enabled && setting.health ? (
                <ItemDescription className="line-clamp-none text-destructive">
                  {setting.health.why}
                </ItemDescription>
              ) : onItsWay ? (
                <ItemDescription>
                  Queued. It checks in within a minute.
                </ItemDescription>
              ) : last ? (
                <ItemDescription
                  className={cn(
                    "line-clamp-none",
                    outcome === "failed" && "text-destructive",
                  )}
                >
                  {last}
                </ItemDescription>
              ) : null}
            </ItemContent>
            {setting.enabled && setting.health ? (
              <ItemActions>
                <CheckInHealthFix
                  onPage
                  onRemove={() => {
                    change.reset();
                    setConfirming(true);
                  }}
                  setting={setting}
                />
              </ItemActions>
            ) : null}
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconRadar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>On</ItemTitle>
              <ItemDescription>
                {setting.enabled
                  ? "It looks on its own, and tells you when something needs you."
                  : "Off. It won't look until you turn it on."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {/* Binary and immediate: it takes effect when switched, there is no save. */}
              <Switch
                aria-label="Check-ins on"
                checked={setting.enabled}
                disabled={change.isPending}
                onCheckedChange={(next) => {
                  if (next !== setting.enabled)
                    change.mutate({ setting, change: { kind: "toggle" } });
                }}
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={
              <button
                disabled={!setting.enabled || !!blocked || change.isPending}
                onClick={() =>
                  change.mutate({ setting, change: { kind: "run" } })
                }
                type="button"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconPlayerPlay />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {change.isPending && change.variables.change.kind === "run"
                  ? "Starting…"
                  : "Run now"}
              </ItemTitle>
              <ItemDescription>
                {setting.enabled
                  ? "Looks now, instead of waiting for the next time. It only reads."
                  : "It's off. Turn it on first."}
              </ItemDescription>
            </ItemContent>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconRepeat />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                <label htmlFor={`${id}-interval`}>How often</label>
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              {/* Writes on pick: one value, no draft worth holding. */}
              <Select
                disabled={change.isPending}
                items={intervalItems}
                onValueChange={(minutes) => {
                  if (minutes !== null && minutes !== setting.intervalMinutes)
                    change.mutate({
                      setting,
                      change: { kind: "interval", minutes },
                    });
                }}
                value={setting.intervalMinutes}
              >
                <SelectTrigger className="w-44" id={`${id}-interval`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {intervals.map((interval) => (
                    <SelectItem key={interval.minutes} value={interval.minutes}>
                      {interval.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ItemActions>
          </Item>
          <Separator />
          <DeleteRow
            description={`${botName} stops looking at this for good.`}
            onClick={() => {
              change.reset();
              setConfirming(true);
            }}
            title="Remove check-in"
          />
        </PageRows>
        {change.error && !confirming ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {change.error.message}
          </p>
        ) : null}
      </PageSection>

      <Dialog onOpenChange={setConfirming} open={confirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this check-in?</DialogTitle>
            <DialogDescription>
              {botName} stops looking at this for good. You can't undo this.
            </DialogDescription>
          </DialogHeader>
          {change.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {change.error.message}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={removing}
              onClick={() =>
                change.mutate(
                  { setting, change: { kind: "remove" } },
                  // Usually the route has gone back already, on the list without it. This is
                  // for a list that couldn't be read again.
                  { onSuccess: () => navigate({ ...back, replace: true }) },
                )
              }
              size="sm"
              type="button"
              variant="destructive"
            >
              {removing ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
