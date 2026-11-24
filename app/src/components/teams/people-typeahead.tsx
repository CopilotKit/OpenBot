import { IconCornerDownLeft, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { PersonAvatar } from "@/components/organizations/person-avatar";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { completionOf, matchIn } from "@/lib/teams/people-search";
import {
  type OrganizationPerson,
  peopleSearchQueryOptions,
  peopleSearchText,
} from "@/lib/teams/queries";
import { cn } from "@/lib/utils";
import { failureSaid } from "@/lib/load-failure";

/** How long typing rests before the server is asked: short enough to feel like every keystroke. */
const DEBOUNCE_MS = 120;

/** How long an answer may take before the box says it is still searching. */
const SLOW_MS = 300;

/**
 * The box for picking somebody from the organization: adding them to a team, to a group
 * conversation, or to who a Bot is published to. Type-ahead, as the WAI-ARIA editable combobox with
 * a list and inline completion (aria-autocomplete="both").
 *
 * As somebody types, the server is asked for the organization's members matching it (name, first or
 * last name, or address; best matches first), one short page of them, and they are
 * listed under the box. Only the organization's own members are ever asked for or shown: nobody
 * outside it is found here, and inviting somebody new is a plain address box elsewhere. The top
 * person who can be chosen is highlighted, and the rest of their name or address is completed in the
 * box, selected after the caret: Tab takes the completion, Enter chooses the highlighted person, and
 * typing on replaces it. Arrow keys move through the list, Escape closes it and then clears the box.
 * Focus never leaves the box, so several people are chosen in a row. People who are there already
 * (`unavailable`) are listed as such and can't be chosen.
 */
export function PeopleTypeahead({
  label,
  unavailable,
  onChoose,
  onSearch,
  announcement,
  name = "Name or email",
  autoFocus = true,
  waiting = false,
}: {
  /** What the list of people found is called to a screen reader: "People to add to Sales". */
  label: string;
  /**
   * Why somebody found can't be chosen, in a few words ("In this team"), or null when they can:
   * who is there already, including anybody being added right now.
   */
  unavailable: (person: OrganizationPerson) => string | null;
  onChoose: (person: OrganizationPerson) => void;
  /** Told what is searched for each time it changes, as it is sent to the server. */
  onSearch?: (search: string) => void;
  /** Said to a screen reader once the box is empty again: who was just added. */
  announcement?: string | undefined;
  /** The box's name, for a screen reader and as its placeholder. */
  name?: string;
  autoFocus?: boolean;
  /**
   * Whether what `unavailable` needs is still on its way (who of those found is in the team): the
   * people found wait for it, so nobody is offered as choosable and then taken back.
   */
  waiting?: boolean;
}) {
  const id = useId();
  const listId = `${id}-people`;
  const optionId = (index: number) => `${id}-person-${index}`;
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const [typed, setTyped] = useState("");
  // Whether the last edit added text: a completion follows typing, never a deletion.
  const [completing, setCompleting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);

  const search = peopleSearchText(useDebounced(typed, DEBOUNCE_MS));
  const found = useQuery({
    ...peopleSearchQueryOptions(search),
    enabled: search !== "",
    // What was found stays on screen while the answer to more of the same typing is on its way,
    // and never for a search that starts afresh (after somebody is added and the box empties).
    placeholderData: (previous, previousQuery) => {
      const was = previousQuery?.queryKey[2].search;
      return was !== undefined &&
        was !== "" &&
        (search.startsWith(was) || was.startsWith(search))
        ? previous
        : undefined;
    },
  });
  useEffect(() => {
    onSearch?.(search);
  }, [onSearch, search]);
  // Nobody is offered until who can be chosen is known too.
  const answered = waiting ? undefined : found.data;
  const fetching = found.isFetching || waiting;
  const slow = useAfter(fetching, SLOW_MS);

  const open = typed.trim() !== "" && !dismissed;
  const people = open ? (answered ?? []) : [];
  const choosable = people.flatMap((person, index) =>
    unavailable(person) !== null ? [] : [index],
  );

  // A fresh answer highlights the best person who can be chosen.
  const answer = answered;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new answer moves the highlight; somebody who can no longer be chosen is skipped by `current` below.
  useEffect(() => {
    if (!answer) return;
    setActive(answer.findIndex((person) => unavailable(person) === null));
  }, [answer]);

  // The highlighted person, while they can still be added.
  const current =
    active >= 0 && choosable.includes(active) ? active : (choosable[0] ?? -1);
  const person = current >= 0 ? people[current] : undefined;
  // The person's whole name or address when it starts with what was typed, written as theirs.
  const completion =
    open && completing && person ? completionOf(person, typed) : "";
  const shown = completion || typed;
  // Where the caret goes once the box shows the next value: the end, after a completion is taken.
  const caretToEnd = useRef(false);

  // The part not typed is selected, after the caret, so typing on replaces it. A completion just
  // taken leaves the caret at the end, with nothing selected.
  useLayoutEffect(() => {
    const box = input.current;
    if (!box || document.activeElement !== box) return;
    if (caretToEnd.current) {
      caretToEnd.current = false;
      box.setSelectionRange(shown.length, shown.length);
    } else if (completion) box.setSelectionRange(typed.length, shown.length);
  }, [completion, typed.length, shown.length]);

  // The highlighted person is kept in view.
  useEffect(() => {
    if (current < 0) return;
    list.current
      ?.querySelector(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const choose = (chosen: OrganizationPerson) => {
    if (unavailable(chosen) !== null) return;
    onChoose(chosen);
    setTyped("");
    setCompleting(false);
    setActive(-1);
    input.current?.focus();
  };

  /**
   * Take the completion as typed: the box keeps the whole name or address, written as the person's
   * own, with the caret at its end and nothing selected, so typing on adds to it.
   */
  const accept = () => {
    caretToEnd.current = true;
    setTyped(shown);
    setCompleting(false);
    // The value may already read exactly this, which renders nothing new: move the caret now too.
    input.current?.setSelectionRange(shown.length, shown.length);
  };

  const move = (step: 1 | -1) => {
    if (choosable.length === 0) return;
    const at = choosable.indexOf(current);
    const next =
      at < 0
        ? step === 1
          ? 0
          : choosable.length - 1
        : (at + step + choosable.length) % choosable.length;
    setActive(choosable[next] ?? -1);
    setCompleting(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          if (typed.trim() !== "") setDismissed(false);
          return;
        }
        move(event.key === "ArrowDown" ? 1 : -1);
        return;
      case "Enter":
        if (typed.trim() === "") return;
        event.preventDefault();
        if (open && person) choose(person);
        return;
      case "Tab":
        if (!completion || event.shiftKey) return;
        event.preventDefault();
        accept();
        return;
      case "ArrowRight":
      case "End":
        // Moving past the completion keeps it.
        if (completion) accept();
        return;
      case "Escape":
        // The list closes first, then the box empties; only an empty box lets the dialog close.
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          setDismissed(true);
        } else if (typed !== "") {
          event.preventDefault();
          event.stopPropagation();
          setTyped("");
          setCompleting(false);
        }
        return;
    }
  };

  const status = !open
    ? (announcement ?? "")
    : found.error && !found.data
      ? ""
      : slow
        ? "Searching…"
        : answered && !found.isPlaceholderData
          ? answered.length === 0
            ? "No matches"
            : `${answered.length} ${answered.length === 1 ? "person" : "people"} found`
          : "";

  return (
    // Room under the list for its ring and shadow, which the dialog's scrolling body would clip.
    <div className="flex flex-col gap-1.5 pb-1.5">
      <InputGroup>
        <InputGroupAddon>
          <IconSearch />
        </InputGroupAddon>
        <InputGroupInput
          aria-activedescendant={
            open && current >= 0 ? optionId(current) : undefined
          }
          aria-autocomplete="both"
          aria-controls={open ? listId : undefined}
          aria-expanded={open}
          aria-label={name}
          autoComplete="off"
          autoFocus={autoFocus}
          onChange={(event) => {
            const next = event.target.value;
            // A deletion as the browser names it, or, where it names none, text that got no longer.
            const kind = (event.nativeEvent as Partial<InputEvent>).inputType;
            const deleting = kind
              ? kind.startsWith("delete")
              : next.length <= typed.length;
            setTyped(next);
            setCompleting(!deleting);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          placeholder="Name or email"
          ref={input}
          role="combobox"
          spellCheck={false}
          value={shown}
        />
      </InputGroup>
      {/* What a screen reader hears as the list changes: how many were found, or who was added. */}
      <p aria-live="polite" className="sr-only" role="status">
        {status}
      </p>
      {open ? (
        <div
          aria-busy={fetching || undefined}
          className="overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
          data-slot="people-typeahead-results"
        >
          {found.error && !found.data ? (
            <p className="px-3 py-2.5 text-destructive text-sm" role="alert">
              {failureSaid(found.error)}
            </p>
          ) : !answered ? (
            slow ? (
              <p className="px-3 py-2.5 text-muted-foreground text-sm">
                Searching…
              </p>
            ) : null
          ) : answered.length === 0 && !found.isPlaceholderData ? (
            <div className="flex items-start gap-3 px-3 py-2.5">
              <IconSearch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-medium text-sm">No matches</p>
                <p className="break-words text-muted-foreground text-sm">
                  Nobody in this organization matches “{typed.trim()}”.
                </p>
              </div>
            </div>
          ) : (
            <div
              aria-label={label}
              className="no-scrollbar flex max-h-80 scroll-py-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1"
              id={listId}
              ref={list}
              role="listbox"
            >
              {people.map((one, index) => {
                const why = unavailable(one);
                const member = why !== null;
                const highlighted = index === current;
                return (
                  // The box keeps focus (aria-activedescendant), so an option is never tabbed to,
                  // and the box's own keys choose it; the pointer chooses it too.
                  // biome-ignore lint/a11y/useKeyWithClickEvents: chosen with the box's keys, which keep focus.
                  <div
                    aria-disabled={member || undefined}
                    // Said whole: the bold part and the initials are for the eye.
                    aria-label={[
                      one.name ?? one.email,
                      one.name ? one.email : null,
                      why?.toLowerCase() ?? null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    aria-selected={highlighted}
                    className={cn(
                      "flex min-w-0 cursor-default select-none items-center gap-3 rounded-md px-2 py-1.5 text-sm",
                      highlighted && "bg-accent text-accent-foreground",
                      member && "opacity-60",
                    )}
                    data-highlighted={highlighted || undefined}
                    data-index={index}
                    id={optionId(index)}
                    key={one.id}
                    onClick={() => choose(one)}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (!member && index !== current) setActive(index);
                    }}
                    role="option"
                    tabIndex={-1}
                  >
                    <PersonAvatar person={one} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        <Matched text={one.name ?? one.email} typed={typed} />
                      </p>
                      {one.name ? (
                        <p
                          className={cn(
                            "truncate text-xs",
                            highlighted
                              ? "text-accent-foreground/70"
                              : "text-muted-foreground",
                          )}
                        >
                          <Matched text={one.email} typed={typed} />
                        </p>
                      ) : null}
                    </div>
                    {member ? (
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {why}
                      </span>
                    ) : highlighted ? (
                      <span
                        aria-hidden
                        className="flex shrink-0 items-center gap-1 text-accent-foreground/70 text-xs"
                      >
                        <IconCornerDownLeft className="size-3.5" />
                        <span className="max-sm:hidden">Add</span>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A name or address with the part that matches what was typed in bold. */
function Matched({ text, typed }: { text: string; typed: string }): ReactNode {
  const range = matchIn(text, typed);
  if (!range) return text;
  const [start, end] = range;
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-transparent font-semibold text-current">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Whether `on` has been true for `ms` without a break. */
function useAfter(on: boolean, ms: number): boolean {
  const [after, setAfter] = useState(false);
  useEffect(() => {
    if (!on) {
      setAfter(false);
      return;
    }
    const timer = setTimeout(() => setAfter(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return after;
}
