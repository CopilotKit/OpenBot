import {
  IconBrain,
  IconChartBar,
  IconChevronRight,
  IconKey,
  IconSearch,
  IconShieldLock,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
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
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { modelUsageQueryOptions } from "@/lib/enterprise/queries";
import { availableModelsQueryOptions } from "@/lib/models/queries";
import { ControlsSection } from "./controls-section";

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/**
 * Admin, Providers: what serves the models built-in Bots run on. One today, read from the
 * deployment's configuration; a row each once a deployment can hold more than one.
 */
export function ProviderSection() {
  const available = useQuery(availableModelsQueryOptions());
  return (
    <ControlsSection
      description="Built-in Bots run on models from this provider, or from the gateway set in OPENAI_BASE_URL."
      title="Connected"
    >
      {() =>
        available.isPending ? null : available.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't load the provider. Reload the page.
          </p>
        ) : (
          <PageRows>
            <Item size="sm">
              <ItemMedia>
                <HarnessMark
                  id={available.data.provider}
                  name={
                    PROVIDER_NAMES[available.data.provider] ??
                    available.data.provider
                  }
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {PROVIDER_NAMES[available.data.provider] ??
                    available.data.provider}
                </ItemTitle>
                <ItemDescription>
                  {available.data.listed
                    ? `Default ${available.data.default} · ${available.data.models.length} models listed`
                    : `Default ${available.data.default} · couldn't read its models`}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        )
      }
    </ControlsSection>
  );
}

/** Admin, Providers: whether people may pick the model a built-in Bot answers on. */
export function ModelChoiceSection() {
  return (
    <ControlsSection
      description={(data) =>
        `Built-in Bots run on ${data.builtInModel ?? "the configured model"} unless a person picks another in the conversation.`
      }
      title="In conversations"
    >
      {({ data, setSetting, saving }) => (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconBrain />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Let people choose a model</ItemTitle>
              <ItemDescription>
                {data.settings.modelSelection
                  ? "People can pick a model for built-in Bots in each conversation."
                  : "Off. Built-in Bots use the configured model."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Let people choose a model"
                checked={data.settings.modelSelection}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  setSetting("modelSelection", enabled)
                }
              />
            </ItemActions>
          </Item>
        </PageRows>
      )}
    </ControlsSection>
  );
}

/** What the allowed-models row says: the models themselves, the first few by name. */
export function allowedSummary(models: readonly string[]): string {
  if (models.length === 0) return "None listed";
  if (models.length <= 3) return models.join(", ");
  return `${models.slice(0, 3).join(", ")} and ${models.length - 3} more`;
}

