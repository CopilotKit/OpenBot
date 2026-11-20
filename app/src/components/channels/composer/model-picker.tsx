import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import {
  IconCheck,
  IconChevronDown,
  IconCpu,
  IconCube,
} from "@tabler/icons-react";
import { useMemo, useRef, useState } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { markFor } from "@/lib/marks";
import {
  effortLabel,
  type ModelPick,
  shownEffort,
  switchModel,
  thinks,
} from "@/lib/models/effort";
import type { ModelCatalogue, ModelOption } from "@/lib/models/queries";
import { cn } from "@/lib/utils";

/** The composer's message box around `inside`, if it is in one. */
function messageBox(inside: HTMLElement | null): HTMLElement | null {
  return (
    inside
      ?.closest('[data-slot="composer"]')
      ?.querySelector<HTMLElement>(
        '[data-slot="composer-input"] [role="textbox"]',
      ) ?? null
  );
}

/** One row of the popup: a model, or a thinking effort for the model in use. */
type Choice =
  | { kind: "model"; model: ModelOption }
  | {
      kind: "effort";
      /** Null is the model's own default, offered as its own row when nobody knows what it is. */
      effort: string | null;
      label: string;
    };

type ChoiceGroup = { value: "models" | "thinking"; items: Choice[] };

const sameChoice = (a: Choice, b: Choice) =>
  a.kind === "model"
    ? b.kind === "model" && a.model.id === b.model.id
    : b.kind === "effort" && a.effort === b.effort;

/**
 * The word beside OpenBot's own model, and beside a model's own effort: quiet text at the row's end,
 * in one style on every row, so it reads on the highlighted row too (a filled tag once matched the
 * highlight and vanished). The row's own right padding keeps it clear of the check.
 */
function DefaultTag() {
  return (
    <span className="ml-auto shrink-0 pr-5 text-muted-foreground text-xs">
      Default
    </span>
  );
}

/**
 * A model's mark, or a plain model icon where its maker has none vendored (a gateway's own alias,
 * such as `fast`), so no row starts with an empty gap. The icon is the app's, never a stand-in
 * drawn for somebody's brand; see `shared/marks/README.md`.
 */
function ModelMark({ model }: { model: ModelOption }) {
  return markFor(model.vendor) ? (
    <HarnessMark
      className="size-3.5"
      id={model.vendor ?? null}
      name={model.label}
    />
  ) : (
    <IconCube aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
  );
}

/**
 * The model a conversation's Bot answers on, and how hard it thinks, picked in the composer.
 *
 * A quiet icon button in the controls row, a CPU and a chevron, rather than the model's mark and
 * name: the row has the send and dictation controls to fit, and a name of any length crowded them.
 * The tooltip and the button's accessible name say the model and its effort ("GPT-6.1 Terra ·
 * High"). The popup is searchable, because a provider's own list runs to dozens,
 * newest first as the server sends it, with OpenBot's own model marked.
 *
 * PICKING A MODEL THAT TAKES NO EFFORT CLOSES IT, as a menu closes, and puts the person back in
 * the message box. Picking one that does keeps it open ON ITS EFFORTS ALONE: the models and the
 * search go, so the popup is the small "Thinking" column and nothing in it is another model.
 * Picking an effort then closes it, back to the message box. On Windows the popup once stayed open
 * on both columns after a model was picked, and the person's next click, meant for the message
 * box, landed on another model in the list: two testers ended up on a model they never chose. Esc
 * and a click outside close it too; reopened, it shows both columns again.
 *
 * TWO COLUMNS, ONE LIST, as T3 Code lays it out: the search and the models on the left, and the
 * model in use's efforts in a "Thinking" column on the right. A listbox option cannot hold a second
 * control, so the efforts are a second group of the same listbox, placed beside the models by the
 * popup's grid (the list itself is `display: contents`). One list means one keyboard model: the
 * arrows run from the models into the efforts and Enter picks either, and a screen reader hears the
 * efforts as options in a labelled group. The models scroll on their own; the efforts stay put, and
 * stay while a search is typed, since a search only ever looks for a model. A model that takes no
 * effort has no column, and the popup is one column wide.
 *
 * Renders nothing when there is nothing to pick: a plan, a provider that could not be read, or an
 * allowlist that leaves one model.
 */
