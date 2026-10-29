import { IconArrowsExchange, IconLock, IconRobot } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import { handoffRoster } from "@/lib/agents/handoff-roster";
import { setHandoffGrantMutationOptions } from "@/lib/agents/mutations";
import {
  agentHandoffQueryOptions,
  agentListQueryOptions,
} from "@/lib/agents/queries";
import { queryClient } from "@/query-client";

/**
 * Which Bots this one may hand work to.
 *
 * On the Bot's own screen rather than in the connector catalogue: a catalogue entry has a fixed list
 * of tools somebody else maintains, and the Bots a deployment has are whatever was made here. It is
 * also the question a person asks while looking at a Bot, not while looking at a vendor.
 *
 * DIRECTIONAL, and said so on the screen, because the pair is the one thing about this that is easy
 * to get backwards: this is who this Bot may ask, not who may ask it.
 *
 * One row per candidate, with a Switch: the grant is one boolean that takes effect when switched,
 * which is exactly the row kind a Switch means everywhere else in this app. A whole page section of
 * its own, and nothing at all when there is nothing to say to somebody who cannot change it.
 */
export function HandoffPanel({ agentId }: { agentId: string }) {
  const handoff = useQuery(agentHandoffQueryOptions(agentId));
  const agents = useQuery(agentListQueryOptions());
  /*
   * The roster this person has hidden, read so a grant pointing into it can still be taken away.
   *
   * Hiding is a per-person display preference and the grants are not filtered by it at all, so
   * joining the grants against the visible roster alone dropped live grants off the only screen that
   * manages them. See `handoffRoster`, which is where that join now happens.
   */
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const setGrant = useMutation(setHandoffGrantMutationOptions(queryClient));

  if (handoff.isPending || !handoff.data) return null;
  const { enabled, canGrant, reachable, grantable } = handoff.data;

  // A Bot may not be granted itself, and the server refuses it, so it is not offered here either.
  const { candidates, granted, total } = handoffRoster({
    agentId,
    roster: agents.data ?? [],
    hidden: hiddenAgents.data ?? [],
    reachable,
    grantable,
  });

  // Nothing to say to somebody who cannot change it and has nothing to read.
  if (!canGrant && reachable.length === 0) return null;

  return (
    <PageSection
      action={
        /* The current answer at a glance, so the list below is detail rather than homework. */
        grantable && total > 0 ? (
          <span className="text-muted-foreground text-sm tabular-nums">
            {granted} of {total}
          </span>
        ) : null
      }
      description="Choose which Bots this Bot can ask for help. Their answers appear in the same conversation under their own names. This does not change who can ask this Bot for help."
      title="Bots it can ask"
    >
      {/* Facts about the deployment rather than rows to act on, so said as sentences. */}
      {enabled ? null : (
        <PageEmpty icon={IconArrowsExchange} title="Handoffs are off">
          An admin turned off handing work between Bots. These settings are
          kept, and they apply again once it's back on.
        </PageEmpty>
      )}

      {grantable ? null : (
        <PageEmpty icon={IconLock} title="Can't hand off work">
          This Bot can't hand work to other Bots. Other Bots can still hand work
          to it.
        </PageEmpty>
      )}

      {setGrant.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {setGrant.error.message}
        </p>
      ) : null}

      {grantable && total === 0 ? (
        <PageEmpty icon={IconRobot} title="No other Bots yet">
          When there are more, you can let this Bot ask them here.
        </PageEmpty>
      ) : null}
      {candidates.length > 0 ? (
        <PageRows>
          {candidates.map((candidate, index) => (
            <Fragment key={candidate.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia>
                  <AbstractAvatar
                    name={candidate.name}
                    seed={candidate.avatarSeed}
                    size={28}
                  />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{candidate.name}</ItemTitle>
                  {/*
                   * Said on the row, because otherwise it is a coworker that is not on your roster
                   * appearing in a list with no explanation. It is here only because this Bot may
                   * already ask it, and that is the sentence a person needs to decide what to do.
                   */}
                  <ItemDescription>
                    {candidate.hidden
                      ? `${candidate.title} · hidden from your Bots list`
                      : candidate.title}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={`Let this Bot ask ${candidate.name}`}
                    checked={reachable.includes(candidate.id)}
                    disabled={!canGrant || setGrant.isPending}
                    onCheckedChange={(next: boolean) =>
                      setGrant.mutate({
                        agentId,
                        ref: candidate.id,
                        granted: next,
                      })
                    }
                  />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      ) : null}

      {canGrant ? null : (
        <PageEmpty icon={IconLock} title="Set by an admin">
          An admin decides which Bots this one can ask.
        </PageEmpty>
      )}
    </PageSection>
  );
}
