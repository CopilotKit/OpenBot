import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ModelPicker } from "@/components/channels/composer/model-picker";
import { IconChevronRight, IconCpu } from "@/components/icons";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { AgentProfile } from "@/lib/agents/queries";
import { useBotTakesModelChoice } from "@/lib/bot-agents/queries";
import {
  effortLabel,
  type ModelPick,
  offeredBotDefault,
  shownEffort,
  shownPick,
} from "@/lib/models/effort";
import {
  type ModelOption,
  modelCatalogueQueryOptions,
} from "@/lib/models/queries";

export function DefaultModelSection({
  agent,
  onSave,
  saving,
}: {
  agent: AgentProfile;
  onSave: (pick: ModelPick | null) => Promise<unknown>;
  saving: boolean;
}) {
  const eligible = useBotTakesModelChoice(agent);
  const models = useQuery({
    ...modelCatalogueQueryOptions(),
    enabled: eligible,
  });
  const catalogue = models.data;
  const saved = offeredBotDefault(agent.defaultModel, catalogue);
  const deploymentModel = catalogue?.models.find(
    ({ id }) => id === catalogue.default,
  );
  const deploymentPick = shownPick(null, catalogue);
  const savedModel = catalogue?.models.find(({ id }) => id === saved?.model);
  const sourceField = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ModelPick>();
  const [useDeploymentDefault, setUseDeploymentDefault] = useState(true);
  const [error, setError] = useState<string>();
  if (!eligible) return null;

  const open = () => {
    setDraft(undefined);
    setUseDeploymentDefault(
      !agent.defaultModel || Boolean(catalogue && !saved),
    );
    setError(undefined);
    setEditing(true);
  };
  const custom = draft ?? saved ?? deploymentPick;
  const changed = useDeploymentDefault
    ? agent.defaultModel !== null
    : custom !== undefined &&
      (custom.model !== saved?.model || custom.effort !== saved.effort);
  const save = async () => {
    if (!useDeploymentDefault && !custom) return;
    try {
      await onSave(useDeploymentDefault ? null : (custom ?? null));
      setEditing(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save the default model.",
      );
    }
  };
  const deploymentSummary = deploymentModel
    ? modelSummary(deploymentModel, null)
    : undefined;
  const summary = savedModel
    ? modelSummary(savedModel, saved?.effort ?? null)
    : agent.defaultModel && catalogue
      ? "The chosen model isn't available. New conversations use OpenBot's default."
      : (agent.defaultModel?.model ??
        (deploymentSummary
          ? `OpenBot's default · ${deploymentSummary}`
          : "OpenBot's default"));

  return (
    <PageSection title="Model">
      <PageRows>
        <Item
          size="sm"
          render={
            agent.canManage ? (
              <button type="button" onClick={open} />
            ) : undefined
          }
        >
          <ItemMedia variant="icon">
            <IconCpu />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Default model</ItemTitle>
            <ItemDescription>{summary}</ItemDescription>
          </ItemContent>
          {agent.canManage ? (
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          ) : null}
        </Item>
      </PageRows>
      {editing ? (
        <Dialog
          open
          onOpenChange={(next) => !next && !saving && setEditing(false)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Default model</DialogTitle>
              <DialogDescription>
                New conversations with this Bot start on this model. A
                conversation keeps the model it started on, and a model picked
                in the conversation comes first.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-4 grid gap-3">
              {/* The kit's radios, each choice a card that is its own label. */}
              <RadioGroup
                aria-label="Default model options"
                className="gap-2"
                disabled={saving}
                onValueChange={(value) => {
                  setUseDeploymentDefault(value === "default");
                  setError(undefined);
                }}
                value={useDeploymentDefault ? "default" : "custom"}
              >
                <FieldLabel htmlFor={`${sourceField}-default`}>
                  <Field orientation="horizontal">
                    <RadioGroupItem
                      id={`${sourceField}-default`}
                      value="default"
                    />
                    <FieldContent>
                      <FieldTitle>Use OpenBot's default</FieldTitle>
                      {deploymentSummary ? (
                        <FieldDescription>{deploymentSummary}</FieldDescription>
                      ) : null}
                    </FieldContent>
                  </Field>
                </FieldLabel>
                <FieldLabel htmlFor={`${sourceField}-custom`}>
                  <Field orientation="horizontal">
                    <RadioGroupItem
                      id={`${sourceField}-custom`}
                      value="custom"
                    />
                    <FieldContent>
                      <FieldTitle>Choose a model for this Bot</FieldTitle>
                    </FieldContent>
                  </Field>
                </FieldLabel>
              </RadioGroup>
              {/*
               * Under the choices rather than inside the second, which is a label: a click on the
               * picker would also reach its radio.
               */}
              {!useDeploymentDefault ? (
                <div className="grid gap-1.5">
                  <p className="text-muted-foreground text-xs">
                    Model and thinking level
                  </p>
                  <ModelPicker
                    allowSingle
                    catalogue={catalogue}
                    disabled={saving}
                    onChange={(pick) => {
                      setDraft({
                        ...pick,
                        effort:
                          catalogue?.models.find(({ id }) => id === pick.model)
                            ?.defaultEffort === pick.effort
                            ? null
                            : pick.effort,
                      });
                      setError(undefined);
                    }}
                    showValue
                    value={custom}
                  />
                  {!catalogue ? (
                    <p className="text-sm text-muted-foreground">
                      {models.isError
                        ? "Couldn't load the models."
                        : "Loading models…"}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={saving || !changed}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </PageSection>
  );
}

function modelSummary(model: ModelOption, effort: string | null) {
  const thinking = shownEffort(model, effort);
  return thinking ? `${model.label} · ${effortLabel(thinking)}` : model.label;
}
