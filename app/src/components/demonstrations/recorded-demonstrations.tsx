import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { SkillFields } from "@/components/skills/skill-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  deleteDemonstrationMutationOptions,
  draftDemonstrationMutationOptions,
  publishDemonstrationMutationOptions,
  scheduleDemonstrationMutationOptions,
} from "@/lib/demonstrations/mutations";
import {
  type DemonstrationDraft,
  type DemonstrationRoutine,
  type DemonstrationSummary,
  demonstrationKeys,
  demonstrationsQueryOptions,
} from "@/lib/demonstrations/queries";
import {
  grantPlugin,
  invalidatePlugins,
  saveSkillMutationOptions,
} from "@/lib/plugins/mutations";
import { queryClient } from "@/query-client";

const SCHEDULES = [
  { label: "Every weekday at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Every Monday at 09:00", cron: "0 9 * * 1" },
  { label: "Every hour", cron: "0 * * * *" },
] as const;

/** Save the demonstrated path as a routine that reruns the published skill. */
function ScheduleSkill({
  recording,
  onDone,
}: {
  recording: DemonstrationSummary;
  onDone: () => void;
}) {
  const id = useId();
  const [cron, setCron] = useState<string>(SCHEDULES[0].cron);
  const [custom, setCustom] = useState("");
  const [channelId, setChannelId] = useState("");
  const [inputs, setInputs] = useState("");
  const [scheduled, setScheduled] = useState<DemonstrationRoutine | null>(null);
  const channels = useInfiniteQuery(channelListQueryOptions());
  const botChannels = (channels.data ?? []).filter(
    (channel) => channel.active && channel.agentIds.includes(recording.botId),
  );
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const schedule = useMutation(
    scheduleDemonstrationMutationOptions(queryClient),
  );
  if (scheduled)
    return (
      <p className="w-full text-xs">
        Scheduled. /{recording.skillSlug} next runs{" "}
        {new Date(scheduled.nextRunAt).toLocaleString()}.{" "}
        <Link to="/routines" className="underline">
          See routines
        </Link>{" "}
        <button type="button" className="underline" onClick={onDone}>
          Close
        </button>
      </p>
    );
  return (
    <form
      className="grid w-full gap-2 rounded-md border p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        schedule.mutate(
          {
            id: recording.id,
            input: {
              cron: cron === "custom" ? custom : cron,
              timezone,
              ...(channelId ? { channelId } : {}),
              ...(inputs.trim() ? { inputs } : {}),
            },
          },
          {
            onSuccess: (routine) => setScheduled(routine),
          },
        );
      }}
    >
      <label htmlFor={`${id}-when`} className="grid gap-1">
        When it runs ({timezone})
        <select
          id={`${id}-when`}
          className="h-8 rounded-md border bg-background px-2"
          value={cron}
          onChange={(event) => setCron(event.target.value)}
        >
          {SCHEDULES.map((option) => (
            <option key={option.cron} value={option.cron}>
              {option.label}
            </option>
          ))}
          <option value="custom">Custom cron expression</option>
        </select>
      </label>
      {cron === "custom" && (
        <label htmlFor={`${id}-cron`} className="grid gap-1">
          Cron (minute hour day month weekday)
          <Input
            id={`${id}-cron`}
            required
            maxLength={120}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="30 8 * * 1-5"
          />
        </label>
      )}
      <label htmlFor={`${id}-channel`} className="grid gap-1">
        Report in
        <select
          id={`${id}-channel`}
          className="h-8 rounded-md border bg-background px-2"
          value={channelId}
          onChange={(event) => setChannelId(event.target.value)}
        >
          <option value="">This Bot's only conversation</option>
          {botChannels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-inputs`} className="grid gap-1">
        Inputs for each run (optional)
        <Input
          id={`${id}-inputs`}
          maxLength={1000}
          value={inputs}
          onChange={(event) => setInputs(event.target.value)}
          placeholder="input_1: last month's invoices"
        />
      </label>
      {schedule.error && (
        <p role="alert" className="text-destructive">
          {schedule.error.message}
        </p>
      )}
      <div className="flex gap-2">
        {/* Base UI's Button defaults to type="button", which never submits the form. */}
        <Button
          size="sm"
          type="submit"
          disabled={schedule.isPending || (cron === "custom" && !custom.trim())}
        >
          Schedule
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A Bot's recorded demonstrations: draft a Skill from one, save it, schedule it, or delete it. */
export function RecordedDemonstrations({ botId }: { botId: string }) {
  const [draft, setDraft] = useState<DemonstrationDraft | null>(null);
  const [savedSlug, setSavedSlug] = useState("");
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [scheduling, setScheduling] = useState("");
  const recordings = useQuery(demonstrationsQueryOptions(botId));
  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: demonstrationKeys.bot(botId),
    });
  };
  const generate = useMutation(draftDemonstrationMutationOptions(queryClient));
  const remove = useMutation(deleteDemonstrationMutationOptions(queryClient));
  const publish = useMutation(publishDemonstrationMutationOptions(queryClient));
  const save = useMutation(saveSkillMutationOptions(queryClient));
  return (
    <>
      {(generate.error || remove.error) && (
        <p role="alert" className="text-sm text-destructive">
          {generate.error?.message || remove.error?.message}
        </p>
      )}
      {recordings.data
        ?.filter((recording) => recording.status !== "recording")
        .slice(0, 5)
        .map((recording) => (
          <div
            key={recording.id}
            className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm"
          >
            <span>
              {recording.title} · {recording.actionCount} steps
              {recording.reachedTimeLimit && (
                <span className="text-xs text-muted-foreground">
                  {" "}
                  · stopped at the ten-minute limit
                </span>
              )}
            </span>
            <div className="flex gap-2">
              {recording.status === "published" && recording.skillSlug ? (
                <>
                  <Link
                    to="/skills"
                    search={{ edit: recording.skillSlug }}
                    className="text-xs underline"
                  >
                    Edit /{recording.skillSlug}
                  </Link>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setScheduling((current) =>
                        current === recording.id ? "" : recording.id,
                      )
                    }
                  >
                    Run on a schedule
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!recording.actionCount || generate.isPending}
                  onClick={() =>
                    generate.mutate(recording.id, {
                      onSuccess: (value) => {
                        setDraft(value);
                        setSavedSlug("");
                        setSaveError(null);
                      },
                    })
                  }
                >
                  Review skill draft
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(recording.id)}
              >
                Delete
              </Button>
            </div>
            {scheduling === recording.id && (
              <ScheduleSkill
                recording={recording}
                onDone={() => setScheduling("")}
              />
            )}
          </div>
        ))}
      {draft && (
        <div className="grid gap-3 border-t pt-4">
          <h3 className="font-semibold">Review and edit the skill</h3>
          <p className="text-xs text-muted-foreground">
            Replace parameter names and clarify the expected outcome. Saving
            uses the same skill permissions as Skills.
          </p>
          <SkillFields
            key={draft.sourceRecordingId}
            defaultValues={draft}
            submitLabel="Save and use with this Bot"
            error={saveError || save.error}
            onCancel={() => setDraft(null)}
            onSubmit={async (values) => {
              setSaveError(null);
              try {
                await save.mutateAsync(values);
                await grantPlugin({
                  kind: "skill",
                  ref: values.slug,
                  agentId: botId,
                });
                await publish.mutateAsync({
                  id: draft.sourceRecordingId,
                  slug: values.slug,
                });
                await invalidatePlugins(queryClient);
                await refresh();
                setSavedSlug(values.slug);
                setDraft(null);
              } catch (error) {
                setSaveError(
                  error instanceof Error
                    ? error
                    : new Error("The skill could not be saved."),
                );
                await refresh();
              }
            }}
          />
        </div>
      )}
      {savedSlug && (
        <p className="text-sm">
          /{savedSlug} is ready on this Bot. Invoke it in the conversation with
          the inputs you want to use, or choose Run on a schedule to rerun it as
          a routine.
        </p>
      )}
    </>
  );
}
