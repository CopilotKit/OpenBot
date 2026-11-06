import {
  IconBrain,
  IconChartBar,
  IconChevronRight,
  IconCloud,
  IconCube,
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
import { markFor } from "@/lib/marks";
import { effortLabel } from "@/lib/models/effort";
import {
  availableModelsQueryOptions,
  type ModelOption,
  type ModelSource,
} from "@/lib/models/queries";
import { ControlsSection } from "./controls-section";

/** Who serves the models, by the name an admin knows it by. */
const SOURCE_NAMES: Record<ModelSource, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  gateway: "OpenAI-compatible endpoint",
  chatgpt: "ChatGPT plan",
  claude: "Claude plan",
};

/**
 * The mark that stands beside a source, from `shared/marks`. A Claude plan is Claude's own; a
 * ChatGPT plan is OpenAI's, whose mark ChatGPT itself uses. An endpoint is nobody's, so that row
 * gets a plain icon. Nothing is drawn to stand in for a missing mark.
 */
const SOURCE_VENDORS: Partial<Record<ModelSource, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  xai: "xai",
  chatgpt: "openai",
  claude: "claude",
};

/**
 * Admin, Providers: what serves the models built-in Bots run on. One today, read from the
 * deployment's configuration; a row each once a deployment can hold more than one.
 */
export function ProviderSection() {
  const available = useQuery(availableModelsQueryOptions());
  return (
    <ControlsSection
      description="Built-in Bots and the framework picked at setup run on models from this provider."
      title="Connected"
    >
      {() => {
        if (available.isPending) return null;
        if (available.error)
          return (
            <p className="mt-4 text-destructive text-sm" role="alert">
              Couldn't load the provider. Reload the page.
            </p>
          );
        const { source } = available.data;
        const name = SOURCE_NAMES[source] ?? source;
        const vendor = SOURCE_VENDORS[source];
        return (
          <PageRows>
            <Item size="sm">
              {vendor && markFor(vendor) ? (
                <ItemMedia>
                  <HarnessMark id={vendor} name={name} />
                </ItemMedia>
              ) : (
                <ItemMedia variant="icon">
                  <IconCloud />
                </ItemMedia>
              )}
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
                <ItemDescription>
                  {available.data.listed
                    ? `Default ${available.data.default} · ${available.data.models.length} models listed`
                    : `Default ${available.data.default} · couldn't read its models`}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        );
      }}
    </ControlsSection>
  );
}

/**
 * Admin, Providers: what people pick from in a conversation. Everything the credential lists for
 * one person on their own machine; in a team, the models allowed below, and until there are any,
 * the default only. No switch: what is allowed says it.
 */
export function ModelChoiceSection() {
  const available = useQuery(availableModelsQueryOptions());
  return (
    <ControlsSection
      description={() => {
        const data = available.data;
        if (!data) return "Which models people can pick in each conversation.";
        return data.exposure === "all"
          ? `People can pick any model your provider lists, and its thinking level, in each conversation. Bots run on ${data.default} until somebody picks another.`
          : `People pick among the models you allow below, and their thinking level, in each conversation. Until you allow one, every conversation runs on ${data.default}.`;
      }}
      title="In conversations"
    >
      {({ data }) => {
        const listing = available.data;
        if (!listing) return null;
        const allowed = data.settings.modelAllowlist.models.filter((name) =>
          listing.models.some(
            (model) => `${listing.provider}/${model.id}` === name,
          ),
        ).length;
        return (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBrain />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {listing.exposure === "all"
                    ? "Every listed model"
                    : allowed === 0
                      ? "No models allowed yet"
                      : `${allowed} ${allowed === 1 ? "model" : "models"} allowed`}
                </ItemTitle>
                <ItemDescription>
                  {listing.exposure === "all"
                    ? `${listing.models.length} models, kept current from your provider.`
                    : allowed === 0
                      ? "People don't see a model picker. Allow models below to offer them."
                      : "People see them in the composer's model picker, with the default."}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        );
      }}
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
      description="The models people may pick in each conversation. With Only allowed models on, a Bot on any other model is refused before it runs, and a remote Bot's own model is checked too."
      title="Allowed models"
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
                      : "Off. Runs on other models, a remote Bot's own included, aren't refused."}
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

  const listed: { name: string; label: string; model?: ModelOption }[] = (
    available.data?.models ?? []
  ).map((model) => ({
    name: `${available.data?.provider}/${model.id}`,
    label: model.label,
    model,
  }));
  const listedNames = new Set(listed.map((model) => model.name));
  // The default as the list says it today: the operator's model, or the middle of the line.
  const defaultName = available.data
    ? `${available.data.provider}/${available.data.default}`
    : builtInModel;
  // Saved models the listing no longer (or never) had, so they can still be seen and removed.
  const extra: { name: string; label: string; model?: ModelOption }[] = selected
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
                  {/* The same mark the composer's picker draws, or its plain model icon. */}
                  <ItemMedia>
                    {model.model?.vendor && markFor(model.model.vendor) ? (
                      <HarnessMark
                        className="size-4"
                        id={model.model.vendor}
                        name={model.label}
                      />
                    ) : (
                      <IconCube
                        aria-hidden
                        className="size-4 text-muted-foreground"
                      />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{model.label}</ItemTitle>
                    <ItemDescription className="text-xs">
                      <span className="font-mono">{model.name}</span>
                      {model.name === defaultName ? " · default" : ""}
                      {model.model?.efforts?.length
                        ? ` · Thinking: ${model.model.efforts.map(effortLabel).join(", ")}`
                        : ""}
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
          {defaultName && !selected.includes(defaultName) ? (
            <p className="text-muted-foreground text-xs">
              {defaultName} is the default and stays offered. With Only allowed
              models on, a built-in Bot on it is refused unless you allow it.
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

/**
 * Admin, Providers: which models Bots ran on in the last 30 days. Only a team has an allowlist, so
 * only a team is told that refused runs are counted.
 */
export function ModelUsageSection({ team }: { team: boolean }) {
  const usage = useQuery(modelUsageQueryOptions(30));
  return (
    <ControlsSection
      description={
        team
          ? "Runs on each model in the last 30 days, including runs the allowlist refused."
          : "Runs on each model in the last 30 days."
      }
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
