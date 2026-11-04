import { IconPlus, IconRobot } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";

/*
 * Which of your Bots carry a skill.
 *
 * WITHOUT THIS THE SKILL DOES NOTHING. A skill reaches a Bot's `/` menu only through a grant: the
 * menu is fed by `GET /api/plugins/for/:agentId`, which returns what that Bot HOLDS, and a row in
 * `plugin_grants` IS the grant — absence is the refusal. A skill nobody granted is written, listed,
 * and invisible everywhere it would actually be used.
 *
 * ONLY BOTS THIS PERSON OWNS. The server's rule is that somebody may put THEIR OWN skill on a Bot
 * THEY OWN, and neither half alone is enough — a skill one person wrote would otherwise change how a
 * shared Bot answers everybody. Offering the others here and having them refused on click would be
 * a worse answer than not offering them.
 *
 * A ROW PER BOT WITH A SWITCH, because each one is a yes or no, which is what a switch says. The face
 * and title are there so a person with several Bots can tell which is which without opening any.
 */

/**
 * The switches, for a skill that exists: each one saves the moment it is pressed, so the section
 * sits outside the form and its Save button, which it has nothing to do with.
 */
export function SkillAgents({
  slug,
  grantedTo,
}: {
  slug: string;
  grantedTo: string[];
}) {
  const queryClient = useQueryClient();
  const grant = useMutation(setPluginGrantMutationOptions(queryClient));
  const held = new Set(grantedTo);

  /*
   * The answer being saved, shown at once. Between the press and the refetch the skill's `grantedTo`
   * still says the old thing, and a switch that springs back for half a second before settling reads
   * as the press not having worked.
   */
  const isOn = (agentId: string) =>
    grant.isPending && grant.variables?.agentId === agentId
      ? grant.variables.granted
      : held.has(agentId);

  return (
    <PageSection
      description={
        <>
          Typing <code>/{slug}</code> on these Bots uses this skill. Saved as
          you switch them.
        </>
      }
      title="Bots"
    >
      <BotSwitches
        busy={grant.isPending ? grant.variables?.agentId : undefined}
        isOn={isOn}
        onSwitch={(agentId, on) =>
          grant.mutate({ agentId, granted: on, kind: "skill", ref: slug })
        }
      />
      {grant.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {grant.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}

/**
 * The switches, for a skill not written yet: the picks are held here and put on once it is created,
 * so a new skill does not start out on no Bot, where it does nothing.
 */
export function SkillBotPicks({
  picked,
  onChange,
}: {
  picked: string[];
  onChange: (agentIds: string[]) => void;
}) {
  return (
    <PageSection
      description="The Bots that offer it as soon as it's created."
      title="Bots"
    >
      <BotSwitches
        isOn={(agentId) => picked.includes(agentId)}
        onSwitch={(agentId, on) =>
          onChange(
            on
              ? [...picked, agentId]
              : picked.filter((each) => each !== agentId),
          )
        }
      />
    </PageSection>
  );
}

/** Every Bot this person owns, each with a switch; or, with none, the way to make one. */
function BotSwitches({
  isOn,
  onSwitch,
  busy,
}: {
  isOn: (agentId: string) => boolean;
  onSwitch: (agentId: string, on: boolean) => void;
  /** The Bot whose switch is being saved, held still until it is. */
  busy?: string;
}) {
  const { data: agents, isPending } = useQuery(agentListQueryOptions());
  const mine = (agents ?? []).filter((agent) => agent.mine);

  if (isPending) return null;

  if (mine.length === 0) {
    return (
      <PageEmpty
        action={
          <Button
            render={(props) => (
              <Link {...props} search={{ new: true }} to="/bots" />
            )}
            size="sm"
            variant="outline"
          >
            <IconPlus />
            New Bot
          </Button>
        }
        icon={IconRobot}
        title="No Bots of your own yet"
      >
        A skill goes on Bots you own. Make one, then switch this skill on for
        it.
      </PageEmpty>
    );
  }

  return (
    <PageRows>
      {mine.map((agent, index) => {
        const id = `skill-bot-${agent.id}`;
        return (
          <Fragment key={agent.id}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia>
                <AbstractAvatar
                  name={agent.name}
                  seed={agent.avatarSeed}
                  size={28}
                />
              </ItemMedia>
              {/* The text is the switch's label, so the name toggles it too. */}
              <label
                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
                htmlFor={id}
              >
                <ItemTitle className="truncate">{agent.name}</ItemTitle>
                {agent.title ? (
                  <ItemDescription className="line-clamp-1">
                    {agent.title}
                  </ItemDescription>
                ) : null}
              </label>
              <ItemActions>
                <Switch
                  checked={isOn(agent.id)}
                  disabled={busy === agent.id}
                  id={id}
                  onCheckedChange={(checked) => onSwitch(agent.id, checked)}
                />
              </ItemActions>
            </Item>
          </Fragment>
        );
      })}
    </PageRows>
  );
}
