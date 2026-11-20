import { z } from "zod";
import type { AgentProfile } from "./queries";

/**
 * Browser-side coworker form contract. Limits match the server parser so validation errors can be
 * shown next to fields before submit.
 */
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(80, "Name must be 80 characters or fewer."),
  title: z.string().trim().max(120, "Title must be 120 characters or fewer."),
  roleDescription: z
    .string()
    .trim()
    .min(1, "A description of what it does is required.")
    .max(1000, "What it does must be 1000 characters or fewer."),
  visibility: z.enum(["public", "private"]),
  /**
   * The AG-UI endpoint this coworker runs on. Empty means the Bot in the box.
   *
   * Only URL shape is checked here; deployment allow/deny rules are server-side.
   */
  endpoint: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      "Enter a web address starting with http:// or https://.",
    ),
  /**
   * A key the agent sits behind. WRITE-ONLY: it is never sent back from the server, so this field is
   * always empty when editing, and leaving it empty keeps whatever key is already set.
   */
  authValue: z.string(),
  /**
   * A computer of its own. Optional because only the New Bot sheet and the Setup row ask it: every
   * other form leaves it out, and the server reads absent as "leave it as it is".
   */
  isolated: z.boolean().optional(),
  /**
   * The starter Bot's instructions, which only its Setup page sends. Absent leaves them as they are.
   */
  instructions: z
    .string()
    .trim()
    .min(1, "Instructions are required.")
    .max(1000, "Instructions must be 1000 characters or fewer.")
    .optional(),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

export const emptyAgentForm: AgentFormValues = {
  name: "",
  title: "",
  roleDescription: "",
  visibility: "private",
  endpoint: "",
  authValue: "",
};

/** Convert form values to API input; omit an empty key so editing preserves the current credential. */
export function agentInputFrom(values: AgentFormValues) {
  return {
    name: values.name,
    title: values.title,
    roleDescription: values.roleDescription,
    visibility: values.visibility,
    endpoint: values.endpoint,
    ...(values.authValue.trim()
      ? { auth: { header: "Authorization", value: values.authValue.trim() } }
      : {}),
    ...(values.isolated === undefined ? {} : { isolated: values.isolated }),
    ...(values.instructions === undefined
      ? {}
      : { instructions: values.instructions }),
  };
}

/**
 * The full update body for changing one or two fields of a Bot.
 *
 * The update endpoint takes the whole profile, so unchanged text fields ride along as stored. Not
 * the endpoint, which is sent only when the patch changes it. The route checks any endpoint it is
 * sent as one somebody typed, against the deployment's rules as they are today: a built-in Bot's
 * address is the managed Bot's own, on localhost on some deployments, and a Bot saved at an address
 * the rules have since closed would both have refused every rename. Empty leaves the stored one
 * where it is, and the empty key keeps the current one.
 */
export function profileUpdateInput(
  profile: AgentProfile,
  patch: Partial<AgentFormValues>,
) {
  return agentInputFrom({
    name: profile.name,
    title: profile.title,
    roleDescription: profile.roleDescription,
    visibility: profile.visibility,
    endpoint: "",
    authValue: "",
    ...patch,
  });
}

/**
 * The Setup dialog's Agent URL: the form's own check, and not empty, because an empty endpoint on a
 * change leaves the stored one as it is, so saving one would look done and change nothing.
 */
export const agentEndpointSchema = agentFormSchema.shape.endpoint.refine(
  (value) => value !== "",
  "Enter a web address starting with http:// or https://.",
);
