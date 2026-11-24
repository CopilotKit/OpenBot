import {
  IconBrain,
  IconBuilding,
  IconChartBar,
  IconChevronRight,
  IconCloud,
  IconCube,
  IconKey,
  IconSearch,
  IconShieldLock,
  IconSparkles,
  IconUsers,
} from "@tabler/icons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { AiConnectionRow } from "@/components/settings/ai-connection";
import { ProviderTile } from "@/components/settings/ai-connection-chooser";
import { teamPaths } from "@/components/teams/team-paths";
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
import { describeConnection } from "@/lib/ai-connection/describe";
import { providerById } from "@/lib/ai-connection/providers";
import {
  type AiConnection,
  aiConnectionQueryOptions,
  desktopAiSupportQueryOptions,
  type PersonalAiConnection,
  personalAiConnectionQueryOptions,
} from "@/lib/ai-connection/queries";
import {
  enterpriseOverviewQueryOptions,
  modelUsageQueryOptions,
} from "@/lib/enterprise/queries";
import { loadFailure } from "@/lib/load-failure";
import { markFor } from "@/lib/marks";
import { effortLabel } from "@/lib/models/effort";
import { modelLabel, modelNamer } from "@/lib/models/names";
import {
  type AvailableModels,
  availableModelsQueryOptions,
  type ModelOption,
  type ModelSource,
} from "@/lib/models/queries";
import {
  teamListQueryOptions,
  teamModelsQueryOptions,
} from "@/lib/teams/queries";
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
 * Admin, Providers: the organization's AI (getAiConnection), with Change and Disconnect in the same
 * dialog and chooser Settings and Connect your AI use. And on OpenBot Cloud, where each person can
 * bring their own AI, the viewer's own beside it, with the way to change it in Settings.
 *
 * The row reads the organization's connection, never the model catalogue: on OpenBot Cloud the
 * catalogue is read with the viewer's own AI ahead of the organization's (it is what *they* pick
 * from), so an admin who connected a Claude plan of their own was shown that plan as the
 * organization's provider.
 */
export function ProviderSection() {
  const connection = useQuery(aiConnectionQueryOptions());
  const support = useQuery(desktopAiSupportQueryOptions());
  const personal = useQuery(personalAiConnectionQueryOptions());
  if (connection.isPending || support.isPending || personal.isPending)
    return null;
  // Each person brings their own AI here (OpenBot Cloud): the server's verdict, never guessed.
  const cloud = personal.data?.available === true;
  return (
    <>
      <PageSection
        description={
          cloud
            ? "Bots use it for everyone in your organization who hasn't connected their own AI."
            : "Built-in Bots and the framework picked at setup run on this provider."
        }
        title={cloud ? "Organization's AI" : "AI provider"}
      >
        {connection.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {loadFailure(
              connection.error,
              "Couldn't load the AI connection. Try again in a moment.",
            )}
          </p>
        ) : connection.data === null ? (
          // An OpenBot older than the AI connection: what the model listing says serves it.
          <CatalogueProviderRow />
        ) : (
          <PageRows>
            {connection.data.editable && support.data !== "older" ? (
              <AiConnectionRow
                connection={connection.data}
                inDesktop={support.data === "in-place"}
                organizationWide={cloud}
              />
            ) : (
              <FixedConnectionRow
                connection={connection.data}
                organizationWide={cloud}
              />
            )}
          </PageRows>
        )}
      </PageSection>
      {cloud && personal.data ? (
        <ViewerAiSection personal={personal.data} />
      ) : null}
    </>
  );
}

/**
 * The organization's AI where it can't be changed here: whoever runs OpenBot sets it (`editable`
 * false), or an OpenBot Desktop older than changing it in place, where Settings has its own Change.
 */
