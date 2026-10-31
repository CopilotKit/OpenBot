import {
  IconBellRinging,
  IconChevronRight,
  IconGauge,
  IconRadar,
} from "@tabler/icons-react";
import {
  keepPreviousData,
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  setCapabilityMutationOptions,
  setEnterpriseSettingMutationOptions,
} from "@/lib/enterprise/mutations";
import {
  type BotCheckInMetrics,
  type CheckInMetrics,
  type CheckInSkipReason,
  checkInMetricsQueryOptions,
  type EnterpriseOverview,
  enterpriseOverviewQueryOptions,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/proactive")({
  component: CheckInsPage,
});

type Days = CheckInMetrics["days"];

const PERIODS: Record<Days, string> = {
  7: "Last 7 days",
  30: "Last 30 days",
};

/** Why check-ins were skipped, in the order the page lists them. */
const SKIPPED_BECAUSE: Record<CheckInSkipReason, string> = {
  off_admin: "Turned off by an admin",
  off_person: "Turned off by the person",
  paused: "Bot paused",
  capped: "Over the daily limit",
  no_sources: "Nothing it could read",
  unreachable: "Conversation gone",
  busy: "Another one still running",
};

/** A count as people read it, with the thousands separated. */
const number = (count: number) => count.toLocaleString();

const plural = (count: number, one: string, many: string) =>
  `${number(count)} ${count === 1 ? one : many}`;

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** Check-ins that reached the model, whatever they found. */
const ran = (bot: BotCheckInMetrics) =>
  bot.runs.quiet + bot.runs.raised + bot.runs.failed;

const skipped = (bot: BotCheckInMetrics) =>
  Object.values(bot.runs.skipped).reduce((sum, count) => sum + count, 0);

/**
 * Admin, Check-ins: the switch and the daily limit, then how each Bot's check-ins went.
 *
 * The switch is the same "Check-ins" capability Enterprise controls lists, at the organization's
 * scope; roles and groups are set there. The numbers are counts only: the server sends no titles
 * and no people, because what a check-in raised came from somebody's own apps.
 */
export function CheckInsPage() {
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const [days, setDays] = useState<Days>(7);
  /*
   * The previous window's numbers stay up while the other loads, so switching between 7 and 30 days
   * changes the figures in place instead of emptying the section.
   */
  const metrics = useQuery({
    ...checkInMetricsQueryOptions(days),
    placeholderData: keepPreviousData,
  });

  return (
    <PageShell
      description="Bots check the apps people connected and tell them when something needs them, at most once an hour. They never act without asking."
      title="Check-ins"
    >
      {overview.isPending ? null : overview.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load check-in settings. Reload the page.
        </p>
      ) : (
        <CheckInSettings data={overview.data} />
      )}
      <Activity days={days} metrics={metrics} onDays={setDays} />
    </PageShell>
  );
}

