import { IconPlug, IconSearch } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
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
import {
  consentBreadth,
  coverageWarning,
  matchingApps,
} from "@/lib/plugins/enablement-notes";
import {
  enableComposioAppMutationOptions,
  invalidatePlugins,
} from "@/lib/plugins/mutations";
import {
  directoryReadFailure,
  type PluginsProvider,
  providerVocabulary,
} from "@/lib/plugins/provider-vocabulary";
import {
  type ComposioApp,
  composioAppsQueryOptions,
} from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";

/**
 * The active broker's directory, searched rather than listed.
 *
 * The catalogue on the previous screen is a reviewed handful, and every entry there is a decision
 * somebody made about a vendor. This is a directory nobody here has reviewed, which is why it is a
 * search field and not a list: the only sensible entry point into a directory that size is the name
 * of the app you already came looking for.
 *
 * Adding one is account-wide, and it still reads nothing. Every app here is reached as whoever is
 * asking, so a person's own connection is what makes their own mail or messages readable — which is
 * made on their settings page, not here.
 *
 * A COMPONENT AND NOT A ROUTE, so both directory routes are the same screen rather than two that
 * drift. A route file importing another route file is how that drift starts, so neither does. Every
 * vendor word is read from {@link providerVocabulary}; nothing here spells a vendor, and nothing
 * here branches on which one it is — a `provider === "composio"` test inside a screen is the same
 * mistake wearing a conditional.
 */
