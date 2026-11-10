import {
  WHAT_IF_INITIATOR_WORDS,
  WHAT_IF_INITIATORS,
  WHAT_IF_INTENT_WORDS,
  WHAT_IF_INTENTS,
  type WhatIfAction,
  type WhatIfInitiator,
  type WhatIfIntent,
  type WhatIfVocabulary,
} from "@openbot/shared/what-if";
import { humanise } from "@openbot/shared/tool-name";
import { IconChevronDown } from "@tabler/icons-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * One action as chips: who, what started it, and what it does. A question read by the model arrives
 * here, and every chip can be changed, so the action that is checked is the one the admin confirmed.
 *
 * Each chip holds only what this OpenBot has: its Bots, people, groups, apps and tools. The same chip
 * shape as the Audit page's filters, wrapping onto as many lines as the column needs.
 */
export function ActionChips({
  action,
  vocabulary,
  onChange,
}: {
  action: WhatIfAction;
  vocabulary: WhatIfVocabulary | undefined;
  onChange: (next: WhatIfAction) => void;
}) {
  const set = (patch: Partial<WhatIfAction>) =>
    onChange({ ...action, ...patch });
  const bot = vocabulary?.bots.find((entry) => entry.id === action.bot);
  const person = vocabulary?.people.find((entry) => entry.id === action.person);
  const app = vocabulary?.apps.find((entry) => entry.id === action.app);
  const tool = app?.tools.find((entry) => entry.name === action.tool);
  const intent = action.intent as WhatIfIntent | "";
  const detail =
    intent === "run_command"
      ? ({ key: "command", title: "Command" } as const)
      : intent === "read_file" ||
          intent === "write_file" ||
          intent === "download_file" ||
          intent === "list_files"
        ? ({ key: "file", title: "File" } as const)
        : intent === "activate" || intent === "type"
          ? ({ key: "label", title: "Button or field" } as const)
          : null;

  return (
    <div className="flex flex-wrap gap-2" data-what-if-chips>
      <MenuChip
        chip="bot"
        empty={!bot}
        title="Bot"
        value={bot?.name ?? "Choose"}
      >
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            const owner = vocabulary?.bots.find(
              (entry) => entry.id === value,
            )?.owner;
            // A Bot runs on its owner's account unless somebody says otherwise.
            set({
              bot: value,
              ...(!action.person && !action.group && owner
                ? { person: owner }
                : {}),
            });
          }}
          value={action.bot}
        >
          {(vocabulary?.bots ?? []).map((entry) => (
            <DropdownMenuRadioItem key={entry.id} value={entry.id}>
              <span className="truncate">{entry.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </MenuChip>

      <MenuChip
        chip="person"
        empty={!person && !action.group}
        title="Runs as"
        value={
          action.group
            ? `Anyone in ${action.group}`
            : (person?.name ?? person?.email ?? "Choose")
        }
      >
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            set(
              value.startsWith("group:")
                ? { person: "", group: value.slice(6) }
                : { person: value, group: "" },
            )
          }
          value={action.group ? `group:${action.group}` : action.person}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>People</DropdownMenuLabel>
            {(vocabulary?.people ?? []).map((entry) => (
              <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                <span className="truncate">{entry.name ?? entry.email}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuGroup>
          {vocabulary?.groups.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Anyone in a group</DropdownMenuLabel>
                {vocabulary.groups.map((group) => (
                  <DropdownMenuRadioItem key={group} value={`group:${group}`}>
                    <span className="truncate">{group}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuRadioGroup>
      </MenuChip>

      <MenuChip
        chip="initiator"
        title="Started by"
        value={WHAT_IF_INITIATOR_WORDS[action.initiator]}
      >
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            set({ initiator: value as WhatIfInitiator })
          }
          value={action.initiator}
        >
          {WHAT_IF_INITIATORS.map((kind) => (
            <DropdownMenuRadioItem key={kind} value={kind}>
              {WHAT_IF_INITIATOR_WORDS[kind]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </MenuChip>

      <MenuChip
        chip="surface"
        title="Uses"
        value={action.surface === "app" ? "An app" : "Its computer"}
      >
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            set(
              value === "app"
                ? {
                    surface: "app",
                    intent: "",
                    host: "",
                    label: "",
                    command: "",
                    file: "",
                  }
                : { surface: "computer", app: "", tool: "" },
            )
          }
          value={action.surface}
        >
          <DropdownMenuRadioItem value="app">An app</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="computer">
            Its computer
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </MenuChip>

      {action.surface === "app" ? (
        <>
          <MenuChip
            chip="app"
            empty={!app}
            title="App"
            value={app?.name ?? "Choose"}
          >
            <DropdownMenuRadioGroup
              onValueChange={(value) => set({ app: value, tool: "" })}
              value={action.app}
            >
              {(vocabulary?.apps ?? []).map((entry) => (
                <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                  <span className="truncate">{entry.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </MenuChip>
          <MenuChip
            chip="tool"
            empty={!tool}
            title="Tool"
            value={tool ? humanise(tool.name) : "Choose"}
          >
            {app?.tools.length ? (
              <DropdownMenuRadioGroup
                onValueChange={(value) => set({ tool: value })}
                value={action.tool}
              >
                {app.tools.map((entry) => (
                  <DropdownMenuRadioItem key={entry.name} value={entry.name}>
                    <span className="truncate">{humanise(entry.name)}</span>
                    <span className="ml-auto ps-3 text-muted-foreground text-xs">
                      {entry.effect === "write" ? "Changes" : "Reads"}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            ) : (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="font-normal">
                  {app ? "This app lists no tools." : "Choose an app first."}
                </DropdownMenuLabel>
              </DropdownMenuGroup>
            )}
          </MenuChip>
          {tool ? (
            <StaticChip
              title="Effect"
              value={
                tool.effect === "write" ? "Changes something" : "Only reads"
              }
            />
          ) : null}
        </>
      ) : (
        <>
          <MenuChip
            chip="intent"
            empty={!intent}
            title="Does"
            value={intent ? WHAT_IF_INTENT_WORDS[intent] : "Choose"}
          >
            <DropdownMenuRadioGroup
              onValueChange={(value) => set({ intent: value as WhatIfIntent })}
              value={action.intent}
            >
              {WHAT_IF_INTENTS.map((entry) => (
                <DropdownMenuRadioItem key={entry} value={entry}>
                  {WHAT_IF_INTENT_WORDS[entry]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </MenuChip>
          <TextChip
            chip="host"
            empty={!action.host}
            label="Web site"
            onChange={(host) => set({ host })}
            placeholder="www.linkedin.com"
            title="Site"
            value={action.host}
          />
          {detail ? (
            <TextChip
              chip={detail.key}
              label={detail.title}
              onChange={(value) => set({ [detail.key]: value })}
              optional
              placeholder={
                detail.key === "command"
                  ? "rm -rf build"
                  : detail.key === "file"
                    ? "reports/q3.csv"
                    : "Submit"
              }
              title={detail.title}
              value={action[detail.key]}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

const CHIP = "inline-flex items-center rounded-lg text-secondary-foreground";

function chipTone(empty: boolean | undefined) {
  // A chip still to fill is drawn as a gap, the way Add filter is: a dashed outline, no fill.
  return empty
    ? "border border-border border-dashed bg-transparent"
    : "bg-secondary";
}

function ChipText({ title, value }: { title: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{title}:</span>
      <span className="max-w-48 truncate">{value}</span>
    </>
  );
}

/** A chip that opens a list to choose one value from. */
function MenuChip({
  chip,
  title,
  value,
  empty,
  children,
}: {
  chip: string;
  title: string;
  value: string;
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cn(CHIP, chipTone(empty))} data-what-if-chip={chip}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button className="font-normal" size="sm" variant="ghost" />}
        >
          <ChipText title={title} value={value} />
          <IconChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 w-auto min-w-56 max-w-80">
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** A chip that only states something, such as the effect the app gives a tool. */
function StaticChip({ title, value }: { title: string; value: string }) {
  return (
    <span
      className={cn(CHIP, "h-7 gap-1 bg-secondary/60 px-2.5 text-[0.8rem]")}
      data-what-if-chip="effect"
    >
      <ChipText title={title} value={value} />
    </span>
  );
}

/** A chip that takes a few words: the site, a label, a command or a path. */
function TextChip({
  chip,
  title,
  label,
  value,
  placeholder,
  optional = false,
  empty,
  onChange,
}: {
  chip: string;
  title: string;
  label: string;
  value: string;
  placeholder: string;
  optional?: boolean;
  empty?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const id = useId();
  return (
    <span className={cn(CHIP, chipTone(empty))} data-what-if-chip={chip}>
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setDraft(value);
        }}
        open={open}
      >
        <PopoverTrigger
          render={<Button className="font-normal" size="sm" variant="ghost" />}
        >
          <ChipText
            title={title}
            value={value || (optional ? "Any" : "Enter")}
          />
          <IconChevronDown className="text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              onChange(draft.trim());
              setOpen(false);
            }}
          >
            <label className="font-medium text-sm" htmlFor={id}>
              {label}
              {optional ? (
                <span className="ms-1 font-normal text-muted-foreground">
                  (optional)
                </span>
              ) : null}
            </label>
            <Input
              autoComplete="off"
              id={id}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={placeholder}
              value={draft}
            />
            <div>
              <Button size="sm" type="submit">
                Apply
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </span>
  );
}
