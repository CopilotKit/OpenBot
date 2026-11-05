import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { IconBrain } from "@tabler/icons-react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ModelCatalogue, ModelOption } from "@/lib/models/queries";
import { cn } from "@/lib/utils";

/**
 * The model a conversation's Bot answers on, picked in the composer.
 *
 * An icon in the controls row, named by its tooltip and its label, so the row stays as quiet as the
 * other controls. The popup is searchable, because a provider's own list runs to dozens, newest
 * first as the server sends it, with OpenBot's own model marked.
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
  value: string | undefined;
  onChange: (model: string) => void;
  disabled?: boolean;
  /** A pick is being saved: the picker shows it and holds still until the save settles. */
  saving?: boolean;
  className?: string;
}) {
  if (!catalogue?.choosable || !value) return null;
  const selected =
    catalogue.models.find((model) => model.id === value) ??
    catalogue.models.find((model) => model.id === catalogue.default);
  if (!selected) return null;

  return (
    <Combobox<ModelOption>
      items={catalogue.models}
      value={selected}
      onValueChange={(model) => {
        if (model) onChange(model.id);
      }}
      itemToStringLabel={(model) => model.label}
      isItemEqualToValue={(a, b) => a.id === b.id}
      disabled={disabled || saving}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            /*
             * Base UI's trigger rather than `ComboboxTrigger`, which always draws a chevron: this
             * one is an icon button like its neighbours in the row.
             */
            <ComboboxPrimitive.Trigger
              aria-label={`Model: ${selected.label}`}
              className={cn("text-muted-foreground", className)}
              data-slot="composer-model"
              render={<Button size="icon" type="button" variant="ghost" />}
              nativeButton
            >
              <IconBrain className="size-5" aria-hidden />
            </ComboboxPrimitive.Trigger>
          }
        />
        <TooltipContent side="top">{selected.label}</TooltipContent>
      </Tooltip>
      <ComboboxContent
        align="start"
        className="w-72 *:data-[slot=input-group]:m-2 *:data-[slot=input-group]:mt-0"
        side="top"
        sideOffset={8}
      >
        <p className="px-3 pt-3 pb-2 text-sm font-medium">Choose a model</p>
        <ComboboxInput placeholder="Search models" showTrigger={false} />
        <ComboboxEmpty>No models match.</ComboboxEmpty>
        <ComboboxList className="p-1.5 pt-1">
          {(model: ModelOption) => (
            <ComboboxItem
              // `pl` only: the item keeps its own right padding, which is where the check sits.
              className="h-9 gap-2.5 pl-2.5"
              key={model.id}
              value={model}
            >
              <HarnessMark
                className="size-3.5"
                id={model.vendor ?? null}
                name={model.label}
              />
              <span className="min-w-0 truncate">{model.label}</span>
              {model.id === catalogue.default ? (
                <span className="ml-auto shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
                  Default
                </span>
              ) : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
