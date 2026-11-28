import { z } from "zod";
import type { TeamChange, TeamInput } from "./mutations";

/** No parent, as the form's Select holds it: a Select's value is never empty. */
export const NO_PARENT = "none";

/** The limits are the API's own (`CreateTeamRequest`), said here so the form says them first. */
export const teamFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the team a name.")
    .max(100, "Keep the name under 100 characters."),
  description: z
    .string()
    .trim()
    .max(500, "Keep the description under 500 characters."),
  parentTeamId: z.string(),
});

export type TeamFormValues = z.infer<typeof teamFormSchema>;

/** A new team as the API takes it: nothing sent for a description or a parent left empty. */
export function teamInputFrom(values: TeamFormValues): TeamInput {
  const description = values.description.trim();
  return {
    name: values.name.trim(),
    ...(description ? { description } : {}),
    ...(values.parentTeamId === NO_PARENT
      ? {}
      : { parentTeamId: values.parentTeamId }),
  };
}

/** A team's new name and description. An emptied description is cleared, which the API spells null. */
export function teamDetailsFrom(
  values: Pick<TeamFormValues, "name" | "description">,
): TeamChange {
  const description = values.description.trim();
  return { name: values.name.trim(), description: description || null };
}
