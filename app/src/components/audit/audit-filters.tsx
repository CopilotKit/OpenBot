import {
  AUDIT_EFFECT_WORDS,
  AUDIT_EFFECTS,
  AUDIT_INTENT_WORDS,
  AUDIT_INTENTS,
  type AuditEffect,
  type AuditFilterKey,
  type AuditFilters,
  auditFilterParams,
  hasAuditFilters,
} from "@openbot/shared/audit-filters";
import { auditEventWords } from "@openbot/shared/audit-words";
import { connectorName, humanise } from "@openbot/shared/tool-name";
import { IconChevronDown, IconCirclePlus, IconX } from "@tabler/icons-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AuditFilterLabels } from "@/lib/audit/ask";
import {
  COMPUTER_ACTION_EVENT_TYPES,
  DID_NOT_HAPPEN_EVENT_TYPES,
  REFUSED_EVENT_TYPES,
} from "@/lib/audit/outcome";
import type { AuditVocabulary } from "@/lib/audit/queries";

/**
 * The trail's filters as chips: what the server is asked for, beside the saved views.
 *
 * An answer to a question arrives as chips, and the same chips are added by hand from Add filter, so
 * a filter the model chose is one an admin can read, change and remove like any other. Unlike the
 * Outcome, Bot and Started by buttons beside the search, which narrow the rows already loaded, these
 * are asked of the server and reach the whole trail, and the export carries them.
 */

/** Two filters that each name event types, or each name one value, both have to hold. */
const MATCHES_NOTHING = "none";

/**
 * A view's query with the chips' filters asked for too, for the table and the export alike.
 *
 * Where the view already names types or initiators, the chips narrow them: Blocked with "app calls"
 * is the app calls that were blocked. Two sets with nothing in common, or two different Bots, ask for
 * a value no row carries, so the table says No matches rather than quietly dropping one of them.
 */
export function withFilters(search: string, filters: AuditFilters): string {
  if (!hasAuditFilters(filters)) return search;
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  for (const [key, value] of auditFilterParams(filters)) {
    const existing = params.get(key);
    if (existing && (key === "eventType" || key === "initiatorKind")) {
      const have = new Set(existing.split(","));
      const both = value.split(",").filter((item) => have.has(item));
      params.set(key, both.length > 0 ? both.join(",") : MATCHES_NOTHING);
    } else if (existing && key === "bot") {
      params.set(key, existing === value ? value : MATCHES_NOTHING);
    } else {
      params.set(key, value);
    }
  }
  return `?${params.toString()}`;
}

/** Whether two sets of filters ask the server the same thing. */
export function sameFilters(a: AuditFilters, b: AuditFilters): boolean {
  return (
    JSON.stringify(auditFilterParams(a)) ===
    JSON.stringify(auditFilterParams(b))
  );
}

const STARTED_BY: Record<string, string> = {
  person: "A person",
  routine: "A routine",
  handoff: "Another Bot",
  responsibility: "A goal",
  memory: "A memory source",
  deployment: "OpenBot",
};

/** Groups of event types an admin adds by name, from the lists the saved views are built from. */
const TYPE_GROUPS: { label: string; types: readonly string[] }[] = [
  { label: "Blocked", types: REFUSED_EVENT_TYPES },
  { label: "Did not happen", types: DID_NOT_HAPPEN_EVENT_TYPES },
  {
    label: "App calls",
    types: ["mcp.call_succeeded", "mcp.call_failed", "mcp.call_rejected"],
  },
  { label: "Computer actions", types: COMPUTER_ACTION_EVENT_TYPES },
  {
    label: "Approvals",
    types: [
      "approval.evaluated",
      "approval.person_decided",
      "approval.withdrawn",
    ],
  },
];

const OUTCOME_OF_TYPE: Record<string, string> = {
  ...Object.fromEntries(REFUSED_EVENT_TYPES.map((type) => [type, "blocked"])),
  ...Object.fromEntries(
    DID_NOT_HAPPEN_EVENT_TYPES.map((type) => [type, "did not happen"]),
  ),
  "mcp.call_succeeded": "done",
  "computer.action_allowed": "allowed",
};

/** One event type in words, with its outcome where its words share it with its siblings. */
function typeWords(type: string): string {
  const outcome = OUTCOME_OF_TYPE[type];
  return outcome
    ? `${auditEventWords(type)}, ${outcome}`
    : auditEventWords(type);
}