/** Admin, Providers: the allowlist every Bot's model is checked against. */
export function ModelAllowlistSection() {
  const [open, setOpen] = useState(false);
  return (
    <ControlsSection
      description="With the allowlist on, a built-in Bot on a model that isn't listed is refused before it runs, and people can only pick listed models. A remote Bot chooses its own model, and the one it reports is checked."
      title="Allowlist"
    >
      {({ data, setSetting, saving }) => {
        const { modelAllowlist } = data.settings;
        return (
          <>
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShieldLock />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Only allowed models</ItemTitle>
                  <ItemDescription>
                    {modelAllowlist.enabled
                      ? "Bots can only run on the models listed below."
                      : "Off. Any model can be used."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Only allowed models"
                    checked={modelAllowlist.enabled}
                    disabled={saving}
                    onCheckedChange={(enabled) =>
                      setSetting("modelAllowlist", {
                        ...modelAllowlist,
                        enabled,
                      })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item
                render={<button onClick={() => setOpen(true)} type="button" />}
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconKey />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Allowed models</ItemTitle>
                  <ItemDescription>
                    {allowedSummary(modelAllowlist.models)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </PageRows>
            {/* A fresh draft on each open, from the latest saved allowlist. */}
            {open ? (
              <AllowedModelsDialog
                builtInModel={data.builtInModel}
                initial={modelAllowlist.models}
                onClose={() => setOpen(false)}
                onSave={(models) =>
                  setSetting("modelAllowlist", { ...modelAllowlist, models })
                }
                open
              />
            ) : null}
          </>
        );
      }}
    </ControlsSection>
  );
}

/** `provider/model`, the spelling the allowlist and the usage view share. */
const FULL_NAME = /^[^\s/]+\/\S+$/;

/**
 * Pick the allowed models from what the provider or gateway lists, newest first, with the
 * deployment's own model marked. A model the listing does not have (a remote Bot's own, say) is
 * added by its full name and listed with the rest.
 */
export function AllowedModelsDialog({
  open,
  initial,
  builtInModel,
  onSave,
  onClose,
}: {
  open: boolean;
  /** As stored: `provider/model`. */
  initial: readonly string[];
  /** The deployment's model, as `provider/model`. */
  builtInModel: string | null;
  onSave: (models: string[]) => void;
  onClose: () => void;
}) {
  const available = useQuery({
    ...availableModelsQueryOptions(),
    enabled: open,
  });
  const [selected, setSelected] = useState<string[]>([...initial]);
  const [search, setSearch] = useState("");
  const [other, setOther] = useState("");

  const listed = (available.data?.models ?? []).map((model) => ({
    name: `${available.data?.provider}/${model.id}`,
    label: model.label,
  }));
  const listedNames = new Set(listed.map((model) => model.name));
  // Saved models the listing no longer (or never) had, so they can still be seen and removed.
  const extra = selected
    .filter((name) => !listedNames.has(name))
    .map((name) => ({ name, label: name }));
  const needle = search.trim().toLowerCase();
  const rows = [...extra, ...listed].filter(
    (model) =>
      !needle ||
      model.label.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle),
  );
  const toggle = (name: string, on: boolean) =>
    setSelected((current) =>
      on
        ? [...current.filter((entry) => entry !== name), name]
        : current.filter((entry) => entry !== name),
    );
  const otherName = other.trim();
  const otherValid = FULL_NAME.test(otherName);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allowed models</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 flex flex-col gap-3 overflow-y-auto">
          <Input
            aria-label="Search models"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models"
            value={search}
          />
          {available.isPending ? null : available.error ? (
            <p className="text-destructive text-sm" role="alert">
              {available.error.message}
            </p>
          ) : !available.data.listed ? (
            <p className="text-muted-foreground text-sm">
              Couldn't read the provider's models, so only the configured one is
              listed. Add others by their full name.
            </p>
          ) : null}
          {rows.length === 0 ? (
            <PageEmpty icon={IconSearch} title="No matches" />
          ) : (
            <div className="flex flex-col gap-px">
              {rows.map((model) => (
                <Item key={model.name} size="sm" variant="muted">
                  <ItemContent>
                    <ItemTitle>{model.label}</ItemTitle>
                    <ItemDescription className="font-mono text-xs">
                      {model.name}
                      {model.name === builtInModel ? " · default" : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Checkbox
                      aria-label={`Allow ${model.label}`}
                      checked={selected.includes(model.name)}
                      onCheckedChange={(checked) =>
                        toggle(model.name, checked === true)
                      }
                    />
                  </ItemActions>
                </Item>
              ))}
            </div>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!otherValid) return;
              toggle(otherName, true);
              setOther("");
            }}
          >
            <Input
              aria-label="Another model"
              className="font-mono text-xs"
              onChange={(event) => setOther(event.target.value)}
              placeholder="provider/model, for a model not listed"
              value={other}
            />
            <Button
              disabled={!otherValid}
              size="sm"
              type="submit"
              variant="outline"
            >
              Add
            </Button>
          </form>
          {builtInModel && !selected.includes(builtInModel) ? (
            <p className="text-muted-foreground text-xs">
              {builtInModel} isn't allowed. While the allowlist is on, a
              built-in Bot is refused when nobody picked another model.
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(selected);
              onClose();
            }}
            size="sm"
            type="button"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Admin, Providers: which models Bots ran on in the last 30 days. */
export function ModelUsageSection() {
  const usage = useQuery(modelUsageQueryOptions(30));
  return (
    <ControlsSection
      description="Runs on each model in the last 30 days, including runs the allowlist refused."
      title="Usage"
    >
      {() =>
        usage.isPending ? null : usage.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't load model usage. Reload the page.
          </p>
        ) : usage.data.summary.length === 0 ? (
          <PageEmpty icon={IconChartBar} title="No recent runs">
            Runs will appear here once a Bot answers.
          </PageEmpty>
        ) : (
          <PageRows>
            {usage.data.summary.map((row, index) => (
              <div key={`${row.model}-${row.source}`}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconChartBar />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{row.model}</ItemTitle>
                    <ItemDescription>
                      {row.runs} runs by {row.people}{" "}
                      {row.people === 1 ? "person" : "people"}
                      {row.refused > 0
                        ? ` · ${row.refused} off the allowlist`
                        : ""}{" "}
                      · {row.source}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-sm">
                      {new Date(row.lastUsedAt).toLocaleDateString()}
                    </span>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )
      }
    </ControlsSection>
  );
}
