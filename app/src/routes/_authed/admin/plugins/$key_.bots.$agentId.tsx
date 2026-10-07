import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  SharedApprovalFields,
  sharedSectionSentence,
} from "@/components/plugins/shared-approval-fields";
import { Button } from "@/components/ui/button";
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
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  grantPlugin,
  invalidatePlugins,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import {
  type PluginTool,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import {
  botSharedAppsQueryOptions,
  type SharedUseApproval,
  sharedUseKeys,
} from "@/lib/plugins/shared-use";

/**
 * One Bot and one app: every action the app offers, and which of them this Bot holds.
 *
 * The sibling screen — `$key_.tools.$tool` — answers the same question from the other end, one
 * action and every Bot, and that is the right shape when somebody is thinking about an action. It
 * is the wrong shape for setting a Bot up against an app that offers a hundred and sixty-seven of
 * them: that is one visit per action, and the decision being made ("what can this Bot do in Slack")
 * is never on screen at once.
 *
 * So the list is searchable and split by what a boundary sees. A read and a write are not the same
 * decision, and an app's actions arrive interleaved by name, which puts `delete_channel` two rows
 * under `list_channels` with nothing between them but a word.
 *
 * `$key_` opts this route out of nesting under `$key.tsx`, so the connector page stays a page rather
 * than becoming a layout with an outlet.
 */
export const Route = createFileRoute(
  "/_authed/admin/plugins/$key_/bots/$agentId",
)({ component: RouteComponent });

/**
 * The refs the bulk action would grant: every action that only reads.
 *
 * Exported as a function so the promise the button makes is assertable without a DOM, a router or
 * a query client — see `tests/bot-app-grants.test.tsx`. The button says "read-only" and states a
 * resulting count before it acts, and both of those are only true if this is exactly the reads.
 *
 * A destructive action can never appear here. `destructive` sits beside `effect` rather than inside
 * it, and the effect a destructive action carries is `write` — anything not positively known to be
 * a read is one — so filtering on the effect alone already excludes it.
 *
 * Every action, not the ones a search happens to be showing. The button names every read-only
 * action and that is what it grants; narrowing it to the filtered rows would make the sentence
 * beside it quietly wrong.
 */
export function readOnlyRefs(tools: PluginTool[]): string[] {
  return tools.filter((tool) => tool.effect === "read").map((tool) => tool.ref);
}

function RouteComponent() {
  const { key, agentId } = useParams({
    from: "/_authed/admin/plugins/$key_/bots/$agentId",
  });
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  /*
   * The ones this person has hidden. A hidden Bot is still a Bot, and still holds whatever it was
   * granted; the connector page links here for it (see `grantRoster`), and this page must not then
   * say there is no such Bot.
   */
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const nameFor = useBotNames();
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

  const server = plugins.data?.servers.find((row) => row.id === key);
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
    plugins.data?.catalogue.find((item) => item.key === key)?.title ??
    server?.title ??
    key;
  const bot =
    agents.data?.find((one) => one.id === agentId) ??
    hiddenAgents.data?.find((one) => one.id === agentId);

  const back = {
    label: appTitle,
    linkProps: {
      params: { key },
      to: "/admin/plugins/$key" as const,
    },
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
        backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
        description="This deployment has not enabled an app by that name."
        title={appTitle}
      >
        <PageEmpty>There is nothing here to grant.</PageEmpty>
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
        backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
        title="Plugins"
      >
        <p className="mt-12 text-destructive text-sm" role="alert">
          Plugins could not be loaded.
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
        description="This deployment has no Bot by that name, so there is nobody to grant these actions to."
        title="Not a Bot"
      >
        <PageEmpty>
          It may have been deleted since this page was opened.
        </PageEmpty>
      </PageShell>
    );
  }

  // From the row itself where there is one: the id-to-name lookup is built from the visible roster.
  const botName = bot?.name ?? nameFor(agentId);
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
                {tool.description || "This action came with no description."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {/*
               * Drawn only for an action the vendor warns about, and nothing at all beside one it
               * does not. `destructive` is false when the vendor made no claim, which is not a
               * claim of safety — so an absence stays an absence here rather than becoming a green
               * word that says more than anybody knows.
               *
               * The destructive colour rather than the amber this app's tool list gives writes: the
               * heading over these rows already says they change things, and the one thing left to
               * say about this row is that what it changes does not come back.
               */}
              {tool.destructive ? (
                <span className="text-destructive text-xs">
                  destroys things
                </span>
              ) : null}
              {/*
               * Binary and immediate, which is what a Switch is for: it takes effect when switched
               * and there is no save. It is on for a grant that exists and off otherwise — nothing
               * here is switched on by default, and nothing is proposed pre-switched. Disabled only
               * while its own write is in flight, so switching one action does not freeze the list.
               */}
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
      description={`Which of ${appTitle}'s actions ${botName} may call. Every call is decided again when it happens, so switching one off takes effect on the next one.`}
      title={`${botName} and ${appTitle}`}
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {server.tools.length === 0 ? (
        <PageEmpty>
          {server.lastError ??
            `${appTitle} lists no actions. Refresh its tools to ask again.`}
        </PageEmpty>
      ) : (
        <>
          <Input
            aria-label={`Search ${appTitle} actions`}
            className="mt-6"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by action name"
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
                {`This Bot would then hold ${wouldHold} ${
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
                  : "Turn on every read-only action"}
              </Button>
            </div>
          ) : null}

          <PageSection
            description={
              sharedSectionSentence("read", shared) ??
              "These only read. A boundary written about writes does not apply to them."
            }
            title="Reads"
          >
            {reads.length === 0 ? (
              <PageEmpty>
                {needle
                  ? `Nothing that only reads matches "${search.trim()}".`
                  : `${appTitle} offers nothing that only reads.`}
              </PageEmpty>
            ) : (
              rows(reads)
            )}
          </PageSection>

          <PageSection
            description={
              sharedSectionSentence("write", shared) ??
              "These change something at the vendor. A boundary written about writes applies to them, and each call is refused when one matches."
            }
            title="Changes things"
          >
            {writes.length === 0 ? (
              <PageEmpty>
                {needle
                  ? `Nothing that changes things matches "${search.trim()}".`
                  : `${appTitle} offers nothing that changes anything.`}
              </PageEmpty>
            ) : (
              rows(writes)
            )}
          </PageSection>

          {/*
           * Stacked over the switch it came from, same pattern as the delete confirmation in
           * `agent-dialog.tsx`: the consent a Shared app needs is its own moment, not a row that
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
              <DialogBody className="mt-4">
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
                  disabled={grantingShared}
                  onClick={() => void confirmSharedGrant()}
                  size="sm"
                >
                  {grantingShared ? "Granting…" : "Let it in"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </PageShell>
  );
}
