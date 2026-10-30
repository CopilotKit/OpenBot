import { RESEARCH_ROLES } from "@openbot/shared/research";
import {
  IconAlertTriangle,
  IconChevronRight,
  IconSearch,
  IconWorldSearch,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  type PluginServer,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { undeclaredElsewhere } from "@/lib/skills/form";
import { cn } from "@/lib/utils";

/*
 * Which tools this skill says it needs: a list of apps first, then one app's tools on a step of its
 * own.
 *
 * WHY IT MATTERS THAT THIS EXISTS AT ALL. Selection is over skills: before a run the deployment asks
 * its own model which skills the message needs, and the Bot is built with those skills' tools plus
 * every granted tool no skill claims. A deployment where no skill declares anything has nothing to
 * select on, so every Bot is offered its whole catalogue — which is the case the narrowing was built
 * to fix. Until this screen existed the only way to declare a tool was to call the API by hand.
 *
 * A DECLARATION IS NOT A GRANT, and this is the one thing the screen has to get across. Anybody
 * signed in may write a skill; adding an MCP server is an administrator's decision. If naming a tool
 * here made it callable, the first surface would be a way around the second. It does not: the offer
 * is intersected with what the Bot was granted, so a skill naming a tool its Bot does not hold
 * selects the skill and loads nothing. Said in the hint rather than left for somebody to discover,
 * because the failure it prevents is somebody ticking boxes expecting access.
 *
 * APPS FIRST, BECAUSE ONE APP CAN OFFER FIFTY TOOLS. Every tool of every app drawn at once was a wall
 * of chips the moment a Composio app was connected, and the two-tool search server was lost under
 * it. A person writing a skill knows which app it works in before they know which of its tools, so
 * the list is answered by recognition and the step holds only the tools of the app they picked.
 *
 * PART OF THE FORM, unlike the Agents toggles below it. What a skill needs is the author's draft
 * until they press save, so unticking one and leaving without saving changes nothing. Granting is
 * the opposite and saves on press, which is why the two look different on purpose.
 */

/** Which group of tools the step is showing: an app by its server id, or one of the two below. */
export type ToolSource = string;
const RESEARCH: ToolSource = "research";
const ELSEWHERE: ToolSource = "elsewhere";

/** One toggleable thing on a step, whatever it came from. */
type Choice = {
  ref: string;
  name: string;
  description: string;
  writes: boolean;
};

type Group = {
  key: ToolSource;
  title: string;
  media: React.ReactNode;
  choices: Choice[];
  /** What the step says under its heading. */
  explanation: string;
};

/**
 * Every group a skill can pick tools from, in the order they are listed.
 *
 * Only servers that actually offer something. A server whose tools have never been refreshed has an
 * empty list, and a row that opens onto nothing reads as an app that failed to load.
 */
function useToolGroups(selected: string[]) {
  const plugins = useQuery(pluginsPageQueryOptions());
  const servers = (plugins.data?.servers ?? []).filter(
    (server) => server.tools.length > 0,
  );

  const groups: Group[] = servers.map((server: PluginServer) => ({
    key: server.id,
    title: server.title,
    media: <PluginLogo logo={server.logo} />,
    choices: server.tools.map((tool) => ({
      ref: tool.ref,
      /*
       * The vendor's own tool name, not the namespaced one a model sees. The person reading this is
       * matching it against the vendor's documentation.
       */
      name: tool.name,
      description: tool.description,
      writes: tool.effect === "write",
    })),
    explanation:
      "Pick the ones this skill uses. They load only when the skill does.",
  }));

  if (plugins.data) {
    groups.push({
      key: RESEARCH,
      title: "Public-web research",
      media: <IconWorldSearch />,
      choices: RESEARCH_ROLES.map((role) => ({
        ref: role.ref,
        name: role.label,
        description: "Uses whichever research app the Bot has.",
        writes: false,
      })),
      explanation:
        "Not tied to one app. The Bot uses whichever research app it has.",
    });
  }

  /*
   * Declared, and offered by nothing this deployment has connected.
   *
   * Shown rather than dropped, because the alternative is a screen that states part of the
   * declaration as though it were all of it. A package ships skills declaring tools for connectors
   * nobody has added yet, and a person's own skill outlives the server it was written against, so
   * this is the ordinary case rather than a corner of one. Left out, a skill needing two tools drew
   * one and the second was invisible to the person governing it.
   *
   * Only computed once the list has actually loaded: while the query is pending every ref looks
   * unmatched, and flashing the whole declared set into this group and out again would be worse
   * than showing nothing for a moment.
   */
  const elsewhere = plugins.data
    ? undeclaredElsewhere(
        selected,
        servers.flatMap((server) => server.tools.map((tool) => tool.ref)),
      )
    : [];
  if (elsewhere.length > 0) {
    groups.push({
      key: ELSEWHERE,
      title: "Not available here",
      media: <IconAlertTriangle />,
      choices: elsewhere.map((ref) => ({
        // The whole ref, not a tool name: the server id is the part that says what is missing.
        ref,
        name: ref,
        description: "No app here offers this.",
        writes: false,
      })),
      explanation:
        "This skill asks for these, but no app here offers them. They do nothing until an admin adds the app. Untick one to remove it.",
    });
  }

  return { plugins, groups };
}

/**
 * Rebuilt rather than mutated, and filtered rather than spliced, so the array handed to the form is
 * a new one. React Form compares by reference; mutating in place leaves the field's value looking
 * unchanged and the submit button disabled on a form the person has edited.
 */
function toggled(selected: string[], ref: string): string[] {
  return selected.includes(ref)
    ? selected.filter((each) => each !== ref)
    : [...selected, ref];
}

/**
 * What a row says it holds: the current answer, not the field's name, so it changes by itself when
 * the step changes something.
 */
function summaryOf(group: Group, held: Set<string>): string {
  const picked = group.choices.filter((choice) => held.has(choice.ref));
  if (picked.length === 0) {
    return group.choices.length === 1
      ? "1 tool"
      : `${group.choices.length} tools`;
  }
  return `${picked.length} of ${group.choices.length}: ${picked.map((choice) => choice.name).join(", ")}`;
}

/** The apps a skill can take tools from, each opening a step with that app's tools. */
export function SkillToolApps({
  selected,
  onOpen,
  framed = false,
}: {
  selected: string[];
  onOpen: (source: ToolSource) => void;
  /**
   * Drawn as a section of a screen: no label of its own, because the section's heading and
   * description say it, and the apps as one card of divided rows, like every other list of settings.
   * Unframed, it is a labelled field among others and the apps are filled rows.
   */
  framed?: boolean;
}) {
  const { plugins, groups } = useToolGroups(selected);
  const held = new Set(selected);

  const rows = groups.map((group, index) => (
    <Fragment key={group.key}>
      {framed && index > 0 ? <Separator /> : null}
      <Item
        className="hover:bg-muted"
        onClick={() => onOpen(group.key)}
        render={<button type="button" />}
        size="sm"
        variant={framed ? "default" : "muted"}
      >
        <ItemMedia variant="icon">{group.media}</ItemMedia>
        <ItemContent>
          <ItemTitle>{group.title}</ItemTitle>
          <ItemDescription className="line-clamp-1">
            {summaryOf(group, held)}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
    </Fragment>
  ));

  const list = plugins.isPending ? null : plugins.error ? (
    <p className="text-destructive text-xs" role="alert">
      Couldn't load the tools. Reload the page.
    </p>
  ) : framed ? (
    <PageRows>{rows}</PageRows>
  ) : (
    <div className="flex flex-col gap-2">{rows}</div>
  );

  if (framed) return list;

  return (
    <Field>
      <FieldLabel>Tools it needs</FieldLabel>
      <FieldDescription>{TOOLS_EXPLAINED}</FieldDescription>
      {list}
    </Field>
  );
}

/** What declaring a tool does and does not do, said wherever the tools are picked. */
export const TOOLS_EXPLAINED =
  "Using this skill loads these tools for that reply. It doesn't give access. A Bot can only use tools it already has.";

/**
 * Lower-cased, with underscores read as spaces: vendors name tools `TODOIST_CREATE_TASK`, and
 * somebody searching for it types "create task".
 */
function searchable(text: string): string {
  return text.toLowerCase().replaceAll("_", " ");
}

/** The nearest ancestor that scrolls: the page's own scroller, or whatever the form sits in. */
export function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Below this the list would show two or three tools at a time, and scrolling the page to give it more
 * room is the better trade. Roughly three rows' worth.
 */
const FIT_MINIMUM = 240;

/**
 * Caps an element's height at what is left of its page's scroller once everything above it and below
 * it in the form is accounted for, so the page itself never has to scroll past a long list to reach
 * the buttons under it.
 *
 * MEASURED, NOT COMPUTED FROM CLASSES. What sits above the list (the page heading, the step's own
 * heading and search) and below it (the card's padding, its buttons, the page's bottom padding) is
 * read from the drawn elements, and read again whenever the scroller or the form changes size, so a
 * wrapped description or a resized window is accounted for rather than guessed at.
 */
function useFitToWindow(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const scroller = scrollParent(element);
    const form = element.closest("form");
    if (!scroller || !form) return;
    const column = scroller.firstElementChild;

    const fit = () => {
      const box = element.getBoundingClientRect();
      const top =
        box.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const below =
        form.getBoundingClientRect().bottom -
        box.bottom +
        (column
          ? Number.parseFloat(getComputedStyle(column).paddingBottom) || 0
          : 0);
      const room = scroller.clientHeight - top - below;
      element.style.maxHeight = `${Math.max(FIT_MINIMUM, Math.floor(room))}px`;
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    observer.observe(form);
    return () => {
      observer.disconnect();
      element.style.maxHeight = "";
    };
  });
}

