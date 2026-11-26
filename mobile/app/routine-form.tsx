import DateTimePicker from "@expo/ui/community/datetime-picker";
import Picker from "@expo/ui/community/picker";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextArea } from "heroui-native/text-area";
import { TextField } from "heroui-native/text-field";
import { useCallback, useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { useUniwind } from "uniwind";
import { everyBot, everyPage, ORGANIZATION_ID } from "../src/api";
import { createConversation } from "../src/api/generated/conversations/conversations";
import {
  createRoutine,
  listRoutines,
  updateRoutine,
} from "../src/api/generated/routines/routines";
import { authClient } from "../src/auth";
import {
  BotOrb,
  ChoiceList,
  Notice,
  Row,
  Rows,
  Screen,
  ScrollScreen,
  SheetTitle,
  Text,
} from "../src/components";
import {
  clockTime,
  cronFrom,
  DEFAULT_SCHEDULE,
  dateAt,
  MONTH_DAYS,
  phoneTimeZone,
  REPEAT_LABEL,
  REPEATS,
  type Repeat,
  type Schedule,
  scheduleFrom,
  scheduleSentence,
  timeOf,
  WEEKDAY_LABEL,
} from "../src/routine-schedule";
import { useLoad } from "../src/use-load";

/** A time zone as a person says it: "America/Los_Angeles" as "Los Angeles". */
const zoneName = (zone: string) =>
  (zone.split("/").pop() ?? zone).replace(/_/g, " ");

/**
 * New routine, or Edit routine with a `routineId`: which Bot does it, what it does, and when, with
 * the web app's schedule choices (src/routine-schedule.ts). A new routine reports in the person's
 * conversation with its Bot. Its time is the phone's own time zone.
 */
export default function RoutineForm() {
  const { routineId, botId: askedBot } = useLocalSearchParams<{
    routineId?: string;
    botId?: string;
  }>();
  const editing = Boolean(routineId);
  const { data: session } = authClient.useSession();
  const { theme } = useUniwind();
  const loadBots = useCallback(() => everyBot(), []);
  const bots = useLoad(loadBots, Boolean(session));
  const loadRoutines = useCallback(
    () =>
      everyPage(
        (page) => listRoutines(ORGANIZATION_ID, page),
        (page) => page.routines,
      ),
    [],
  );
  const routines = useLoad(loadRoutines, Boolean(session) && editing);
  const routine = routines.data?.find((item) => item.id === routineId);
  const [botId, setBotId] = useState(askedBot ?? "");
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [schedule, setSchedule] = useState<Schedule>(DEFAULT_SCHEDULE);
  // A routine whose schedule the form can't say keeps it, until the person picks one here.
  const [keepsSchedule, setKeepsSchedule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickingTime, setPickingTime] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!routine || loaded) return;
    setLoaded(true);
    setBotId(routine.botId);
    setTitle(routine.title ?? "");
    setInstruction(routine.instruction);
    const picked = scheduleFrom(routine.cron);
    if (picked) setSchedule(picked);
    else setKeepsSchedule(true);
  }, [routine, loaded]);
  const listed = (bots.data ?? []).filter((bot) => !bot.hidden);
  useEffect(() => {
    if (!editing && !botId && listed[0]) setBotId(listed[0].id);
  }, [editing, botId, listed]);
  const pick = (change: Partial<Schedule>) => {
    setKeepsSchedule(false);
    setSchedule((now) => ({ ...now, ...change }));
  };
  const ready = Boolean(botId && instruction.trim()) && !busy;

  async function save() {
    setBusy(true);
    setError("");
    try {
      const cron = cronFrom(schedule);
      if (editing && routine) {
        await updateRoutine(ORGANIZATION_ID, routine.id, {
          title: title.trim(),
          instruction: instruction.trim(),
          ...(keepsSchedule ? {} : { cron, timezone: phoneTimeZone() }),
        });
      } else {
        // It reports in the person's conversation with its Bot: the API hands back the one they have, or starts one.
        const { conversation } = await createConversation(ORGANIZATION_ID, {
          botIds: [botId],
        });
        await createRoutine(ORGANIZATION_ID, {
          botId,
          conversationId: conversation.id,
          instruction: instruction.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          cron,
          timezone: phoneTimeZone(),
        });
      }
      router.back();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save the routine. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen fade={false}>
      <SheetTitle title={editing ? "Edit routine" : "New routine"} />
      <ScrollScreen className="gap-5" fade={false}>
        <Notice message={error || bots.error || routines.error} />
        {editing ? null : (
          <View className="gap-2">
            <Label>Who does it</Label>
            <ChoiceList
              label="The Bot that does it"
              value={botId}
              onChange={setBotId}
              options={listed.map((bot) => ({
                value: bot.id,
                label: bot.name,
              }))}
            />
          </View>
        )}
        {editing && routine ? (
          <View className="flex-row items-center gap-2 px-1">
            <BotOrb
              seed={
                bots.data?.find((bot) => bot.id === routine.botId)
                  ?.avatarSeed || routine.botId
              }
              name="Bot"
              size={20}
            />
            <Text tone="muted" className="text-sm">
              {routine.conversation?.name
                ? `Reports in ${routine.conversation.name}`
                : "Reports in its chat"}
            </Text>
          </View>
        ) : null}
        <TextField isRequired>
          <Label>What it does</Label>
          <TextArea
            placeholder="Sum up what changed in our competitors' pricing this week."
            value={instruction}
            onChangeText={setInstruction}
          />
        </TextField>
        <TextField>
          <Label>Name</Label>
          <Input
            placeholder="Weekly pricing check"
            value={title}
            onChangeText={setTitle}
          />
        </TextField>
        <View className="gap-2">
          <Label>When</Label>
          <ChoiceList
            label="How often it runs"
            value={schedule.repeat}
            onChange={(repeat: Repeat) => pick({ repeat })}
            options={REPEATS.map((repeat) => ({
              value: repeat,
              label: REPEAT_LABEL[repeat],
            }))}
          />
          {schedule.repeat === "weekly" ? (
            <Picker
              selectedValue={schedule.weekday}
              onValueChange={(weekday) => pick({ weekday: Number(weekday) })}
            >
              {WEEKDAY_LABEL.map((label, index) => (
                <Picker.Item key={label} label={label} value={index} />
              ))}
            </Picker>
          ) : null}
          {schedule.repeat === "monthly" ? (
            <Picker
              selectedValue={schedule.monthDay}
              onValueChange={(monthDay) => pick({ monthDay: Number(monthDay) })}
            >
              {MONTH_DAYS.map((day) => (
                <Picker.Item key={day} label={`Day ${day}`} value={day} />
              ))}
            </Picker>
          ) : null}
          {schedule.repeat === "hourly" ? null : Platform.OS === "ios" ? (
            <View className="flex-row items-center justify-between px-1">
              <Text>At</Text>
              <DateTimePicker
                mode="time"
                value={dateAt(schedule.time)}
                display="compact"
                themeVariant={theme === "dark" ? "dark" : "light"}
                onValueChange={(_, date) => pick({ time: timeOf(date) })}
              />
            </View>
          ) : (
            // Android's time picker is Material's clock dialog: a row opens it, as the system's settings do.
            <Rows>
              <Row
                title="At"
                trailing={<Text tone="muted">{clockTime(schedule.time)}</Text>}
                onPress={() => setPickingTime(true)}
              />
            </Rows>
          )}
          {pickingTime && Platform.OS === "android" ? (
            <DateTimePicker
              mode="time"
              value={dateAt(schedule.time)}
              onChange={(event, date) => {
                setPickingTime(false);
                if (event.type === "set" && date) pick({ time: timeOf(date) });
              }}
            />
          ) : null}
          <Text tone="muted" className="px-1 text-sm">
            {keepsSchedule && routine
              ? `${routine.schedule}. Pick a new schedule to change it.`
              : `${scheduleSentence(schedule)}, ${zoneName(phoneTimeZone())} time.`}
          </Text>
        </View>
        <Button isDisabled={!ready} onPress={() => void save()}>
          {editing ? "Save" : "Create routine"}
        </Button>
      </ScrollScreen>
    </Screen>
  );
}