function CheckInSettings({ data }: { data: EnterpriseOverview }) {
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const setSetting = useMutation(
    setEnterpriseSettingMutationOptions(queryClient),
  );
  const [limitOpen, setLimitOpen] = useState(false);
  const capability = data.capabilities.find(
    (row) => row.capability === "proactive",
  );
  const on = capability
    ? (capability.organization ?? capability.default)
    : true;
  const overrides = capability
    ? Object.keys(capability.roles).length +
      Object.keys(capability.groups).length
    : 0;
  const saving = setCapability.isPending || setSetting.isPending;
  const failure = setCapability.error ?? setSetting.error;

  return (
    <PageSection
      description={
        <>
          These apply to everybody. To change who gets check-ins by role or
          group, use{" "}
          <Link className="underline" to="/admin/enterprise">
            Enterprise controls
          </Link>
          .
        </>
      }
      title="Settings"
    >
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconRadar />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Check-ins</ItemTitle>
            <ItemDescription>
              {on
                ? "Bots check in for everybody."
                : "Off. No Bot checks in for anybody."}
              {overrides > 0
                ? ` ${plural(overrides, "role or group override", "role or group overrides")} change that for some people.`
                : ""}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="Check-ins"
              checked={on}
              disabled={saving}
              onCheckedChange={(checked) =>
                setCapability.mutate({
                  scopeKind: "organization",
                  scopeId: "",
                  capability: "proactive",
                  allowed: checked,
                })
              }
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item
          render={<button onClick={() => setLimitOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconGauge />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Daily limit</ItemTitle>
            <ItemDescription>
              {`Up to ${plural(data.settings.proactiveDailyRuns, "check-in", "check-ins")} a day per Bot for each person`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
      <DailyLimitDialog
        initial={data.settings.proactiveDailyRuns}
        onClose={() => setLimitOpen(false)}
        onSave={(value) =>
          setSetting.mutate(
            { key: "proactiveDailyRuns", value },
            { onSuccess: () => setLimitOpen(false) },
          )
        }
        open={limitOpen}
        saving={setSetting.isPending}
      />
    </PageSection>
  );
}

function Activity({
  days,
  metrics,
  onDays,
}: {
  days: Days;
  metrics: UseQueryResult<CheckInMetrics>;
  onDays: (days: Days) => void;
}) {
  const [openBot, setOpenBot] = useState<string | undefined>();
  const bot = metrics.data?.bots.find((row) => row.agentId === openBot);

  return (
    <PageSection
      action={
        <Select
          onValueChange={(value) => onDays(Number(value) === 30 ? 30 : 7)}
          value={String(days)}
        >
          <SelectTrigger aria-label="Period" size="sm">
            <SelectValue>{PERIODS[days]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            <SelectGroup>
              <SelectItem value="7">{PERIODS[7]}</SelectItem>
              <SelectItem value="30">{PERIODS[30]}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      }
      description="Acceptance is how many items people started, out of the ones they started or hid."
      title="Activity"
    >
      {metrics.isPending ? null : metrics.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load check-in activity. Reload the page.
        </p>
      ) : (
        <>
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBellRinging />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Pings sent</ItemTitle>
                <ItemDescription>
                  {metrics.data.pings.itemsPerPing === null
                    ? "Each one folds a person's waiting items from every Bot into one message."
                    : `${metrics.data.pings.itemsPerPing.toFixed(1)} items in each, on average`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <span className="text-sm tabular-nums">
                  {number(metrics.data.pings.sent)}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
          {metrics.data.bots.length === 0 ? (
            <PageEmpty icon={IconRadar} title="No check-ins yet">
              A Bot starts checking in once somebody talks to it.
            </PageEmpty>
          ) : (
            <PageRows>
              {metrics.data.bots.map((row, index) => (
                <Fragment key={row.agentId}>
                  {index > 0 ? <Separator /> : null}
                  <BotRow bot={row} onOpen={() => setOpenBot(row.agentId)} />
                </Fragment>
              ))}
            </PageRows>
          )}
        </>
      )}
      {bot ? (
        <BotDialog
          bot={bot}
          days={days}
          onClose={() => setOpenBot(undefined)}
        />
      ) : null}
    </PageSection>
  );
}

function BotRow({
  bot,
  onOpen,
}: {
  bot: BotCheckInMetrics;
  onOpen: () => void;
}) {
  return (
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ItemMedia>
        <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={28} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{bot.name}</ItemTitle>
        <ItemDescription>
          {[
            plural(bot.peopleOn, "person", "people"),
            plural(ran(bot), "check-in", "check-ins"),
            plural(bot.items.raised, "item", "items"),
          ].join(" · ")}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {bot.acceptance === null ? (
          <span className="text-muted-foreground text-sm">No answers yet</span>
        ) : (
          <span className="text-sm tabular-nums">
            {percent(bot.acceptance)} started
          </span>
        )}
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/** One Bot's whole breakdown for the window. */
function BotDialog({
  bot,
  days,
  onClose,
}: {
  bot: BotCheckInMetrics;
  days: Days;
  onClose: () => void;
}) {
  const reasons = (Object.keys(SKIPPED_BECAUSE) as CheckInSkipReason[]).filter(
    (reason) => bot.runs.skipped[reason] > 0,
  );
  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={32} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <DialogTitle>{bot.name}</DialogTitle>
              <DialogDescription>
                {`${PERIODS[days]}. ${bot.peopleOn === 1 ? "1 person has" : `${bot.peopleOn} people have`} check-ins on now.`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogBody className="mt-4 gap-6 overflow-y-auto">
          <div className="grid grid-cols-3 gap-4">
            <Stat
              label="Acceptance"
              value={
                bot.acceptance === null ? "None yet" : percent(bot.acceptance)
              }
            />
            <Stat label="Items raised" value={number(bot.items.raised)} />
            <Stat label="Sent in a ping" value={number(bot.pinged)} />
          </div>
          <Breakdown
            rows={[
              ["Found nothing", bot.runs.quiet],
              ["Raised something", bot.runs.raised],
              ["Couldn't finish", bot.runs.failed],
              ["Skipped before looking", skipped(bot)],
              ...reasons.map(
                (reason) =>
                  [SKIPPED_BECAUSE[reason], bot.runs.skipped[reason], true] as [
                    string,
                    number,
                    boolean,
                  ],
              ),
            ]}
            title="Check-ins"
          />
          <Breakdown
            rows={[
              ["Started", bot.items.started],
              ["Hidden", bot.items.hidden],
              ["Cleared by the Bot", bot.items.cleared],
              ["Still open", bot.items.open],
            ]}
            title="Items"
          />
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-muted-foreground text-xs">{label}</p>
      <p className="mt-0.5 font-semibold text-xl tabular-nums">{value}</p>
    </div>
  );
}

/** A heading over label and count pairs. A third `true` indents a row under the one before it. */
function Breakdown({
  rows,
  title,
}: {
  rows: (readonly [string, number] | readonly [string, number, boolean])[];
  title: string;
}) {
  return (
    <section>
      <h3 className="font-medium text-sm">{title}</h3>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, count, nested]) => (
          <Fragment key={label}>
            <dt
              className={
                nested
                  ? "truncate pl-4 text-muted-foreground"
                  : "truncate text-muted-foreground"
              }
            >
              {label}
            </dt>
            <dd className="text-right tabular-nums">{number(count)}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function DailyLimitDialog({
  initial,
  onClose,
  onSave,
  open,
  saving,
}: {
  initial: number;
  onClose: () => void;
  onSave: (value: number) => void;
  open: boolean;
  saving: boolean;
}) {
  const [value, setValue] = useState(String(initial));
  const parsed = Number(value);
  const valid =
    value.trim() !== "" &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= 1440;
  return (
    <Dialog
      onOpenChange={(next) => (next ? setValue(String(initial)) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Daily limit</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 gap-2">
          <Label htmlFor="check-in-daily-limit">
            Check-ins a day per Bot, for each person
          </Label>
          <Input
            id="check-in-daily-limit"
            inputMode="numeric"
            onChange={(event) => setValue(event.target.value)}
            value={value}
          />
          <p className="text-muted-foreground text-xs">
            24 is once an hour. Skipped check-ins don't count.
          </p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!valid || saving}
            onClick={() => onSave(parsed)}
            size="sm"
            type="button"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
