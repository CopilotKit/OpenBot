import { IconChevronRight, IconCpu } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ModelPicker } from "@/components/channels/composer/model-picker";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import type { AgentProfile } from "@/lib/agents/queries";
import { useBotTakesModelChoice } from "@/lib/bot-agents/queries";
import { loadFailure } from "@/lib/load-failure";
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
              <fieldset
                aria-label="Default model options"
                className="grid gap-2"
                disabled={saving}
              >
                <label className={optionClass}>
                  <input
                    checked={useDeploymentDefault}
                    className={radioClass}
                    name={sourceField}
                    onChange={() => {
                      setUseDeploymentDefault(true);
                      setError(undefined);
                    }}
                    type="radio"
                  />
                  <span className="grid gap-0.5">
                    <span className="font-medium">Use OpenBot's default</span>
                    {deploymentSummary ? (
                      <span className="text-muted-foreground text-xs">
                        {deploymentSummary}
                      </span>
                    ) : null}
                  </span>
                </label>
                <div className="grid gap-2 rounded-lg border border-border has-checked:border-foreground/40 has-checked:bg-muted/30">
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                    <input
                      checked={!useDeploymentDefault}
                      className={radioClass}
                      name={sourceField}
                      onChange={() => {
                        setUseDeploymentDefault(false);
                        setError(undefined);
                      }}
                      type="radio"
                    />
                    <span className="font-medium">
                      Choose a model for this Bot
                    </span>
                  </label>
                  {!useDeploymentDefault ? (
                    <div className="grid gap-1.5 px-3 pb-3">
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
                              catalogue?.models.find(
                                ({ id }) => id === pick.model,
                              )?.defaultEffort === pick.effort
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
                            ? loadFailure(
                                models.error,
                                "Couldn't load the models.",
                              )
                            : "Loading models…"}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </fieldset>
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

const optionClass =
  "flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 has-checked:border-foreground/40 has-checked:bg-muted/30";
const radioClass = "mt-0.5 size-4 shrink-0 accent-foreground";

function modelSummary(model: ModelOption, effort: string | null) {
  const thinking = shownEffort(model, effort);
  return thinking ? `${model.label} · ${effortLabel(thinking)}` : model.label;
}
