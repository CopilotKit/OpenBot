import type { ProactiveSetting } from "@/lib/proactive";
import { type RoutineFormValues, routineFormSchema } from "./form";
import { checkInSubject } from "./plan";

/** A field of New routine's answers. */
export type RuleField = keyof RoutineFormValues;

/** One message per field: the first rule its answer breaks. */
export type RuleMessages = Partial<Record<RuleField, string>>;

/** What Name says when an Only tell you would land on a check-in the Bot already has. */
export const SAME_CHECK_IN =
  "This Bot already checks in on this. Give this one a different name, or change that one on its row.";

/**
 * Whether an Only tell you called `title` (`checkInSubject`: its Name, else its instruction) is a
 * check-in this Bot already has. The server counts a check-in with no link and the same subject, in
 * any case, as the same one. Asked for a new one, as this screen asks, it refuses that with 409 and
 * this sentence (`refuseExisting` in `proactiveStore.create`); this check says it while Name is typed.
 */
function sameCheckIn(
  settings: ProactiveSetting[] | undefined,
  agentId: string,
  title: string,
): boolean {
  const subject = title.trim().toLowerCase();
  return (settings ?? []).some(
    (setting) =>
      setting.botId === agentId &&
      !setting.sourceLink &&
      (setting.subject ?? "").toLowerCase() === subject,
  );
}

/** What It should says when Only tell you was picked and an admin then turned check-ins off. */
export const TELL_OFF =
  "An admin turned check-ins off, so it can't only tell you. Choose Act for you to go on.";

/**
 * What the answers break now, field by field. The schema holds every rule about the answers alone,
 * its own fields' and the ones that read other answers (`crossFieldIssues`); the two below also read
 * what the server said: whether an admin allows check-ins, and the check-ins the Bot already has.
 */
export function brokenRules(
  values: RoutineFormValues,
  allowed: boolean,
  checkIns: ProactiveSetting[] | undefined,
): RuleMessages {
  const messages: RuleMessages = {};
  const add = (name: RuleField, message: string) => {
    messages[name] ??= message;
  };
  const parsed = routineFormSchema.safeParse(values);
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      add(issue.path[0] as RuleField, issue.message);
  if (values.does === "tell" && !allowed) add("does", TELL_OFF);
  // Only a check-in can clash: not acting, and not a tell held because check-ins are off.
  else if (
    values.does === "tell" &&
    sameCheckIn(checkIns, values.agentId, checkInSubject(values))
  )
    add("title", SAME_CHECK_IN);
  return messages;
}