export function ModelPicker({
  catalogue,
  value,
  onChange,
  disabled,
  saving,
  className,
}: {
  catalogue: ModelCatalogue | undefined;
  value: ModelPick | undefined;
  onChange: (pick: ModelPick) => void;
  disabled?: boolean;
  /** A pick is being saved: the picker shows it and holds still until the save settles. */
  saving?: boolean;
  className?: string;
}) {
  if (!catalogue?.choosable || !value) return null;
  const selected =
    catalogue.models.find((model) => model.id === value.model) ??
    catalogue.models.find((model) => model.id === catalogue.default);
  if (!selected) return null;
  return (
    <Picker
      catalogue={catalogue}
      className={className}
      disabled={disabled || saving}
      effort={value.model === selected.id ? value.effort : null}
      onChange={onChange}
      selected={selected}
    />
  );
}

function Picker({
  catalogue,
  selected,
  effort,
  onChange,
  disabled,
  className,
}: {
  catalogue: ModelCatalogue;
  selected: ModelOption;
  effort: string | null;
  onChange: (pick: ModelPick) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { contains } = ComboboxPrimitive.useFilter();
  /** What is typed in the search, to say when no model matches: the efforts always do. */
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  /** A choice was just picked: the close it asks for puts focus in the message box. */
  const picked = useRef(false);
  /*
   * A model that thinks was just picked: the close that press asks for is turned down, and the
   * popup shows that model's efforts alone (`effortStep`) until it closes.
   */
  const stayOpen = useRef(false);
  const [effortStep, setEffortStep] = useState(false);
  const current: Choice = useMemo(
    () => ({ kind: "model", model: selected }),
    [selected],
  );
  /** The effort the model will run at, chosen or its own: the row that carries the check. */
  const running = shownEffort(selected, effort) ?? null;
  const groups = useMemo((): ChoiceGroup[] => {
    const models: ChoiceGroup = {
      value: "models",
      items: catalogue.models.map((model) => ({ kind: "model", model })),
    };
    if (!thinks(selected)) return [models];
    const efforts: Choice[] = (selected.efforts ?? []).map((level) => ({
      kind: "effort",
      effort: level,
      label: effortLabel(level),
    }));
    // A provider that does not say which effort is its default still has one: offer it by name.
    if (!selected.defaultEffort)
      efforts.unshift({ kind: "effort", effort: null, label: "Default" });
    const thinking: ChoiceGroup = { value: "thinking", items: efforts };
    return effortStep ? [thinking] : [models, thinking];
  }, [catalogue.models, selected, effortStep]);

  const matches = (model: ModelOption, typed: string) =>
    contains(model.label, typed) || contains(model.id, typed);
  const noModels =
    query.trim() !== "" &&
    !catalogue.models.some((model) => matches(model, query));
  const twoColumns = groups.length > 1;
  /** On the efforts alone: only the "Thinking" column shows. */
  const effortsOnly = effortStep && thinks(selected);

  const effortText = running ? effortLabel(running) : null;
  const shown = effortText
    ? `${selected.label} · ${effortText}`
    : selected.label;

  return (
    <Combobox<Choice>
      disabled={disabled}
      // A search looks for a model; the efforts belong to the model in use and stay in their column.
      filter={(choice, typed) =>
        choice.kind === "effort" || matches(choice.model, typed)
      }
      isItemEqualToValue={sameChoice}
      items={groups}
      itemToStringLabel={(choice) =>
        choice.kind === "model" ? choice.model.label : choice.label
      }
      onInputValueChange={setQuery}
      onOpenChange={(next, details) => {
        const keep =
          !next && stayOpen.current && details.reason === "item-press";
        stayOpen.current = false;
        if (keep) {
          setEffortStep(true);
          return;
        }
        // Opened or closed: both columns, the next time it shows.
        setEffortStep(false);
        setOpen(next);
      }}
      onValueChange={(choice) => {
        if (!choice) return;
        stayOpen.current = choice.kind === "model" && thinks(choice.model);
        picked.current = !stayOpen.current;
        onChange(
          choice.kind === "model"
            ? switchModel({ model: selected.id, effort }, choice.model)
            : { model: selected.id, effort: choice.effort },
        );
      }}
      open={open}
      value={current}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            /*
             * Base UI's trigger rather than `ComboboxTrigger`, which draws its own larger chevron:
             * this one is a ghost button like its neighbours in the row.
             */
            <ComboboxPrimitive.Trigger
              ref={trigger}
              aria-label={
                effortText
                  ? `Model: ${selected.label}, thinking: ${effortText}`
                  : `Model: ${selected.label}`
              }
              className={cn(
                "h-8 shrink-0 gap-1 px-2 font-normal text-muted-foreground",
                className,
              )}
              data-slot="composer-model"
              render={<Button size="sm" type="button" variant="ghost" />}
              nativeButton
            >
              <IconCpu aria-hidden className="size-4 shrink-0" />
              <IconChevronDown aria-hidden className="size-3.5 shrink-0" />
            </ComboboxPrimitive.Trigger>
          }
        />
        <TooltipContent side="top">{shown}</TooltipContent>
      </Tooltip>
      <ComboboxContent
        align="start"
        className={cn(
          // A grid: the search over the models on the left, the efforts down the right.
          "grid grid-rows-[auto_minmax(0,1fr)] *:data-[slot=input-group]:m-2 *:data-[slot=input-group]:mb-1",
          effortsOnly
            ? "w-44 grid-cols-1"
            : twoColumns
              ? "w-[30rem] grid-cols-[minmax(0,1fr)_11rem]"
              : "w-72 grid-cols-1",
        )}
        // After a pick, the message box, where the person goes next; otherwise back to the trigger.
        finalFocus={() => {
          const toMessage = picked.current;
          picked.current = false;
          return (toMessage && messageBox(trigger.current)) || true;
        }}
        side="top"
        sideOffset={8}
      >
        <ComboboxInput
          // On the efforts alone there is no model to search for: it stays only to keep the keys.
          className={
            effortsOnly
              ? // Out of the popup's flow, so it takes no row: as `sr-only` it still held one, a
                // blank band under the last effort.
                "pointer-events-none absolute! m-0! h-0! w-0! overflow-hidden border-0! opacity-0"
              : "col-start-1 row-start-1"
          }
          placeholder="Search models"
          showTrigger={false}
        />
        {noModels && !effortsOnly ? (
          <p className="col-start-1 row-start-2 px-3 py-6 text-center text-muted-foreground text-sm">
            No models match.
          </p>
        ) : null}
        <ComboboxList className="contents">
          {(group: ChoiceGroup) =>
            group.value === "models" ? (
              <ComboboxGroup
                aria-label="Models"
                className="no-scrollbar col-start-1 row-start-2 max-h-[min(20rem,calc(var(--available-height)-4rem))] min-h-0 scroll-py-1 overflow-y-auto overscroll-contain p-1.5 pt-0.5"
                items={group.items}
                key="models"
              >
                <ComboboxCollection>
                  {(choice: Choice) =>
                    choice.kind === "model" ? (
                      <ComboboxItem
                        // `pl` only: the item keeps its own right padding, where the check sits.
                        className="h-9 gap-2.5 pl-2.5"
                        key={choice.model.id}
                        value={choice}
                      >
                        <ModelMark model={choice.model} />
                        <span className="min-w-0 truncate">
                          {choice.model.label}
                        </span>
                        {choice.model.id === catalogue.default ? (
                          <DefaultTag />
                        ) : null}
                      </ComboboxItem>
                    ) : null
                  }
                </ComboboxCollection>
              </ComboboxGroup>
            ) : (
              <ComboboxGroup
                className={cn(
                  "min-h-0 overflow-y-auto p-1.5",
                  effortsOnly
                    ? "col-start-1 row-span-2 row-start-1"
                    : "col-start-2 row-span-2 row-start-1 border-l",
                )}
                items={group.items}
                key="thinking"
              >
                {/*
                 * Headed with the model it belongs to, as the column beside a list of models. The
                 * name sits outside the label, so the group is still called "Thinking".
                 */}
                <div className="flex h-10 items-center gap-2 px-2.5">
                  <ComboboxLabel className="p-0">Thinking</ComboboxLabel>
                  <span
                    aria-hidden
                    className="ml-auto min-w-0 truncate text-muted-foreground text-xs"
                  >
                    {selected.label}
                  </span>
                </div>
                <ComboboxCollection>
                  {(choice: Choice) =>
                    choice.kind === "effort" ? (
                      <ComboboxItem
                        // The combobox's own value is the model, so an effort says itself whether
                        // it is the one in use, and draws its own check where the model's sits.
                        aria-selected={choice.effort === running}
                        className="h-9 pl-2.5"
                        key={choice.effort ?? "default"}
                        value={choice}
                      >
                        <span className="min-w-0 truncate">{choice.label}</span>
                        {choice.effort !== null &&
                        choice.effort === selected.defaultEffort ? (
                          <DefaultTag />
                        ) : null}
                        {choice.effort === running ? (
                          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                            <IconCheck />
                          </span>
                        ) : null}
                      </ComboboxItem>
                    ) : null
                  }
                </ComboboxCollection>
              </ComboboxGroup>
            )
          }
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