export function BrokerDirectory({ provider }: { provider: PluginsProvider }) {
  const { name, directoryLabel } = providerVocabulary(provider);
  const [search, setSearch] = React.useState("");
  /*
   * Debounced, as on People, and for a stronger reason: every distinct term is a cache key of its
   * own and a request to the vendor, so typing a name un-debounced is a round trip per keystroke
   * against somebody else's rate limit.
   */
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const apps = useQuery(composioAppsQueryOptions(query, provider));
  /*
   * WHAT A FAILED ADD SAID, KEPT WHERE A SECOND ADD CANNOT ERASE IT.
   *
   * ONE OBSERVER SERVES EVERY BUTTON, which is what `enable.variables` below is already written
   * around — and the same fact makes `enable.error` unusable as the place a refusal lives.
   * `MutationObserver.mutate` does `this.#currentMutation?.removeObserver(this)` and rebuilds, so
   * `error`, `isPending` and `variables` describe ONLY the most recent press. An admin pressing Add
   * on Slack and then, a beat later, on Gmail watched Slack's row revert from "Adding…" to "Add"
   * with its request still in flight — and when Slack came back 409, or 503, or carrying the
   * vendor's own sentence about a bad key, the banner never showed it, because `enable.error` was
   * Gmail's and Gmail's was null. What was left was a row saying "Add" and no record of a failure.
   *
   * THE MUTATION-LEVEL `onError` STILL FIRES AFTER `removeObserver`, which is why this works and
   * reading the observer does not. It is the shape the sibling grant screen already uses
   * (`$key_.bots.$agentId.tsx`), arriving at the one screen that was reading the observer instead.
   */
  const [enableError, setEnableError] = React.useState<string | null>(null);
  /*
   * AND WHICH ROWS ARE IN FLIGHT, FOR THE SAME REASON AND OUT OF THE SAME HOOKS.
   *
   * `enable.isPending && enable.variables?.slug === entry.slug` is the observer again: it names the
   * most recent press and no other, so pressing Add on a second app put the FIRST row back to "Add"
   * with its request still open — an invitation to press it again, which asks the server to enable
   * an app it is already enabling. A set of slugs is what survives the rebuild, added in `onMutate`
   * and removed in `onSettled` so it drains on a refusal exactly as it does on a success.
   */
  const [adding, setAdding] = React.useState<ReadonlySet<string>>(new Set());
  const enable = useMutation({
    ...enableComposioAppMutationOptions(queryClient),
    onMutate: (input: { slug: string }) => {
      setEnableError(null);
      setAdding((held) => new Set(held).add(input.slug));
    },
    onError: (thrown: Error) => setEnableError(thrown.message),
    /*
     * SPELLED OUT RATHER THAN INHERITED, because the spread above carries an `onSettled` of its own
     * — `invalidatePlugins` — and a second one here replaces it rather than running beside it. The
     * refetch is what turns the added row into "Added", so dropping it would leave the list claiming
     * the app is still addable until something else invalidated.
     */
    onSettled: (_data, _error, input) => {
      setAdding((held) => {
        const left = new Set(held);
        left.delete(input.slug);
        return left;
      });
      return invalidatePlugins(queryClient);
    },
  });
  const listed = matchingApps(apps.data?.apps ?? []);

  return (
    <PageShell
      backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
      description={`${name}'s app directory. Add an app to make its tools available to Bots. Each person still connects their own account before it reads anything.`}
      title={directoryLabel}
    >
      <PageSection
        description="Search by name. Nobody here has reviewed these apps."
        title="Apps"
      >
        {enableError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {enableError}
          </p>
        ) : null}

        <Input
          aria-label={`Search ${name} apps`}
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by app name"
          value={search}
        />

        {/* Pending, error, empty, rows — pending first, so no sentence asserts anything mid-fetch. */}
        {apps.isPending ? null : apps.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {/*
             * The server's own sentence, as the enable failure above already does. A keyless
             * deployment is refused with one naming the key's environment variable, and that name is
             * the single thing an operator who reached this URL needs to read; the derived line
             * stays as the fallback for a failure that arrived carrying no message of its own.
             */}
            {apps.error.message || directoryReadFailure(provider)}
          </p>
        ) : listed.length === 0 ? (
          <PageEmpty
            icon={query ? IconSearch : IconPlug}
            title={query ? "No matches" : "No apps"}
          >
            {query
              ? `No ${name} app matches "${query}".`
              : `${name} returned no apps.`}
          </PageEmpty>
        ) : (
          <PageRows>
            {listed.map((entry, index) => {
              // One mutation serves every row, so which rows are mid-request is tracked beside it
              // rather than read off it. See `adding` above.
              const isAdding = adding.has(entry.slug);

              return (
                <React.Fragment key={entry.slug}>
                  {/* The test id names the screen, not the vendor: this module draws whichever
                      broker is active, and the id is not user-visible. */}
                  <Item data-testid={`directory-${entry.slug}`} size="sm">
                    {/* The vendor's own mark where the broker supplies one, and a plug where it does
                        not, so a list of third parties still has a fixed left edge. */}
                    <ItemMedia variant={entry.logo ? "image" : "icon"}>
                      {entry.logo ? (
                        <img alt="" src={entry.logo} />
                      ) : (
                        <IconPlug />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{entry.name}</ItemTitle>
                      <ItemDescription>{entry.description}</ItemDescription>
                      {entry.enabled ? null : <CoverageNote app={entry} />}
                      {entry.enabled ? null : <BreadthNote app={entry} />}
                    </ItemContent>
                    <ItemActions>
                      {/* The size of the decision, stated before it is made: an app is not one
                          tool, and "167 actions" is what says so. */}
                      <span className="text-muted-foreground text-xs">
                        {entry.actionCount} actions
                      </span>
                      {/*
                       * An app this deployment already has says so rather than offering Add again.
                       * A second Add would ask the server to record a connector it already holds,
                       * and there is nothing on the row to suggest that would be harmless.
                       */}
                      {entry.enabled ? (
                        <span className="text-muted-foreground text-xs">
                          Added
                        </span>
                      ) : (
                        <Button
                          disabled={isAdding}
                          onClick={() => enable.mutate({ slug: entry.slug })}
                          size="sm"
                          variant="outline"
                        >
                          {isAdding ? "Adding…" : "Add"}
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                  {index !== listed.length - 1 && <Separator />}
                </React.Fragment>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}

/** The warning on a row, shown before Add is pressed. Draws nothing when there is none. */
export function CoverageNote({ app }: { app: ComposioApp }) {
  const warning = coverageWarning(app);
  if (!warning) return null;
  return (
    <p className="text-muted-foreground text-xs" data-testid="coverage-warning">
      {warning}
    </p>
  );
}

/** The breadth line on a row, shown before Add is pressed. Draws nothing when there is none. */
export function BreadthNote({ app }: { app: ComposioApp }) {
  const breadth = consentBreadth(app);
  if (!breadth) return null;
  return (
    <p className="text-muted-foreground text-xs" data-testid="breadth-note">
      {breadth}
    </p>
  );
}
