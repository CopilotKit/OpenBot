import { z } from "zod";
import type { SlugResolution, TemplatePlan } from "./queries";
import type { TemplateInstallInput } from "./mutations";

/**
 * The browser side of the consent screen.
 *
 * Deliberately thin. Every refusal that matters is the server's and is re-run at install, so
 * anything checked here is checked twice and nothing is checked only here — a template that this
 * schema would accept and the parser would not is refused with the parser's own sentence, which is
 * the one written for a person. What this file is for is the two fields the *importer* supplies,
 * which no template can carry and which therefore have no server-side draft to have been validated
 * already: the address the coworker runs at, and the key it sits behind.
 */
export const templateImportFormSchema = z.object({
  /** The file, exactly as it was pasted or dropped. Never edited on its way to the server. */
  source: z.string().min(1, "Paste a template file."),
  /**
   * Where this coworker runs.
   *
   * Only URL shape is checked here. Whether this deployment will dial that host is
   * `checkAgentEndpoint`'s answer and nobody else's, and it is given again on every run and every
   * redirect hop — a browser-side allowlist would be a second, weaker copy of that rule.
   *
   * Required or not is the plan's answer rather than the schema's: the same file needs an address
   * on a one-container deployment and needs none on a deployment that runs a managed Bot.
   */
  endpoint: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      "Enter a web address starting with http:// or https://.",
    ),
  /**
   * The key the endpoint sits behind. WRITE-ONLY, and it never came from the template — the format
   * has no field that could hold one, and the header NAME is the whole of what travelled.
   */
  authValue: z.string(),
  /**
   * What to do about each skill slug this deployment already has.
   *
   * Keyed by the slug in the file. The server defaults every one of them and re-decides on its own
   * transaction, so an absent key is a decision deferred rather than a decision skipped. Overwrite
   * is not in the vocabulary: taking somebody's `/` command is not one of the outcomes.
   */
  slugDecisions: z.record(
    z.string(),
    z.enum(["reuse", "suffix", "skip"] satisfies SlugResolution[]),
  ),
});

export type TemplateImportFormValues = z.infer<typeof templateImportFormSchema>;

export const emptyTemplateImportForm: TemplateImportFormValues = {
  source: "",
  endpoint: "",
  authValue: "",
  slugDecisions: {},
};

/**
 * Form values to what the install route accepts.
 *
 * The digest travels with the text, because the server recomputes it and refuses if it moved: what
 * installs has to be what was read. An empty endpoint and an empty key are omitted rather than sent
 * blank — a blank address on a managed Bot is not the same request as no address at all.
 */
export function templateInstallInputFrom(
  values: TemplateImportFormValues,
  plan: TemplatePlan,
  origin: { from: TemplateInstallInput["from"]; sourceRef?: string },
): TemplateInstallInput {
  const endpoint = values.endpoint.trim();
  const key = values.authValue.trim();
  return {
    source: values.source,
    digest: plan.digest,
    ...(origin.from ? { from: origin.from } : {}),
    ...(origin.sourceRef ? { sourceRef: origin.sourceRef } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(key
      ? {
          auth: {
            header: plan.endpoint.authHeader ?? "Authorization",
            value: key,
          },
        }
      : {}),
    slugDecisions: values.slugDecisions,
  };
}
