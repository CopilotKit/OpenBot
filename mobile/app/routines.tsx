import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { everyBot, everyPage, ORGANIZATION_ID, type Routine } from "../src/api";
import {
  listRoutines,
  pauseRoutine,
  resumeRoutine,
} from "../src/api/generated/routines/routines";
import { authClient } from "../src/auth";
import {
  BotOrb,
  EmptyState,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Toggle,
} from "../src/components";
import { IconClock } from "../src/icons";
import { lastRunLine, when } from "../src/routines";
import { useAction } from "../src/ui";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";

/** Routines: the work every Bot starts by itself for you, under the Bot that does it. */
export default function Routines() {
  const { data: session } = authClient.useSession();
  const action = useAction();
  const loadRoutines = useCallback(
    () =>
      everyPage(
        (page) => listRoutines(ORGANIZATION_ID, page),
        (page) => page.routines,
      ),
    [],
  );
  const routines = useLoad(loadRoutines, Boolean(session));
  const loadBots = useCallback(() => everyBot(), []);
  const bots = useLoad(loadBots, Boolean(session));
  const pull = usePull(routines.refresh, bots.refresh);
  const byBot = useMemo(() => {
    const grouped = new Map<string, Routine[]>();
    for (const routine of routines.data ?? [])
      grouped.set(routine.botId, [
        ...(grouped.get(routine.botId) ?? []),
        routine,
      ]);
    return [...grouped.entries()];
  }, [routines.data]);
  async function setActive(routine: Routine, enabled: boolean) {
    await action.run(routine.id, async () => {
      await (enabled ? resumeRoutine : pauseRoutine)(
        ORGANIZATION_ID,
        routine.id,
      );
      await routines.refresh();
    });
  }
  return (
    <ScrollScreen refreshing={pull.refreshing} onRefresh={pull.onRefresh}>
      <Notice message={action.error || routines.error || bots.error} />
      {byBot.map(([botId, list]) => {
        const bot = bots.data?.find((item) => item.id === botId);
        return (
          <Section
            key={botId}
            title={bot?.name ?? "Bot"}
            action={
              <BotOrb
                seed={bot?.avatarSeed || botId}
                name={bot?.name ?? "Bot"}
                size={16}
              />
            }
          >
            <Rows>
              {list.map((routine) => (
                <Row
                  key={routine.id}
                  icon={IconClock}
                  title={routine.title || routine.instruction}
                  description={[
                    routine.enabled
                      ? `Next run ${when(routine.nextRunAt)}`
                      : "Paused",
                    routine.lastRun
                      ? lastRunLine(routine.lastRun.status)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  trailing={
                    <Toggle
                      label="Active"
                      value={routine.enabled}
                      disabled={Boolean(action.busy)}
                      onValueChange={(enabled) =>
                        void setActive(routine, enabled)
                      }
                    />
                  }
                  onPress={() =>
                    router.push({
                      pathname: "/routine",
                      params: { routineId: routine.id },
                    })
                  }
                />
              ))}
            </Rows>
          </Section>
        );
      })}
      {routines.data?.length === 0 ? (
        <EmptyState
          icon={IconClock}
          title="No routines yet"
          description="Ask a Bot in a conversation to do something on a schedule, and it shows up here."
        />
      ) : null}
    </ScrollScreen>
  );
}