function FixedConnectionRow({
  connection,
  organizationWide,
}: {
  connection: AiConnection;
  organizationWide: boolean;
}) {
  // Set where OpenBot runs, it is nobody's here: the organization's.
  const described = describeConnection(
    connection,
    organizationWide || !connection.editable ? "organization" : "you",
  );
  return (
    <Item size="sm">
      <ProviderTile provider={providerById(connection.provider)} />
      <ItemContent>
        <ItemTitle>{described?.provider ?? "Not chosen yet"}</ItemTitle>
        <ItemDescription>
          {connection.editable
            ? `${described?.summary ?? "No AI provider yet."} Change it in Settings.`
            : `${described?.summary ?? "No AI provider yet."} Set by whoever runs OpenBot.`}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/**
 * The viewer's own AI on OpenBot Cloud, which only they can change, in Settings → Your AI. Their
 * runs use it ahead of the organization's; with none of their own, the organization's.
 */
function ViewerAiSection({ personal }: { personal: PersonalAiConnection }) {
  const described =
    personal.uses === "personal"
      ? describeConnection(personal.connection)
      : null;
  return (
    <PageSection
      description="Each person can connect their own AI. Bots use it when they work for them, ahead of the organization's."
      title="Your AI"
    >
      <PageRows>
        <Item render={<Link hash="your-ai" to="/settings" />} size="sm">
          {described ? (
            <ProviderTile
              provider={providerById(personal.connection.provider)}
            />
          ) : (
            <ItemMedia variant="icon">
              {personal.uses === "organization" ? (
                <IconBuilding />
              ) : (
                <IconSparkles />
              )}
            </ItemMedia>
          )}
          <ItemContent>
            <ItemTitle>
              {described
                ? described.provider
                : personal.uses === "organization"
                  ? "Your organization's AI"
                  : "Not connected"}
            </ItemTitle>
            <ItemDescription>
              {described
                ? `${described.summary} Only you use it. Change it in Settings.`
                : personal.uses === "organization"
                  ? "Bots use the organization's for you. Connect your own in Settings."
                  : "Bots can't work for you yet. Connect your AI in Settings."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}

/** From an OpenBot older than the AI connection: what serves the models, by the model listing. */
function CatalogueProviderRow() {
  const available = useQuery(availableModelsQueryOptions());
  if (available.isPending) return null;
  if (available.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {loadFailure(
          available.error,
          "Couldn't load the provider. Try again in a moment.",
        )}
      </p>
    );
  return <ProviderRow listing={available.data} />;
}

function ProviderRow({ listing }: { listing: AvailableModels }) {
  const { source } = listing;
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
            {listing.listed
              ? `Default ${modelLabel(listing, listing.default)} · ${listing.models.length} models listed`
              : `Default ${modelLabel(listing, listing.default)} · couldn't read its models`}
          </ItemDescription>
        </ItemContent>
      </Item>
    </PageRows>
  );
}

/**
 * Whether the model allowlist narrows what people pick and what Bots run on: only with Only allowed
 * models on AND at least one model allowed. Off, or on with nothing allowed yet, every listed model
 * stays open. The server keeps the same rule for the composer's picker and for every run.
 */
export function allowlistNarrows(allowlist: {
  enabled: boolean;
  models: readonly string[];
}): boolean {
  return allowlist.enabled && allowlist.models.length > 0;
}

/**
 * On OpenBot Cloud, whether the organization has no AI of its own yet. Each person's runs then use
 * their own AI, so there is no organization list of models: the catalogue an admin reads here
 * holds only the deployment's own model, which nobody in the organization is offered. Read from
 * the organization's connection (getAiConnection), or the summary a person's own carries
 * (getPersonalAiConnection) where that can't be read. Undefined until both have answered.
 */
export function useNoOrganizationAi(): boolean | undefined {
  const connection = useQuery(aiConnectionQueryOptions());
  const personal = useQuery(personalAiConnectionQueryOptions());
  if (connection.isPending || personal.isPending) return undefined;
  // Each person brings their own AI only on OpenBot Cloud: the server's verdict, never guessed.
  if (personal.data?.available !== true) return false;
  const provider =
    connection.data?.provider ?? personal.data.organization.provider;
  return provider === null;
}

/**
 * Admin, Providers: what people pick from in a conversation. Every model the credential lists,
 * until a team's admin narrows it below; then the models allowed there, with the default. On
 * OpenBot Cloud with no organization AI, every model each person's own AI lists.
 */
export function ModelChoiceSection() {
  const available = useQuery(availableModelsQueryOptions());
  const noOrganizationAi = useNoOrganizationAi();
  const data = available.data;
  /*
   * The allowlist is read only where models are picked from it. Everything else here is the model
   * listing, so the section shows in the personal edition's Admin too, where the server has no
   * admin settings to read.
   */
  const overview = useQuery({
    ...enterpriseOverviewQueryOptions(),
    enabled: data?.exposure === "allowed",
  });
  if (!data || noOrganizationAi === undefined) return null;
  const allowlist = overview.data?.settings.modelAllowlist;
  const allowed =
    allowlist?.models.filter((name) =>
      data.models.some((model) => `${data.provider}/${model.id}` === name),
    ).length ?? 0;
  if (data.exposure === "allowed" && overview.isPending) return null;
  if (noOrganizationAi)
    return (
      <OwnModelsChoice
        allowed={
          allowlist && allowlistNarrows(allowlist) ? allowlist.models : null
        }
        failed={overview.error}
      />
    );
  // Open unless an admin narrowed it: one person, or a team whose allowlist narrows nothing.
  const open =
    data.exposure === "all" || !allowlist || !allowlistNarrows(allowlist);
  /*
   * What a run uses when nobody picked, as the server decides it: the deployment's default, unless
   * the allowlist leaves it out. Then the newest model allowed (the listing is newest first), since
   * the server never offers a model it would refuse. With nothing allowed listed, the default.
   */
  const isAllowed = (id: string) =>
    allowlist?.models.includes(`${data.provider}/${id}`) === true;
  const runsOn =
    open || isAllowed(data.default)
      ? data.default
      : (data.models.find((model) => isAllowed(model.id))?.id ?? data.default);
  const fallback = modelLabel(data, runsOn);
  return (
    <PageSection
      description={
        open
          ? `People can pick any model your provider lists, and its thinking level, in each conversation. Bots run on ${fallback} until somebody picks another.`
          : `People pick among the models you allow below, and their thinking level, in each conversation. Bots run on ${fallback} until somebody picks another.`
      }
      title="In conversations"
    >
      {overview.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {loadFailure(
            overview.error,
            "Couldn't load these settings. Try again in a moment.",
          )}
        </p>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconBrain />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {open
                  ? "Every listed model"
                  : allowed === 0
                    ? "No allowed model is listed"
                    : `${allowed} ${allowed === 1 ? "model" : "models"} allowed`}
              </ItemTitle>
              <ItemDescription>
                {open
                  ? `${data.models.length} ${data.models.length === 1 ? "model" : "models"}, kept current from your provider.`
                  : allowed === 0
                    ? `Your provider doesn't list any model you allowed, so people only get ${fallback}.`
                    : "People see them in the composer's model picker, with the default."}
              </ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
      )}
    </PageSection>
  );
}

/**
 * "In conversations" on OpenBot Cloud with no organization AI: each person picks from what their
 * own AI lists, every model open until an admin narrows it. Nothing here comes from the model
 * catalogue, which then holds only the deployment's own model.
 */
function OwnModelsChoice({
  allowed,
  failed,
}: {
  /** The models an admin allowed, when the allowlist narrows anything. Null while it is open. */
  allowed: readonly string[] | null;
  /** Why the settings couldn't be read, or null when they were. */
  failed: unknown;
}) {
  return (
    <PageSection
      description={
        allowed
          ? "People pick among the models you allow below, from those their own AI lists, in each conversation."
          : "Each person picks from the models their own AI lists, and their thinking level, in each conversation. Your organization has no AI of its own yet."
      }
      title="In conversations"
    >
      {failed ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {loadFailure(
            failed,
            "Couldn't load these settings. Try again in a moment.",
          )}
        </p>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconUsers />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {allowed
                  ? `${allowed.length} ${allowed.length === 1 ? "model" : "models"} allowed`
                  : "Each person's own AI"}
              </ItemTitle>
              <ItemDescription>
                {allowed
                  ? "Each person sees the ones their own AI lists."
                  : "Every model a person's own AI lists is open to them. There's no organization list yet."}
              </ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
      )}
    </PageSection>
  );
}

/**
 * What the allowed-models row says: the models themselves, the first few by name. `nameOf` names
 * each as the provider's listing does; one the listing doesn't have keeps its id.
 */
export function allowedSummary(
  models: readonly string[],
  nameOf: (name: string) => string = (name) => name,
): string {
  if (models.length === 0) return "None listed";
  const named = models.map(nameOf);
  if (named.length <= 3) return named.join(", ");
  return `${named.slice(0, 3).join(", ")} and ${named.length - 3} more`;
}

/** Admin, Providers: the allowlist every Bot's model is checked against. */
export function ModelAllowlistSection() {
  const [open, setOpen] = useState(false);
  // The models by name, from the listing the allowlist is chosen from.
  const listing = useQuery(availableModelsQueryOptions());
  const nameOf = modelNamer(listing.data);
  // With no organization AI, each person's own AI lists their models: there is no list here.
  const noOrganizationAi = useNoOrganizationAi();
  if (noOrganizationAi === undefined) return null;
  return (
    <ControlsSection
      description={
        noOrganizationAi
          ? "Every model each person's own AI lists is open until you narrow it. Turn on Only allowed models and allow some, and people pick among those. A Bot on any other model is then refused before it runs, and a remote Bot's own model is checked too."
          : "Every listed model is open until you narrow it. Turn on Only allowed models and allow some, and people pick among those. A Bot on any other model is then refused before it runs, and a remote Bot's own model is checked too."
      }
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
                    {allowlistNarrows(modelAllowlist)
                      ? "People pick among the models listed below, and Bots only run on them."
                      : modelAllowlist.enabled
                        ? "On, but no model is allowed yet, so every model stays open. Allow models below to narrow it."
                        : noOrganizationAi
                          ? "Off. People can pick any model their own AI lists, and no run is refused for its model."
                          : "Off. People can pick any listed model, and no run is refused for its model."}
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
                    {allowedSummary(modelAllowlist.models, nameOf)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
              <TeamsWithOwnModelsRow />
            </PageRows>
            {/* A fresh draft on each open, from the latest saved allowlist. */}
            {open ? (
              <AllowedModelsDialog
                builtInModel={data.builtInModel}
                initial={modelAllowlist.models}
                listsModels={!noOrganizationAi}
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

/**
 * The teams with a list of their own, each linking to its page in Admin, where its list is set.
 * Nothing at all while no team has one, or while the teams are being read.
 */
function TeamsWithOwnModelsRow() {
  const list = useQuery(teamListQueryOptions());
  const teams = list.data?.teams ?? [];
  const lists = useQueries({
    queries: teams.map((team) => teamModelsQueryOptions(team.id)),
  });
  const limited = teams.filter(
    (_team, index) => (lists[index]?.data?.models ?? null) !== null,
  );
  if (limited.length === 0) return null;
  return (
    <>
      <Separator />
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconUsers />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Teams with their own list</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {limited.map((team, index) => (
              <Fragment key={team.id}>
                {index > 0 ? ", " : null}
                <Link {...teamPaths("admin").team(team.id)}>{team.name}</Link>
              </Fragment>
            ))}
            . People in them run only their team's models, within this list.
          </ItemDescription>
        </ItemContent>
      </Item>
    </>
  );
}

/** What a row in the Allowed models dialog says under a model's name: default, and its thinking. */
function modelFacts(isDefault: boolean, model?: ModelOption): string {
  return [
    isDefault ? "Default" : null,
    model?.efforts?.length
      ? `Thinking: ${model.efforts.map(effortLabel).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `provider/model`, the spelling the allowlist and the usage view share. */
const FULL_NAME = /^[^\s/]+\/\S+$/;

/**
 * Pick the allowed models from what the provider or gateway lists, newest first, with the
 * deployment's own model marked. A model the listing does not have (a remote Bot's own, say) is
 * added by its full name and listed with the rest.
 *
 * With no organization AI (`listsModels` false) there is nothing to list: the catalogue holds only
 * the deployment's own model, which nobody is offered. Every model is then added by its full name.
 */
export function AllowedModelsDialog({
  open,
  initial,
  builtInModel,
  listsModels = true,
  onSave,
  onClose,
}: {
  open: boolean;
  /** As stored: `provider/model`. */
  initial: readonly string[];
  /** The deployment's model, as `provider/model`. */
  builtInModel: string | null;
  /** Whether the organization's AI lists models to pick from. */
  listsModels?: boolean;
  onSave: (models: string[]) => void;
  onClose: () => void;
}) {
  const available = useQuery({
    ...availableModelsQueryOptions(),
    enabled: open && listsModels,
  });
  const [selected, setSelected] = useState<string[]>([...initial]);
  const [search, setSearch] = useState("");
  const [other, setOther] = useState("");

  // The catalogue is cached from the page, so it is set aside here, not only left unread.
  const listed: { name: string; label: string; model?: ModelOption }[] = (
    (listsModels && available.data?.models) ||
    []
  ).map((model) => ({
    name: `${available.data?.provider}/${model.id}`,
    label: model.label,
    model,
  }));
  const listedNames = new Set(listed.map((model) => model.name));
  // The default as the list says it today: the operator's model, or the middle of the line.
  // With no organization AI there is none: each person's own AI has its own.
  const defaultName = !listsModels
    ? null
    : available.data
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
        {/*
         * The search above the list and the box for another model under it stay put: only the list
         * scrolls. With both inside the scroll, a long list on a phone took the box for another
         * model out of sight, and nothing said it was there.
         */}
        {/* Nothing listed and nothing added yet: nothing to search. */}
        {listsModels || selected.length > 0 ? (
          <Input
            aria-label="Search models"
            className="mt-4 shrink-0"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models"
            value={search}
          />
        ) : null}
        <DialogBody className="mt-3 flex flex-col gap-3 overflow-y-auto">
          {!listsModels ? (
            <p className="text-muted-foreground text-sm">
              Your organization has no AI yet, so no models are listed. Add each
              model by its full name.
            </p>
          ) : available.isPending ? null : available.error ? (
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
            // With nothing listed and nothing searched for, the note above says why.
            listsModels || needle ? (
              <PageEmpty icon={IconSearch} title="No matches" />
            ) : null
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
                    {/*
                     * By its name only: the id a run sends is nobody's to read here. A model the
                     * listing doesn't have is titled by its full name, which is all it has.
                     */}
                    {modelFacts(model.name === defaultName, model.model) ? (
                      <ItemDescription className="text-xs">
                        {modelFacts(model.name === defaultName, model.model)}
                      </ItemDescription>
                    ) : null}
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
        </DialogBody>
        <div className="mt-3 flex shrink-0 flex-col gap-3">
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
          {/*
           * Left out while others are allowed, the default is no longer offered: the server makes the
           * newest allowed model the default instead, and refuses a Bot set to the old one.
           */}
          {defaultName &&
          selected.length > 0 &&
          !selected.includes(defaultName) ? (
            <p className="text-muted-foreground text-xs">
              {modelNamer(available.data)(defaultName)} is the default. While
              Only allowed models is on without it, the newest model you allow
              is the default instead. A Bot set to{" "}
              {modelNamer(available.data)(defaultName)} is refused.
            </p>
          ) : null}
        </div>
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

/** The Bot a usage row names when the model is one nobody reported (`remote:<bot id>`). */
const UNREPORTED = /^remote:(.+)$/;

/**
 * A usage row's model by its name, or what stands in for one its Bot never named. `nameOf` names it
 * as the provider's listing does; a model the listing doesn't have (a remote Bot's own) keeps its id.
 */
export function usageModelName(
  model: string,
  nameOf: (name: string) => string = (name) => name,
): string {
  return UNREPORTED.test(model) ? "Model not reported" : nameOf(model);
}

/**
 * How the row's model is known, said for an admin. The server's words (`configured`, `observed`,
 * `unknown`) were printed as they came, and "unknown" beside "remote:picked-harness" said nothing
 * about why.
 */
export function usageSourceWords(model: string, source: string): string {
  // The model OpenBot ran it on: a Bot's own setting, a person's pick, or the default.
  if (source === "configured") return "set in OpenBot";
  if (source === "observed") return "reported by the Bot";
  const bot = UNREPORTED.exec(model)?.[1];
  return bot
    ? `${bot} picks its own model and didn't say which`
    : "the Bot didn't say which model it used";
}

/**
 * Admin, Providers: which models Bots ran on in the last 30 days. Only a team has an allowlist, so
 * only a team is told that refused runs are counted.
 */
export function ModelUsageSection({ team }: { team: boolean }) {
  const usage = useQuery(modelUsageQueryOptions(30));
  // Each model by its name, from the listing the page already reads.
  const listing = useQuery(availableModelsQueryOptions());
  const nameOf = modelNamer(listing.data);
  // Its own read, not one of the admin's controls, so it shows in the personal edition's Admin too.
  return (
    <PageSection
      description={
        team
          ? "Runs on each model in the last 30 days, refused runs included."
          : "Runs on each model in the last 30 days."
      }
      title="Usage"
    >
      {usage.isPending ? null : usage.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {loadFailure(
            usage.error,
            "Couldn't load model usage. Try again in a moment.",
          )}
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
                  <ItemTitle>{usageModelName(row.model, nameOf)}</ItemTitle>
                  <ItemDescription>
                    {row.runs} {row.runs === 1 ? "run" : "runs"} by {row.people}{" "}
                    {row.people === 1 ? "person" : "people"}
                    {row.refused > 0 ? ` · ${row.refused} refused` : ""} ·{" "}
                    {usageSourceWords(row.model, row.source)}
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
      )}
    </PageSection>
  );
}