/** How many tools an app offers before the step offers a search. */
const SEARCH_FROM = 10;

/**
 * One app's tools, ticked on and off. Changes go straight into the form, so leaving the step by
 * either button keeps them; the form still saves nothing until its own submit.
 *
 * The heading takes focus on arrival, so a keyboard or screen reader lands on the question rather
 * than on the row it just pressed, which is no longer there.
 */
export function SkillToolStep({
  source,
  selected,
  onChange,
  fit = false,
}: {
  source: ToolSource;
  selected: string[];
  onChange: (refs: string[]) => void;
  /**
   * Size the list to the room left in the window and scroll it inside itself, so the form's own
   * buttons stay under it. For a form that is a screen of its own; inline, the list just grows.
   */
  fit?: boolean;
}) {
  const { plugins, groups } = useToolGroups(selected);
  const [search, setSearch] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useFitToWindow(list, fit);

  /*
   * Held for the life of the step. Unticking the last leftover in "Not available here" takes it out
   * of the declaration, which recomputes the group without it; reading the group fresh would empty
   * the step under the person's cursor and leave nothing to tick back.
   */
  const live = groups.find((candidate) => candidate.key === source);
  const [frozen] = useState(() => live);
  const group = frozen ?? live;
  const held = new Set(selected);

  if (plugins.isPending) return null;
  if (!group) {
    return (
      <p className="text-muted-foreground text-sm">
        This app no longer offers any tools.
      </p>
    );
  }

  const query = searchable(search.trim());
  const shown = query
    ? group.choices.filter(
        (choice) =>
          searchable(choice.name).includes(query) ||
          searchable(choice.description).includes(query),
      )
    : group.choices;
  const picked = group.choices.filter((choice) => held.has(choice.ref)).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <span className="inline-flex w-fit items-center gap-2 rounded-lg bg-muted/50 py-1 pr-2.5 pl-1.5 text-sm [&_svg]:size-4">
          {group.media}
          {group.title}
        </span>
        <h2
          className="break-words font-semibold text-lg tracking-tight outline-none"
          ref={heading}
          tabIndex={-1}
        >
          Which tools does it need?
        </h2>
        <p className="text-muted-foreground text-sm">{group.explanation}</p>
      </div>

      {group.choices.length >= SEARCH_FROM ? (
        <div className="flex items-center gap-3">
          <InputGroup className="h-9 flex-1 border-transparent bg-muted/60 shadow-none dark:bg-muted/60">
            <InputGroupAddon>
              <IconSearch aria-hidden="true" className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={`Search ${group.title} tools`}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tools"
              value={search}
            />
          </InputGroup>
          <p className="shrink-0 text-muted-foreground text-xs">
            {picked} picked · {group.choices.length} in all
          </p>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm" role="status">
          Nothing matches “{search.trim()}”.
        </p>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-2",
            fit && "-mx-1 overflow-y-auto overscroll-contain px-1",
          )}
          ref={list}
        >
          {shown.map((choice) => {
            const id = `skill-tool-${choice.ref}`;
            return (
              <Item key={choice.ref} size="sm" variant="muted">
                <ItemMedia>
                  <Checkbox
                    checked={held.has(choice.ref)}
                    id={id}
                    onCheckedChange={() =>
                      onChange(toggled(selected, choice.ref))
                    }
                  />
                </ItemMedia>
                {/* The text is the checkbox's label, so the name and description toggle it too. */}
                <label
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
                  htmlFor={id}
                >
                  <ItemTitle className="break-all font-mono text-xs">
                    {choice.name}
                  </ItemTitle>
                  {choice.description ? (
                    <ItemDescription>{choice.description}</ItemDescription>
                  ) : null}
                </label>
                {/*
                 * Writes are marked. Which tools a skill pulls in is a governance question, and "this
                 * one changes something at the vendor" is the part worth seeing before ticking it
                 * rather than after.
                 */}
                {choice.writes ? (
                  <ItemActions>
                    <span className="text-muted-foreground text-xs">
                      Makes changes
                    </span>
                  </ItemActions>
                ) : null}
              </Item>
            );
          })}
        </div>
      )}
    </div>
  );
}
