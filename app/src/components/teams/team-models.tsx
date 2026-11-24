import {
  IconBrain,
  IconChevronRight,
  IconCube,
  IconSearch,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { allowlistNarrows } from "@/components/admin/controls/model-sections";
import { HarnessMark } from "@/components/agents/harness-mark";
import { PageEmpty } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
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
import { enterpriseOverviewQueryOptions } from "@/lib/enterprise/queries";
import { loadFailure } from "@/lib/load-failure";
import { markFor } from "@/lib/marks";
import { effortLabel } from "@/lib/models/effort";
import { modelNamer } from "@/lib/models/names";
import {
  type AvailableModels,
  availableModelsQueryOptions,
  modelCatalogueQueryOptions,
} from "@/lib/models/queries";
import {
  deleteTeamModelsMutationOptions,
  replaceTeamModelsMutationOptions,
} from "@/lib/teams/mutations";
import { type TeamSummary, teamModelsQueryOptions } from "@/lib/teams/queries";
import { queryClient } from "@/query-client";

/** One model the organization allows, as the dialog lists it. */
type OrganizationModel = {
  /** `provider/model`, as a team's list and the organization's allowlist both spell it. */
  name: string;
  label: string;
  /** Who makes it, for its mark. */
  vendor?: string;
  /** How hard it can think, as the listing says. */
  efforts?: string[];
};

/**
 * The models the organization allows today, to choose a team's from. The catalogue's whole listing
 * (`view=all`: every model the provider offers, never narrowed by the allowlist or by the reader's
 * teams), kept to the organization's allowlist when that narrows anything. Each is `provider/model`,
 * the spelling the allowlist and a team's list share. Null when there is nothing to choose from: the
 * listing couldn't be read, or nothing in it is allowed.
 */
export function organizationModels(
  listing: AvailableModels | undefined,
  allowlist: { enabled: boolean; models: readonly string[] },
): OrganizationModel[] | null {
  if (!listing?.listed) return null;
  const listed = listing.models.map((model) => ({
    name: `${listing.provider}/${model.id}`,
    label: model.label,
    vendor: model.vendor,
    ...(model.efforts?.length ? { efforts: model.efforts } : {}),
  }));
  const allowed = allowlistNarrows(allowlist)
    ? listed.filter((model) => allowlist.models.includes(model.name))
    : listed;
  return allowed.length === 0 ? null : allowed;
}

/** What the Models row says: the team's list, by its one model's name or by how many. */
export function teamModelsSummary(
  models: readonly string[] | null,
  labelOf: (name: string) => string,
): string {
  if (models === null) return "Everything the organization allows";
  if (models.length === 1) return labelOf(models[0] as string);
  return `${models.length} models`;
}

/**
 * A team's Models row: which models its people may run. An owner or an admin of the organization
 * (the server's `canMove` verdict, the same rule that lets them move the team) opens a dialog to
 * choose them from what the organization allows. Anybody else reads it.
 */
export function TeamModelsRow({ team }: { team: TeamSummary }) {
  const admin = team.canMove;
  const [open, setOpen] = useState(false);
  const saved = useQuery(teamModelsQueryOptions(team.id));
  // What the organization allows, which only an admin can read: their whole listing and allowlist.
  const listing = useQuery({
    ...availableModelsQueryOptions(),
    enabled: admin,
  });
  const overview = useQuery({
    ...enterpriseOverviewQueryOptions(),
    enabled: admin,
  });
  const models = saved.data?.models ?? null;
  // Anybody else names the team's one model as their own catalogue labels it.
  const catalogue = useQuery({
    ...modelCatalogueQueryOptions(),
    enabled: !admin && models?.length === 1,
  });
  const allowed =
    admin && overview.data
      ? organizationModels(listing.data, overview.data.settings.modelAllowlist)
      : null;
  const offered = new Set(allowed?.map((model) => model.name));
  const notAllowed = allowed
    ? (models ?? []).filter((name) => !offered.has(name)).length
    : 0;
  const nameOf = modelNamer(listing.data, catalogue.data);
  const summary = saved.isPending
    ? null
    : saved.error
      ? saved.error.message
      : `${teamModelsSummary(models, nameOf)}${
          notAllowed > 0
            ? `. ${notAllowed === 1 ? "One is" : `${notAllowed} are`} no longer allowed.`
            : ""
        }`;

  return (
    <>
      <Item
        render={
          admin ? (
            <button onClick={() => setOpen(true)} type="button" />
          ) : undefined
        }
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconBrain />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Models</ItemTitle>
          <ItemDescription
            className={saved.error ? "text-destructive" : undefined}
          >
            {summary}
          </ItemDescription>
        </ItemContent>
        {admin ? (
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        ) : null}
      </Item>
      {/* A fresh draft on each open, from the list as saved. */}
      {open && saved.data ? (
        <TeamModelsDialog
          allowed={allowed}
          failed={[listing.error, overview.error].filter(
            (error) => error !== null,
          )}
          loading={listing.isPending || overview.isPending}
          nameOf={nameOf}
          onClose={() => setOpen(false)}
          saved={models}
          team={team}
        />
      ) : null}
    </>
  );
}

function TeamModelsDialog({
  team,
  saved,
  allowed,
  failed,
  loading,
  nameOf,
  onClose,
}: {
  team: TeamSummary;
  /** The team's list as saved, or null when it sets none. */
  saved: readonly string[] | null;
  /** What the organization allows, or null when there is nothing to choose from. */
  allowed: OrganizationModel[] | null;
  /** Why what the organization allows couldn't be read, empty when it could. */
  failed: readonly unknown[];
  loading: boolean;
  /** A model's name, for one on the team's list the organization no longer allows. */
  nameOf: (name: string) => string;
  onClose: () => void;
}) {
  const replace = useMutation(replaceTeamModelsMutationOptions(queryClient));
  const clear = useMutation(deleteTeamModelsMutationOptions(queryClient));
  const [selected, setSelected] = useState<string[]>([...(saved ?? [])]);
  const [search, setSearch] = useState("");
  const offered = new Set(allowed?.map((model) => model.name));
  // On the team's list, and no longer allowed by the organization: shown, greyed, and left off on save.
  const withdrawn = (saved ?? []).filter((name) => !offered.has(name));
  const chosen = selected.filter((name) => offered.has(name));
  const needle = search.trim().toLowerCase();
  const rows = [
    ...(allowed ?? []).map((model) => ({ ...model, withdrawn: false })),
    ...withdrawn.map((name) => ({
      name,
      label: nameOf(name),
      vendor: undefined,
      efforts: undefined,
      withdrawn: true,
    })),
  ].filter(
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
  const busy = replace.isPending || clear.isPending;
  const failure = replace.error ?? clear.error;

  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Models for {team.name}</DialogTitle>
          <DialogDescription>
            People in {team.name} can run only the models you tick. Someone in
            several teams can run any model one of their teams allows.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 flex flex-col gap-3 overflow-y-auto">
          {loading ? null : failed.length > 0 ? (
            <p className="text-destructive text-sm" role="alert">
              {loadFailure(
                failed,
                "Couldn't load the organization's models. Try again in a moment.",
              )}
            </p>
          ) : allowed === null ? (
            <p className="text-muted-foreground text-sm">
              Your organization doesn't list any models yet. Allow some on
              Providers first.
            </p>
          ) : (
            <>
              <Input
                aria-label="Search models"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search models"
                value={search}
              />
              {rows.length === 0 ? (
                <PageEmpty icon={IconSearch} title="No matches" />
              ) : (
                <div className="flex flex-col gap-px">
                  {rows.map((model) => (
                    // Filled, not card-coloured: a card is the dialog's own colour and would not show.
                    <Item key={model.name} size="sm" variant="muted">
                      <ItemMedia
                        className={model.withdrawn ? "opacity-60" : undefined}
                      >
                        {model.vendor && markFor(model.vendor) ? (
                          <HarnessMark
                            className="size-4"
                            id={model.vendor}
                            name={model.label}
                          />
                        ) : (
                          <IconCube
                            aria-hidden
                            className="size-4 text-muted-foreground"
                          />
                        )}
                      </ItemMedia>
                      <ItemContent
                        className={model.withdrawn ? "opacity-60" : undefined}
                      >
                        <ItemTitle>{model.label}</ItemTitle>
                        {/* By its name, as the Allowed models dialog lists it: the id is nobody's to read. */}
                        {model.withdrawn ? (
                          <ItemDescription className="text-xs">
                            The organization no longer allows it, so nobody runs
                            it. Saving takes it off.
                          </ItemDescription>
                        ) : model.efforts?.length ? (
                          <ItemDescription className="text-xs">
                            Thinking:{" "}
                            {model.efforts.map(effortLabel).join(", ")}
                          </ItemDescription>
                        ) : null}
                      </ItemContent>
                      <ItemActions>
                        <Checkbox
                          aria-label={`Allow ${model.label}`}
                          checked={
                            model.withdrawn || selected.includes(model.name)
                          }
                          disabled={model.withdrawn || busy}
                          onCheckedChange={(checked) =>
                            toggle(model.name, checked === true)
                          }
                        />
                      </ItemActions>
                    </Item>
                  ))}
                </div>
              )}
              {/*
               * What to do with nothing ticked, by what the footer offers: with a list saved, its
               * button to use everything again; with none, the team already does.
               */}
              {chosen.length === 0 ? (
                <p
                  className="text-muted-foreground text-xs"
                  data-slot="team-models-hint"
                >
                  {saved === null
                    ? "The team uses everything the organization allows. Tick models to limit it to those."
                    : "Tick at least one model, or use everything the organization allows."}
                </p>
              ) : null}
            </>
          )}
          {failure ? (
            <p className="text-destructive text-sm" role="alert">
              {failure.message}
            </p>
          ) : null}
        </DialogBody>
        {/*
         * On a phone the clear button takes a line of its own, above Cancel and Save. Outlined, as
         * the dialog's other secondary action (Cancel) is: a ghost button read as plain text there.
         */}
        <DialogFooter className="mt-4 flex-wrap">
          {saved !== null ? (
            <Button
              className="mr-auto"
              disabled={busy}
              onClick={() => clear.mutate(team.id, { onSuccess: onClose })}
              size="sm"
              type="button"
              variant="outline"
            >
              {clear.isPending
                ? "Saving…"
                : "Use everything the organization allows"}
            </Button>
          ) : null}
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={busy || chosen.length === 0}
            onClick={() =>
              replace.mutate(
                { teamId: team.id, models: chosen },
                { onSuccess: onClose },
              )
            }
            size="sm"
            type="button"
          >
            {replace.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
