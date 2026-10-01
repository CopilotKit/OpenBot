import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Alert, Button, Switch, Text, View } from "react-native";
import { api, type Routine, type RoutineRun } from "../src/api";
import { authClient } from "../src/auth";
import { RUN_COLORS, RUN_LABELS, when } from "../src/routines";
import {
  card,
  colors,
  heading,
  muted,
  Problem,
  Screen,
  Section,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

/** One routine: Active, schedule, next run, instruction, Run now, and its run history. */
export default function RoutineScreen() {
  const { routineId = "" } = useLocalSearchParams<{ routineId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const loadRoutines = useCallback(
    () => api<{ routines: Routine[] }>("/api/routines"),
    [],
  );
  const routines = useLoad(loadRoutines, Boolean(session));
  const loadRuns = useCallback(
    () =>
      api<{ runs: RoutineRun[] }>(
        `/api/routines/${encodeURIComponent(routineId)}/runs`,
      ),
    [routineId],
  );
  const runs = useLoad(loadRuns, Boolean(session && routineId));
  if (!session && !isPending) return <Redirect href="/" />;
  const routine = routines.data?.routines.find((item) => item.id === routineId);
  const running = runs.data?.runs.some((run) => run.status === "running");

  async function setActive(enabled: boolean) {
    await action.run("active", async () => {
      await api(`/api/routines/${encodeURIComponent(routineId)}/enabled`, {
        method: "PUT",
        body: { enabled },
      });
      await routines.refresh();
    });
  }
  async function runNow() {
    await action.run("run", async () => {
      await api(`/api/routines/${encodeURIComponent(routineId)}/run`, {
        method: "POST",
      });
      await runs.refresh();
    });
  }
  async function remove() {
    const removed = await action.run("delete", () =>
      api(`/api/routines/${encodeURIComponent(routineId)}`, {
        method: "DELETE",
      }),
    );
    if (removed) router.back();
  }

  return (
    <Screen
      refreshing={routines.pending || runs.pending}
      onRefresh={() => {
        void routines.refresh();
        void runs.refresh();
      }}
    >
      <Text style={heading}>Routine</Text>
      <Problem message={action.error || routines.error || runs.error} />
      {routines.data && !routine && <Text>This routine no longer exists.</Text>}
      {routine && (
        <>
          <View
            style={[
              card,
              {
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              },
            ]}
          >
            <Text style={{ fontWeight: "600" }}>Active</Text>
            <Switch
              accessibilityLabel="Active"
              value={routine.enabled}
              disabled={Boolean(action.busy)}
              onValueChange={(enabled) => {
                void setActive(enabled);
              }}
            />
          </View>
          <View style={card}>
            <Text style={muted}>Schedule</Text>
            <Text>
              {routine.schedule} ({routine.timezone})
            </Text>
            <Text style={muted}>Next run</Text>
            <Text>{routine.enabled ? when(routine.nextRunAt) : "Paused"}</Text>
            <Text style={muted}>Instruction</Text>
            <Text>{routine.instruction}</Text>
            <Text style={muted}>Reports in</Text>
            <Text>
              {routine.channel.gone
                ? "A deleted conversation. Change it from chat."
                : (routine.channel.name ?? "A conversation")}
            </Text>
          </View>
          <Button
            title={running ? "Running…" : "Run now"}
            disabled={!routine.enabled || Boolean(action.busy) || running}
            onPress={() => {
              void runNow();
            }}
          />
          {!routine.enabled && (
            <Text style={muted}>Turn on Active to run it.</Text>
          )}
          <Section title="Run history">
            {runs.data?.runs.length === 0 && (
              <Text style={muted}>No runs yet</Text>
            )}
            {runs.data?.runs.map((run) => (
              <View key={run.id} style={card}>
                <Text
                  style={{ fontWeight: "600", color: RUN_COLORS[run.status] }}
                >
                  {RUN_LABELS[run.status]}
                </Text>
                <Text style={muted}>
                  Started {when(run.startedAt)}
                  {run.finishedAt ? ` · finished ${when(run.finishedAt)}` : ""}
                </Text>
                {run.error ? (
                  <Text style={{ color: colors.error }}>{run.error}</Text>
                ) : null}
              </View>
            ))}
          </Section>
          <Button
            title="Delete routine"
            color={colors.error}
            disabled={Boolean(action.busy)}
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
          />
        </>
      )}
    </Screen>
  );
}
