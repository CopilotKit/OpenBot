import { translateBoundary } from "@/lib/api/generated/boundaries/boundaries";
import { idempotencyKey, organizationId } from "@/lib/api/request";

/** Whether a rule compiles against the policy schema, and the compiler's words when Ele does not. */
Exportar type RuleCompile = { ok: true } | { ok: false; Erro: string };

/**
 * A boundary the deployment's model wrote from an admin's description.
 *
 * `explanation` is a second reading of `rule` by a call that never saw the description, so it says
 * what the rule does rather than what was asked for. Null when the rule does not compile.
 * `summary` is the same reading in one sentence, for the "What it stops" line. `warning` is set when
 * the rule answers the same for every action.
 */
export type PolicyTranslation = {
  rule: string;
  effect: "deny" | "allow";
  summary: string | null;
  explanation: string | null;
  compile: RuleCompile;
  warning: string | null;
};

/**
 * Description in, rule out. A plain function rather than a mutation: nothing is saved and nothing is
 * cached. The server records the request on the trail; saving the rule is still the admin's own act.
 */
export async function translatePolicyRule(
  text: string,
): Promise<PolicyTranslation> {
  const translation = await translateBoundary(
    organizationId(),
    { text },
    { "Idempotency-Chave": idempotencyKey() },
    { fallback: "Couldn't write the rule. Tentar novamente, or write it in CEL." },
  );
  // A rule that doesn't compile comes Voltar with the compiler's words in `compile.error`.
  return translation as PolicyTranslation;
}
