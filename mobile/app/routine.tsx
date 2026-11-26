import {
  Redirect,
  router,
  Stack,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import { useCallback } from "react";
import { Alert, View } from "react-native";
import { everyBot, everyPage, ORGANIZATION_ID } from "../src/api";
import {
  deleteRoutine,
  listRoutineRuns,
  listRoutines,
  pauseRoutine,
  resumeRoutine,
  runRoutine,
} from "../src/api/generated/routines/routines";
import { authClient } from "../src/auth";
import {
  BotOrb,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
  Toggle,
} from "../src/components";
import { headerActions } from "../src/header";
import { IconPencil } from "../src/icons";
import { runLabel, runTone, when } from "../src/routines";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";
import { took } from "../src/when";

/** A time zone as a person says it: "America/Los_Angeles" as "Los Angeles". */
const zoneName = (zone: string) =>
  (zone.split("/").pop() ?? zone).replace(/_/g, " ");

/**
 * One routine, as a Bot's page opens: the orb of the Bot that runs it, its name and its Bot, then
 * one card of rows (whether it is active, when it runs, where it reports, Run now), what it does,
 * and its run history. Deleting it is the last row on the page.
 */
export default function RoutineScreen() {
  const { routineId = "" } = useLocalSearchParams<{ routineId: string }>();
  const { data: session, isPending } = authClient.useSession();
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
  // Back from Edit routine: the page shows what was saved.
  const { refresh: refreshRoutines } = routines;
  useFocusEffect(
    useCallback(() => {
      void refreshRoutines();
    }, [refreshRoutines]),
  );
  const loadRuns = useCallback(
    () =>
      everyPage(
        (page) => listRoutineRuns(ORGANIZATION_ID, routineId, page),
        (page) => page.runs,
      ),
    [routineId],
  );
  const runs = useLoad(loadRuns, Boolean(session && routineId));
  // The Bot that runs it, for its orb and name at the top.
  const loadBots = useCallback(() => everyBot(), []);
  const bots = useLoad(loadBots, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  const routine = routines.data?.find((item) => item.id === routineId);
  const running = runs.data?.some((run) => run.status === "running");
  const bot = bots.data?.find((item) => item.id === routine?.botId);

  async function setActive(enabled: boolean) {
    await action.run("active", async () => {
      await (enabled ? resumeRoutine : pauseRoutine)(
        ORGANIZATION_ID,
        routineId,
      );
      await routines.refresh();
    });
  }
  async function runNow() {
    await action.run("run", async () => {
      await runRoutine(ORGANIZATION_ID, routineId);
      await runs.refresh();
    });
  }
  async function remove() {
    const removed = await action.run("delete", () =>
      deleteRoutine(ORGANIZATION_ID, routineId),
    );
    if (removed) router.back();
  }

  return (
    <ScrollScreen
      refreshing={routines.pending || runs.pending}
      onRefresh={() => {
        void routines.refresh();
        void runs.refresh();
      }}
    >
      <Stack.Screen
        options={{
          // The page names it under the orb, as a Bot's page does.
          title: "",
          ...headerActions(
            routine
              ? [
                  {
                    label: "Edit routine",
                    sf: "pencil",
                    icon: IconPencil,
                    onPress: () =>
                      router.push({
                        pathname: "/routine-form",
                        params: { routineId: routine.id },
                      }),
                  },
                ]
              : [],
          ),
        }}
      />
      <Notice
        message={action.error || routines.error || runs.error || undefined}
      />
      {routines.data && !routine ? (
        <Text tone="muted">This routine no longer exists.</Text>
      ) : null}
      {routine ? (
        <>
          <View className="items-center gap-3">
            <BotOrb
              seed={bot?.avatarSeed || routine.botId}
              name={bot?.name ?? "Bot"}
              size={64}
            />
            <View className="items-center gap-1">
              <Text variant="heading" className="text-center">
                {routine.title || "Routine"}
              </Text>
              {bot ? (
                <Text tone="muted" className="text-center text-sm">
                  {`Runs as ${bot.name}`}
                </Text>
              ) : null}
            </View>
          </View>
          <Rows iconless>
            <Row
              title="Active"
              description={
                routine.enabled
                  ? `Next run ${when(routine.nextRunAt)}`
                  : "Paused"
              }
              trailing={
                <Toggle
                  label="Active"
                  value={routine.enabled}
                  disabled={Boolean(action.busy)}
                  onValueChange={(enabled) => {
                    void setActive(enabled);
                  }}
                />
              }
            />
            <Row
              title="Schedule"
              description={`${routine.schedule}, ${zoneName(routine.timezone)} time`}
            />
            <Row
              title="Reports in"
              description={
                routine.conversation.gone
                  ? "A deleted chat. Change it from a chat."
                  : (routine.conversation.name ?? "A chat")
              }
            />
            <Row
              title={running ? "Running…" : "Run now"}
              description={
                routine.enabled ? undefined : "Turn on Active to run it."
              }
              chevron={false}
              onPress={
                !routine.enabled || action.busy || running
                  ? undefined
                  : () => {
                      void runNow();
                    }
              }
            />
          </Rows>
          <Section title="What it does">
            <Rows iconless>
              <View className="px-3 py-3">
                <Text>{routine.instruction}</Text>
              </View>
            </Rows>
          </Section>
          <Section title="Run history">
            {runs.data?.length === 0 ? (
              <Text tone="muted">No runs yet.</Text>
            ) : null}
            {runs.data?.length ? (
              <Rows iconless>
                {runs.data.map((run) => (
                  <View key={run.id} className="gap-0.5 px-3 py-2.5">
                    {runLabel(run.status) ? (
                      <Text
                        variant="label"
                        tone={runTone(run.status)}
                        className="font-semibold"
                      >
                        {runLabel(run.status)}
                      </Text>
                    ) : null}
                    <Text variant="caption" tone="muted">
                      {[
                        when(run.startedAt),
                        // A skipped run did no work, so it took no time worth saying.
                        run.status !== "skipped" &&
                          took(run.startedAt, run.finishedAt) &&
                          `took ${took(run.startedAt, run.finishedAt)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                    {run.error ? (
                      // What stopped a failed run is in the color of what failed; why a run was skipped is not an error.
                      <Text
                        variant="caption"
                        tone={run.status === "failed" ? "danger" : "muted"}
                      >
                        {run.error}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </Rows>
            ) : null}
          </Section>
          <Rows iconless>
            <Row
              title="Delete routine"
              tone="danger"
              chevron={false}
              onPress={
                action.busy
                  ? undefined
                  : () =>
                      Alert.alert(
                        "Delete this routine?",
                        "It stops running and its history is removed.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Delete",
                            style: "destructive",
                            onPress: () => {
                              void remove();
                            },
                          },
                        ],
                      )
              }
            />
          </Rows>
        </>
      ) : null}
    </ScrollScreen>
  );
}
