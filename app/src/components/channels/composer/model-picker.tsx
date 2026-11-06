import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { IconCheck, IconChevronDown, IconCube } from "@tabler/icons-react";
import { useMemo } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { Badge } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
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
import {
  effortLabel,
  type ModelPick,
  shownEffort,
  switchModel,
  thinks,
} from "@/lib/models/effort";
import type { ModelCatalogue, ModelOption } from "@/lib/models/queries";
import { markFor } from "@/lib/marks";
import { cn } from "@/lib/utils";

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
 * The tag beside OpenBot's own model, and beside a model's own effort: the app's own Badge, in one
 * style on every row. Its tint is drawn over whatever is under it, so it stays visible on the row
 * the pointer or the keyboard is on, where a muted fill matched the highlight and vanished.
 */
function DefaultTag() {
  return (
    <span className="ml-auto shrink-0">
      <Badge tone="neutral">Default</Badge>
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
 * A quiet text button in the controls row naming the model and its effort, "GPT-6.1 Terra · High",
 * as VS Code's chat does. The popup is searchable, because a provider's own list runs to dozens,
 * newest first as the server sends it, with OpenBot's own model marked.
 *
 * THE EFFORTS SIT UNDER THE LIST, NOT IN A SUBMENU. VS Code opens a submenu from an arrow on each
 * model; a listbox option cannot hold a second control, so here the model in use gets a "Thinking"
 * group pinned at the bottom of the same list. One list means one keyboard model: the arrows run
 * from the models into the efforts and Enter picks either, and a screen reader hears the efforts as
 * options in a labelled group. The group stays put while the models scroll, and steps aside while a
 * search is typed, so a search is only ever a search for a model. A model that takes no effort has
 * no group at all.
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
    return [models, { value: "thinking", items: efforts }];
  }, [catalogue.models, selected]);

  const effortText = running ? effortLabel(running) : null;
  const shown = effortText
    ? `${selected.label} · ${effortText}`
    : selected.label;

  return (
    <Combobox<Choice>
      disabled={disabled}
      // A search looks for a model; the efforts belong to the model in use and step aside.
      filter={(choice, query) =>
        choice.kind === "model" &&
        (contains(choice.model.label, query) ||
          contains(choice.model.id, query))
      }
      isItemEqualToValue={sameChoice}
      items={groups}
      itemToStringLabel={(choice) =>
        choice.kind === "model" ? choice.model.label : choice.label
      }
      onValueChange={(choice) => {
        if (!choice) return;
        onChange(
          choice.kind === "model"
            ? switchModel({ model: selected.id, effort }, choice.model)
            : { model: selected.id, effort: choice.effort },
        );
      }}
      value={current}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            /*
             * Base UI's trigger rather than `ComboboxTrigger`, which draws its own larger chevron:
             * this one is a ghost button like its neighbours in the row. It shrinks before the
             * send and dictation controls do, and the model's name gives way before its effort.
             */
            <ComboboxPrimitive.Trigger
              aria-label={
                effortText
                  ? `Model: ${selected.label}, thinking: ${effortText}`
                  : `Model: ${selected.label}`
              }
              className={cn(
                "h-8 min-w-0 shrink gap-1.5 px-2 font-normal text-muted-foreground",
                className,
              )}
              data-slot="composer-model"
              render={<Button size="sm" type="button" variant="ghost" />}
              nativeButton
            >
              <ModelMark model={selected} />
              {/*
               * In a narrow column the name gives way first, down to a few letters, and only then
               * the effort: the name says which model this is, and the tooltip has the rest.
               */}
              <span className="flex min-w-0 overflow-hidden">
                <span className="min-w-12 truncate">{selected.label}</span>
                {effortText ? (
                  <span className="shrink-0">{` · ${effortText}`}</span>
                ) : null}
              </span>
              <IconChevronDown aria-hidden className="size-3.5 shrink-0" />
            </ComboboxPrimitive.Trigger>
          }
        />
        <TooltipContent side="top">{shown}</TooltipContent>
      </Tooltip>
      <ComboboxContent
        align="start"
        className="flex w-72 flex-col *:data-[slot=input-group]:m-2 *:data-[slot=input-group]:mt-0"
        side="top"
        sideOffset={8}
      >
        <p className="px-3 pt-3 pb-2 text-sm font-medium">Choose a model</p>
        <ComboboxInput placeholder="Search models" showTrigger={false} />
        <ComboboxEmpty>No models match.</ComboboxEmpty>
        {/*
         * The list is a column rather than the scroller: the models scroll inside it, and the
         * thinking group under them stays in view however long the list of models runs.
         */}
        <ComboboxList className="flex max-h-104 min-h-0 flex-col overflow-hidden p-0">
          {(group: ChoiceGroup) =>
            group.value === "models" ? (
              <ComboboxGroup
                aria-label="Models"
                className="no-scrollbar min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1.5 pt-1"
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
                className="shrink-0 border-t p-1.5"
                items={group.items}
                key="thinking"
              >
                <ComboboxLabel className="px-2.5">Thinking</ComboboxLabel>
                <ComboboxCollection>
                  {(choice: Choice) =>
                    choice.kind === "effort" ? (
                      <ComboboxItem
                        // The combobox's own value is the model, so an effort says itself whether
                        // it is the one in use, and draws its own check where the model's sits.
                        aria-selected={choice.effort === running}
                        className="h-8 pl-2.5"
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