/** Several values in one chip: the first two, then how many more. */
function some(values: string[]): string {
  return values.length <= 2
    ? values.join(", ")
    : `${values.slice(0, 2).join(", ")} +${values.length - 2}`;
}

const dateWords = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

/** A `datetime-local` value for a moment, in the browser's own time. */
function localInput(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type Names = {
  labels: AuditFilterLabels;
  vocabulary: AuditVocabulary | undefined;
  nameFor: (botId: string) => string;
};

function appName(key: string, names: Names): string {
  return (
    names.labels.apps[key] ??
    names.vocabulary?.apps.find((app) => app.key === key)?.name ??
    connectorName(key)
  );
}

function personName(id: string, names: Names): string {
  const person = names.vocabulary?.people.find((entry) => entry.id === id);
  return names.labels.people[id] ?? person?.name ?? person?.email ?? id;
}

function ruleName(rule: string, names: Names): string {
  const named =
    names.labels.rules[rule] ??
    names.vocabulary?.rules.find((entry) => entry.rule === rule)?.name;
  return named ?? (rule.length > 48 ? `${rule.slice(0, 47)}…` : rule);
}

/** What a chip says: the filter, then its values in words. */
export function chipText(
  key: AuditFilterKey,
  filters: AuditFilters,
  names: Names,
): string {
  switch (key) {
    case "bot":
      return `Bot: ${names.labels.bots[filters.bot as string] ?? names.nameFor(filters.bot as string) ?? filters.bot}`;
    case "actorUserId":
      return `Person: ${personName(filters.actorUserId as string, names)}`;
    case "initiatorKind":
      return `Started by: ${some((filters.initiatorKind ?? []).map((kind) => STARTED_BY[kind] ?? kind))}`;
    case "eventType": {
      const types = filters.eventType ?? [];
      const group = TYPE_GROUPS.find(
        (entry) =>
          entry.types.length === types.length &&
          entry.types.every((type) => types.includes(type)),
      );
      return `Type: ${group?.label ?? some(types.map(typeWords))}`;
    }
    case "app":
      return `App: ${some((filters.app ?? []).map((key) => appName(key, names)))}`;
    case "tool":
      return `Tool: ${some((filters.tool ?? []).map(humanise))}`;
    case "effect":
      return `Effect: ${AUDIT_EFFECT_WORDS[filters.effect as AuditEffect] ?? filters.effect}`;
    case "intent":
      return `Action: ${some((filters.intent ?? []).map((intent) => AUDIT_INTENT_WORDS[intent] ?? intent))}`;
    case "rule":
      return `Rule: ${ruleName(filters.rule as string, names)}`;
    case "from":
      return `After: ${dateWords(filters.from as string)}`;
    case "to":
      return `Before: ${dateWords(filters.to as string)}`;
  }
}

function without(filters: AuditFilters, key: AuditFilterKey): AuditFilters {
  const next = { ...filters };
  delete next[key];
  return next;
}

/** A list filter with one value added or taken away, and gone when it names nothing. */
function toggled<
  K extends "eventType" | "initiatorKind" | "app" | "tool" | "intent",
>(filters: AuditFilters, key: K, value: string, on: boolean): AuditFilters {
  const current = (filters[key] ?? []) as string[];
  const next = on
    ? [...new Set([...current, value])]
    : current.filter((item) => item !== value);
  return next.length > 0 ? { ...filters, [key]: next } : without(filters, key);
}

/** The values one filter can take, as menu items: ticks for a list, a choice for one value. */
function FilterOptions({
  filterKey,
  filters,
  onChange,
  names,
}: {
  filterKey: AuditFilterKey;
  filters: AuditFilters;
  onChange: (next: AuditFilters) => void;
  names: Names;
}) {
  const vocabulary = names.vocabulary;
  const tick = (
    key: "eventType" | "initiatorKind" | "app" | "tool" | "intent",
    value: string,
    label: string,
  ) => (
    <DropdownMenuCheckboxItem
      checked={((filters[key] ?? []) as string[]).includes(value)}
      key={value}
      onCheckedChange={(on) => onChange(toggled(filters, key, value, on))}
    >
      <span className="truncate">{label}</span>
    </DropdownMenuCheckboxItem>
  );
  const choose = (
    key: "bot" | "actorUserId" | "effect" | "rule",
    options: { value: string; label: string }[],
  ) => (
    <DropdownMenuRadioGroup
      onValueChange={(value) => onChange({ ...filters, [key]: value })}
      value={(filters[key] as string | undefined) ?? ""}
    >
      {options.map((option) => (
        <DropdownMenuRadioItem key={option.value} value={option.value}>
          <span className="truncate">{option.label}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
  const loading = (
    <DropdownMenuLabel className="font-normal text-muted-foreground">
      {vocabulary ? "Nothing to choose yet" : "Loading…"}
    </DropdownMenuLabel>
  );

  switch (filterKey) {
    case "bot":
      return vocabulary?.bots.length
        ? choose(
            "bot",
            vocabulary.bots.map((bot) => ({ value: bot.id, label: bot.name })),
          )
        : loading;
    case "actorUserId":
      return vocabulary?.people.length
        ? choose(
            "actorUserId",
            vocabulary.people.map((person) => ({
              value: person.id,
              label: person.name ?? person.email,
            })),
          )
        : loading;
    case "initiatorKind":
      return (
        <>
          {Object.entries(STARTED_BY).map(([kind, label]) =>
            tick("initiatorKind", kind, label),
          )}
        </>
      );
    case "eventType":
      // The types this chip names, so an answer's types can be taken off one by one.
      return (
        <>
          {(filters.eventType ?? []).map((type) =>
            tick("eventType", type, typeWords(type)),
          )}
        </>
      );
    case "app":
      return vocabulary?.apps.length
        ? vocabulary.apps.map((app) => tick("app", app.key, app.name))
        : loading;
    case "tool": {
      const called = vocabulary?.tools.filter((tool) => tool.calls > 0) ?? [];
      const shown = [
        ...new Set([
          ...(filters.tool ?? []),
          ...called.map((tool) => tool.tool),
        ]),
      ];
      return shown.length
        ? shown.map((tool) => tick("tool", tool, humanise(tool)))
        : loading;
    }
    case "effect":
      return choose(
        "effect",
        AUDIT_EFFECTS.map((effect) => ({
          value: effect,
          label: AUDIT_EFFECT_WORDS[effect],
        })),
      );
    case "intent":
      return (
        <>
          {AUDIT_INTENTS.map((intent) =>
            tick("intent", intent, AUDIT_INTENT_WORDS[intent]),
          )}
        </>
      );
    case "rule":
      return vocabulary?.rules.length
        ? choose(
            "rule",
            vocabulary.rules.map((rule) => ({
              value: rule.rule,
              label: rule.name ?? rule.rule,
            })),
          )
        : loading;
    case "from":
    case "to":
      return null;
  }
}

const FILTER_TITLES: Record<AuditFilterKey, string> = {
  bot: "Bot",
  actorUserId: "Person",
  initiatorKind: "Started by",
  eventType: "Type",
  app: "App",
  tool: "Tool",
  effect: "Effect",
  intent: "Action",
  rule: "Rule",
  from: "After",
  to: "Before",
};

/** The menu a chip opens: change what it holds, or take it off. */
function Chip({
  filterKey,
  filters,
  onChange,
  onOpen,
  names,
}: {
  filterKey: AuditFilterKey;
  filters: AuditFilters;
  onChange: (next: AuditFilters) => void;
  onOpen: () => void;
  names: Names;
}) {
  const text = chipText(filterKey, filters, names);
  const remove = (
    <Button
      aria-label={`Remove ${text}`}
      className="-ml-1 rounded-l-none text-muted-foreground hover:text-foreground"
      onClick={() => onChange(without(filters, filterKey))}
      size="icon-sm"
      variant="ghost"
    >
      <IconX />
    </Button>
  );
  const trigger = (
    <Button
      className="rounded-r-none pr-1 font-normal"
      onClick={onOpen}
      size="sm"
      variant="ghost"
    />
  );
  return (
    <span
      className="inline-flex items-center rounded-lg bg-secondary text-secondary-foreground"
      data-audit-chip={filterKey}
    >
      {filterKey === "from" || filterKey === "to" ? (
        <DateFilter
          filterKey={filterKey}
          filters={filters}
          onChange={onChange}
          trigger={trigger}
        >
          {text}
        </DateFilter>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger render={trigger}>
            {text}
            <IconChevronDown className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-auto min-w-56 max-w-80">
            <FilterOptions
              filterKey={filterKey}
              filters={filters}
              names={names}
              onChange={onChange}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {remove}
    </span>
  );
}

/** A time chip: one moment, picked in the browser's own time. */
function DateFilter({
  filterKey,
  filters,
  onChange,
  trigger,
  children,
}: {
  filterKey: "from" | "to";
  filters: AuditFilters;
  onChange: (next: AuditFilters) => void;
  trigger: ReactElement;
  children: ReactNode;
}) {
  const [value, setValue] = useState(localInput(filters[filterKey]));
  const id = `audit-filter-${filterKey}`;
  return (
    <Popover
      onOpenChange={(open) => open && setValue(localInput(filters[filterKey]))}
    >
      <PopoverTrigger render={trigger}>
        {children}
        <IconChevronDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = Date.parse(value);
            if (!Number.isNaN(parsed))
              onChange({
                ...filters,
                [filterKey]: new Date(parsed).toISOString(),
              });
          }}
        >
          <label className="font-medium text-sm" htmlFor={id}>
            {filterKey === "from" ? "Events after" : "Events before"}
          </label>
          <Input
            id={id}
            onChange={(event) => setValue(event.target.value)}
            type="datetime-local"
            value={value}
          />
          <div>
            <Button size="sm" type="submit">
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

const HOUR = 3_600_000;
const SINCE: { label: string; hours: number }[] = [
  { label: "Last 24 hours", hours: 24 },
  { label: "Last 7 days", hours: 24 * 7 },
  { label: "Last 30 days", hours: 24 * 30 },
];

/**
 * The chips, then Add filter, then Clear filters. `onOpen` is called when a menu that lists this
 * deployment's Bots, apps or rules is about to open, so they are asked for only when wanted.
 */
export function AuditFilterChips({
  filters,
  onChange,
  onOpen,
  labels,
  vocabulary,
  nameFor,
}: {
  filters: AuditFilters;
  onChange: (next: AuditFilters) => void;
  onOpen: () => void;
  labels: AuditFilterLabels;
  vocabulary: AuditVocabulary | undefined;
  nameFor: (botId: string) => string;
}) {
  const names: Names = { labels, vocabulary, nameFor };
  const present = (Object.keys(FILTER_TITLES) as AuditFilterKey[]).filter(
    (key) => {
      const value = filters[key];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    },
  );
  const addable = (Object.keys(FILTER_TITLES) as AuditFilterKey[]).filter(
    (key) => !present.includes(key) && key !== "from" && key !== "to",
  );
  return (
    <>
      {present.map((key) => (
        <Chip
          filterKey={key}
          filters={filters}
          key={key}
          names={names}
          onChange={onChange}
          onOpen={onOpen}
        />
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              className="border-dashed"
              onClick={onOpen}
              size="sm"
              variant="outline"
            />
          }
        >
          <IconCirclePlus />
          Add filter
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-auto min-w-52">
          {addable.map((key) => (
            <DropdownMenuSub key={key}>
              <DropdownMenuSubTrigger>
                {FILTER_TITLES[key]}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-auto min-w-56 max-w-80">
                {key === "eventType" ? (
                  TYPE_GROUPS.map((group) => (
                    <DropdownMenuItem
                      key={group.label}
                      onClick={() =>
                        onChange({ ...filters, eventType: [...group.types] })
                      }
                    >
                      {group.label}
                    </DropdownMenuItem>
                  ))
                ) : (
                  <FilterOptions
                    filterKey={key}
                    filters={filters}
                    names={names}
                    onChange={onChange}
                  />
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
          {!filters.from ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Time</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-auto min-w-44">
                {SINCE.map((since) => (
                  <DropdownMenuItem
                    key={since.label}
                    onClick={() => {
                      const { to: _until, ...rest } = filters;
                      onChange({
                        ...rest,
                        from: new Date(
                          Date.now() - since.hours * HOUR,
                        ).toISOString(),
                      });
                    }}
                  >
                    {since.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {present.length > 0 ? (
        <Button
          className="text-muted-foreground"
          onClick={() => onChange({})}
          size="sm"
          variant="ghost"
        >
          Clear filters
        </Button>
      ) : null}
    </>
  );
}
