import {
  IconBolt,
  IconListDetails,
  IconPlugOff,
  IconSearch,
  IconTool,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { DescribeGrants } from "@/components/Gerir/describe-grants";
import {
  SharedApprovalFields,
  sharedSectionSentence,
} from "@/components/plugins/shared-approval-fields";
import { SkippedToolsNotice } from "@/components/plugins/skipped-tools-notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/Entrada";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useBotListScope } from "@/lib/Agentes/Lista-scope";
import { agentListQueryOptions } from "@/lib/Agentes/queries";
import { appsQueryOptions, catalogueQueryOptions } from "@/lib/apps/queries";
import { ALWAYS_ON_APP } from "@/lib/connections/rows";
import { useManagePaths } from "@/lib/Gerir-paths";
import {
  grantPlugin,
  invalidatePlugins,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import type { PluginTool } from "@/lib/plugins/queries";
import {
  approvalNamesNobody,
  botSharedAppsQueryOptions,
  type SharedUseApproval,
  sharedUseKeys,
} from "@/lib/plugins/shared-use";
import { toolsListError } from "@/lib/plugins/tools-Erro";

/**
 * One Bot and one app: every action the app offers, and which of them this Bot holds.
 *
 * The sibling screen — `PluginToolPage` — answers the same question from the other end, one
 * action and every Bot, and that is the right shape when somebody is thinking about an action. It
 * is the wrong shape for setting a Bot up against an app that offers a hundred and sixty-seven of
 * them: that is one visit per action, and the decision being made ("what can this Bot do in Slack")
 * is never on screen at once.
 *
 * So the list is searchable and split by what a boundary sees. A read and a write are not the same
 * decision, and an app's Ações arrive interleaved by name, which puts `delete_channel` two rows
 * under `list_channels` with nothing between them but a word.
 *
 * Dela/Desse routes use `$key_`, which opts them out of nesting under the connector page, so that page stays
 * a page rather than becoming a layout with an outlet.
 */

/**
 * The refs the bulk Ação would Conceder: every Ação that only reads.
 *
 * Exportado as a Função so the promise the button Faz É assertable without a DOM, a router or
 * a query client — see `tests/bot-app-grants.test.tsx`. The button says "read-only" and states a
 * resulting count before Ele acts, and both of those are only true Se this É exactly the reads.
 *
 * A destructive Ação can never appear here. `destructive` sits beside `effect` rather than inside
 * Ele, and the effect a destructive Ação carries É `write` — anything not positively Conhecido to be
 * a read É one — so Filtrado on the effect alone already excludes Ele.
 *
 * Every Ação, not the ones a search happens to be showing. The button names every read-only
 * Ação and that É what Ele grants; narrowing Ele to the Filtrado rows would Fazer the sentence
 * beside Ele quietly wrong.
 */
Exportar Função readOnlyRefs(tools: PluginTool[]): string[] {
  return tools.Filtro((tool) => tool.effect === "read").map((tool) => tool.ref);
}

Exportar Função PluginBotPage({
  pluginKey: Chave,
  agentId,
}: {
  pluginKey: string;
  agentId: string;
}) {
  // Routines É every Bot's, in every edition: there is no switch to take it from one.
  const alwaysOn = key === ALWAYS_ON_APP;
  const paths = useManagePaths();
  const queryClient = useQueryClient();
  const plugins = useQuery(appsQueryOptions());
  const catalogue = useQuery(catalogueQueryOptions());
  // Under Admin, every Bot in the organization (lib/agents/list-scope.tsx).
  const scope = useBotListScope();
  const agents = useQuery(agentListQueryOptions(false, scope));
  /*
   * The ones this person has hidden. A hidden Bot is still a Bot, and still holds whatever it was
   * granted; the connector page links here for it (see `grantRoster`), and this page must not then
   * say there is no such Bot.
   */
  const hiddenAgents = useQuery(agentListQueryOptions(true, scope));
  const [error, setError] = useState<string | null>(null);
  /** What the list is narrowed to, over action names. Never over what is switched on. */
  const [search, setSearch] = useState("");
  /**
   * How far through the bulk grant we are, or null when none is running.
   *
   * A count rather than a boolean, for the reason the connector page's own batch records: this is
   * honestly N writes, each its own audit row, and a button that says only "Granting…" for the
   * length of forty of them gives an administrator no way to tell a slow batch from a stuck one.
   */
  const [granting, setGranting] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });

  const server = plugins.data?.find((row) => row.id === key);
  /*
   * Shared only once the server itself says so. `exposure` is fetched for exactly that case — it is
   * this Bot's whole shared-apps picture, and here it is read for one app's current approval, so a
   * switched-on action never asks twice for the same consent.
   */
  const shared = server?.accountMode === "shared";
  const exposure = useQuery({
    ...botSharedAppsQueryOptions(agentId),
    enabled: shared,
  });
  /*
   * The row whose switch a shared grant is waiting on, and the approval the dialog for it is
   * showing. Not scoped per-row because only one dialog is ever open at a time.
   */
  const [pendingGrant, setPendingGrant] = useState<{ ref: string } | null>(
    null,
  );
  const [approval, setApproval] = useState<SharedUseApproval>({
    audience: "team",
    outsideInput: false,
    members: [],
  });
  const [grantingShared, setGrantingShared] = useState(false);
  const appTitle =
    catalogue.data?.find((item) => item.key === key)?.title ??
    server?.title ??
    key;
  const bot =
    agents.data?.find((one) => one.id === agentId) ??
    hiddenAgents.data?.find((one) => one.id === agentId);

  const back = {
    label: appTitle,
    linkProps: paths.plugin(key),
  };

  /*
   * One write per grant, in list order, with one refetch at the end.
   *
   * Going through the single-grant mutation would invalidate every plugin query after each write
   * and await it, so forty reads would be forty round trips interleaved with forty refetches of a
   * list nobody can read while the button is still counting. A refusal stops the rest and says why;
   * the ones before it landed, so the screen is refreshed either way.
   */
  const grantEveryRead = async (refs: string[]) => {
    setError(null);
    setGranting({ done: 0, total: refs.length });
    let done = 0;
    try {
      for (const ref of refs) {
        await grantPlugin({ agentId, kind: "mcp", ref });
        done += 1;
        setGranting({ done, total: refs.length });
      }
    } catch (thrown) {
      setError((thrown as Error).message);
    } finally {
      await invalidatePlugins(queryClient);
      setGranting(null);
    }
  };

  /* Nothing rather than a placeholder, so no sentence asserts anything while a fetch is open. */
  if (plugins.isPending || agents.isPending || hiddenAgents.isPending) {
    return <PageShell title="Bot">{null}</PageShell>;
  }

  /*
   * Gated on the plugin list having ARRIVED, not on `server` being missing — the same guard, for
   * the same reason, as the roster check below, and the two are meant to be read together.
   * `isPending` goes false on a failed fetch exactly as it does on a successful one, so `!server`
   * alone cannot tell "this deployment has not enabled that app" apart from "the plugin list could
   * not be read". Only the first is a fact about this deployment, and a request that never came
   * back is no evidence for it.
   */
  if (plugins.data && !server) {
    return (
      <PageShell
        backButton={{ label: paths.pluginsLabel, linkProps: paths.plugins() }}
        description="No app with that name is turned on."
        title={appTitle}
      >
        <PageEmpty icon={IconPlugOff} title="This app is off">
          Nothing to give a Bot here.
        </PageEmpty>
      </PageShell>
    );
  }

  /*
   * Which leaves the other one: no server because the read itself failed. Nothing on this screen
   * survives that — the app's title, its actions and this Bot's grants are all that one response —
   * so it says the read failed and draws nothing else. Not the sentence above, which would be a
   * claim; and not the list either, because a page of switches built from no actions reads as a
   * Bot that holds none. Follows `admin/components/$name`, which states a failed read the same way.
   */
  if (!server) {
    return (
      <PageShell
        backButton={{ label: paths.pluginsLabel, linkProps: paths.plugins() }}
        title={paths.pluginsLabel}
      >
        <p className="mt-12 text-destructive text-sm" role="alert">
          Couldn't load apps. Tentar novamente in a moment.
        </p>
      </PageShell>
    );
  }

  /*
   * Gated on the roster having ARRIVED, not on `bot` being missing — the same guard as the app
   * check above, over the other query.
   *
   * `isPending` goes false on a failed fetch exactly as it does on a successful one, so `!bot`
   * alone cannot tell "this deployment has no such Bot" apart from "the roster could not be read"
   * — and the first of those is a claim, made about a Bot that may be perfectly real, on the
   * evidence of a request that never came back. See `tests/agent-roster-error.test.tsx`, which
   * exists for the same mistake on the two screens that shipped it. With no roster the grants
   * below are still the plugins query's own answer and still true; the name falls back to the id.
   */
  // Both rosters, because a Bot absent from the visible one may simply be hidden.
  if (agents.data && hiddenAgents.data && !bot) {
    return (
      <PageShell
        backButton={back}
        description="There is no Bot with that name."
        title="Not a Bot"
      >
        <PageEmpty icon={IconBolt} title="Bot not found">
          It may have been deleted after you opened this page.
        </PageEmpty>
      </PageShell>
    );
  }

  /*
   * From the row itself, found in either roster. Without one a roster is loading or failed (a Bot
   * missing from both is answered above), and on this Admin page the id is then the only name there
   * is, so it stands in. Screens a person reads go through `useBotNames`, which never shows an id.
   */
  const botName = bot?.name ?? agentId;
  const held = (tool: PluginTool) => tool.grantedTo.includes(agentId);

  /*
   * What the search is over: the action's own name, which is what somebody arriving here already
   * knows. An app of this size is not read top to bottom, and a field that searched descriptions
   * too would answer a typed name with a screenful of rows that do not carry it.
   */
  const needle = search.trim().toLowerCase();
  const matching = needle
    ? server.tools.filter((tool) => tool.name.toLowerCase().includes(needle))
    : server.tools;
  const reads = matching.filter((tool) => tool.effect === "read");
  const writes = matching.filter((tool) => tool.effect === "write");

  /*
   * What the Bot would hold afterwards, counted over every tool rather than the filtered ones: the
   * button grants every read whatever the search is showing, and a count that moved while somebody
   * typed would be describing a different action than the one the button takes.
   */
  const everyRead = readOnlyRefs(server.tools);
  const ungranted = everyRead.filter(
    (ref) => !server.tools.some((tool) => tool.ref === ref && held(tool)),
  );
  const wouldHold = server.tools.filter(
    (tool) => held(tool) || tool.effect === "read",
  ).length;

  /*
   * The approval already standing for THIS app, read off the Bot's own exposure rather than off any
   * one tool — a grant is per-action but the account behind a Shared app is one account, approved or
   * not for the whole of it. `undefined` while `exposure` has not answered yet, which is exactly what
   * routes a switch flipped mid-load to the dialog: see the comment on `onCheckedChange` below.
   */
  const sharedApp = exposure.data?.apps.find((app) => app.serverId === key);

  /*
   * The confirm button on the shared-grant dialog: the one write a switched-on Switch is still
   * waiting for once somebody has set the audience they want. `grantPlugin` takes the approval
   * directly — this is the one request in the app allowed to set one, being an administrator's own
   * narrowing of it — and the dialog closes only once the grant is in and the page has refetched, so
   * it never reports done while the switch underneath it is still off.
   */
  const confirmSharedGrant = async () => {
    if (!pendingGrant) return;
    setError(null);
    setGrantingShared(true);
    try {
      await grantPlugin({
        agentId,
        kind: "mcp",
        ref: pendingGrant.ref,
        approval,
      });
      await invalidatePlugins(queryClient);
      await queryClient.invalidateQueries({
        queryKey: sharedUseKeys.bot(agentId),
      });
      setPendingGrant(null);
    } catch (thrown) {
      setError((thrown as Error).message);
    } finally {
      setGrantingShared(false);
    }
  };

  /** One card of switchable rows. Both sections are the same row, so they are the same code. */
  const rows = (tools: PluginTool[]) => (
    <PageRows>
      {tools.map((tool, index) => (
        <React.Fragment key={tool.ref}>
          <Item size="sm">
            <ItemContent>
              <ItemTitle className="font-mono text-xs">{tool.name}</ItemTitle>
              <ItemDescription>
                {tool.description || "This Ação has no Descrição."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {/*
               * Drawn only for an action the vendor warns about, and nothing at all beside one it
               * does not. `destructive` is false when the vendor made no claim, which is not a
               * claim of safety — so an absence stays an absence here rather than becoming a green
               * word that says more than anybody knows.
               *
               * The destructive colour rather than the amber this app's tool Lista Dá writes: the
               * heading over these rows already says they change things, and the one thing Esquerda to
               * say about this row É that what Ele changes does not come Voltar.
               */}
              {tool.destructive ? (
                <span className="text-destructive text-xs">
                  destroys things
                </span>
              ) : null}
              {/*
               * Binary and immediate, which É what a Switch É Para: Ele takes effect when switched
               * and there É no save. Ele É on Para a Conceder that exists and off otherwise — nothing
               * here É switched on by Padrão, and nothing É proposed pre-switched. Desativado only
               * while Dela/Desse own write É Em flight, so switching one Ação does not freeze the Lista.
               */}
              {alwaysOn ? (
                // Refused one Bot at a time by the server: Routines É every Bot's.
                <span className="text-muted-foreground text-xs">Sempre ativo</span>
              ) : (
                <Switch
                  aria-label={`Let ${botName} call ${tool.name}`}
                  checked={held(tool)}
                  disabled={
                    granting !== null ||
                    pendingGrant?.ref === tool.ref ||
                    (setGrant.isPending && setGrant.variables?.ref === tool.ref)
                  }
                  onCheckedChange={(next) => {
                    setError(null);
                    /*
                     * A Shared app has one account behind every action on it, so switching one on is
                     * consent for what that account can do, not just for this row — and that consent
                     * is asked for once per app, not once per action. Already held for this app (an
                     * approval `exposure` already carries) takes the switch straight through below; not
                     * yet held — including while `exposure` is still loading, which is exactly when a
                     * stale "no approval yet" must not be trusted as the final answer — stops here and
                     * asks first.
                     */
                    if (next && shared && !sharedApp?.approval) {
                      setPendingGrant({ ref: tool.ref });
                      setApproval(
                        sharedApp?.needed ?? {
                          audience: "team",
                          outsideInput: false,
                          members: [],
                        },
                      );
                      return;
                    }
                    setGrant.mutate({
                      agentId,
                      granted: next,
                      kind: "mcp",
                      ref: tool.ref,
                    });
                  }}
                />
              )}
            </ItemActions>
          </Item>
          {index !== tools.length - 1 && <Separator />}
        </React.Fragment>
      ))}
    </PageRows>
  );

  return (
    <PageShell
      backButton={back}
      description={`Which ${appTitle} actions ${botName} can call. Turning one off applies from the next call.`}
      title={`${botName} and ${appTitle}`}
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <SkippedToolsNotice names={server.skippedTools ?? []} />

      {server.tools.length === 0 ? (
        <PageEmpty icon={IconTool} title="No Ações listed">
          {toolsListError(server.lastError, {
            title: server.title,
            personal: false,
          }) ?? "Refresh its tools to check again."}
        </PageEmpty>
      ) : (
        <>
          {/*
           * The whole set in a sentence, above the switches that set it one action at a time. Not for
           * an app every Bot always has: there is nothing to choose.
           */}
          {alwaysOn ? null : (
            <DescribeGrants
              agentId={agentId}
              appKey={key}
              appTitle={appTitle}
              botName={botName}
              sharedNeeded={
                shared && !sharedApp?.approval
                  ? (sharedApp?.needed ?? {
                      audience: "team",
                      outsideInput: false,
                      members: [],
                    })
                  : null
              }
            />
          )}

          <Input
            aria-label={`Search ${appTitle} actions`}
            className="mt-6"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Pesquisar por nome de ação"
            value={search}
          />

          {/*
           * The one bulk action on this screen, and the count comes first: it says what the Bot
           * would hold afterwards, before anybody presses anything, because the alternative is a
           * button whose result is only visible once it has happened forty times.
           *
           * Hidden when there is nothing left for it to do. A button promising a state the Bot is
           * already in can only be pressed to find that out.
           */}
          {ungranted.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                {`This Bot would then have ${wouldHold} ${
                  wouldHold === 1 ? "tool" : "tools"
                } from this app.`}
              </p>
              <Button
                disabled={granting !== null}
                onClick={() => void grantEveryRead(ungranted)}
                size="sm"
                type="button"
                variant="outline"
              >
                {/* The one in flight, not the ones finished: a count starting at zero of forty reads as nothing happening. */}
                {granting
                  ? `Granting ${Math.min(granting.done + 1, granting.total)} of ${granting.total}…`
                  : "Turn on every read-only Ação"}
              </Button>
            </div>
          ) : null}

          <PageSection
            description={
              sharedSectionSentence("read", shared) ??
              "These only read. Boundaries about writes don't apply to them."
            }
            title="Reads"
          >
            {reads.length === 0 ? (
              <PageEmpty
                icon={needle ? IconSearch : IconListDetails}
                title={needle ? "No matches" : "No read-only Ações"}
              >
                {needle
                  ? `Nothing that only reads matches "${search.trim()}".`
                  : `${appTitle} has no read-only actions.`}
              </PageEmpty>
            ) : (
              rows(reads)
            )}
          </PageSection>

          <PageSection
            description={
              sharedSectionSentence("write", shared) ??
              "These change something at the vendor. Boundaries about writes apply to them."
            }
            title="Changes things"
          >
            {writes.length === 0 ? (
              <PageEmpty
                icon={needle ? IconSearch : IconListDetails}
                title={needle ? "No matches" : "No Ações that change things"}
              >
                {needle
                  ? `Nothing that changes things matches "${search.trim()}".`
                  : `${appTitle} has no actions that change things.`}
              </PageEmpty>
            ) : (
              rows(writes)
            )}
          </PageSection>

          {/*
           * Stacked over the switch it came from, same pattern as a Bot's delete confirmation in
           * `bot-profile/manage.tsx`: the consent a Shared app needs is its own moment, not a row that
           * happens to have grown a form. Closing without confirming — the backdrop, Escape, or
           * Cancel — leaves `pendingGrant` behind and the Switch stays exactly where it was; nothing
           * is granted until the confirm button below runs.
           */}
          <Dialog
            onOpenChange={(next) => !next && setPendingGrant(null)}
            open={pendingGrant !== null}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  Let {botName} use the shared {appTitle} account?
                </DialogTitle>
              </DialogHeader>
              <DialogBody className="mt-4 overflow-y-auto">
                <SharedApprovalFields onChange={setApproval} value={approval} />
              </DialogBody>
              {/*
               * The same `error` the rest of the screen reports a refused write with, shown here too:
               * the dialog stays open on a refusal rather than closing over it, so whoever is looking
               * at the form that was refused is where the reason has to be.
               */}
              {error ? (
                <p className="mt-4 text-destructive text-sm" role="alert">
                  {error}
                </p>
              ) : null}
              <DialogFooter className="mt-4">
                <Button
                  onClick={() => setPendingGrant(null)}
                  size="sm"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  disabled={grantingShared || approvalNamesNobody(approval)}
                  onClick={() => void confirmSharedGrant()}
                  size="sm"
                >
                  {grantingShared ? "Allowing…" : "Permitir"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </PageShell>
  );
}
