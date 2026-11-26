import {
  Redirect,
  router,
  Stack,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import { Button } from "heroui-native/button";
import { useCallback } from "react";
import { Alert, View } from "react-native";
import { everyPage, ORGANIZATION_ID } from "../src/api";
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
  Card,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
  Toggle,
} from "../src/components";
import { headerActions } from "../src/header";
import { IconClock, IconPencil } from "../src/icons";
import { runLabel, runTone, when } from "../src/routines";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";
import { took } from "../src/when";

/**
 * One routine: whether it is active, when it runs, what it does and where it reports, Run now, and
 * its run history. The header names it, by its title where it has one.
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
  if (!session && !isPending) return <Redirect href="/" />;
  const routine = routines.data?.find((item) => item.id === routineId);
  const running = runs.data?.some((run) => run.status === "running");

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
          title: routine?.title || "Routine",
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
          <Rows>
            <Row
              icon={IconClock}
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
          </Rows>
          <Card className="gap-3">
            <Detail
              label="Schedule"
              value={`${routine.schedule} (${routine.timezone})`}
            />
            <Detail label="Instruction" value={routine.instruction} />
            <Detail
              label="Reports in"
              value={
                routine.conversation.gone
                  ? "A deleted chat. Change it from a chat."
                  : (routine.conversation.name ?? "A chat")
              }
            />
          </Card>
          <View className="gap-2">
            <Button
              isDisabled={!routine.enabled || Boolean(action.busy) || running}
              onPress={() => {
                void runNow();
              }}
            >
              {running ? "Running…" : "Run now"}
            </Button>
            {!routine.enabled ? (
              <Text variant="caption" tone="muted" className="text-center">
                Turn on Active to run it.
              </Text>
            ) : null}
          </View>
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
          <Button
            variant="danger-soft"
            isDisabled={Boolean(action.busy)}
            onPress={() =>
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
          >
            Delete routine
          </Button>
        </>
      ) : null}
    </ScrollScreen>
  );
}

/** One fact about the routine: a quiet label over its value. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-0.5">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text>{value}</Text>
    </View>
  );
}
