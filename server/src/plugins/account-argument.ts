/**
 * The optional `account` argument a brokered app's tools take, so a Bot can pick which of a
 * person's accounts at the app a call runs in.
 *
 * A NAME AND NEVER AN ID. The model is told the person's accounts by the address or login the
 * vendor reported for each, and it answers with one of those. The call path looks the name up among
 * the accounts of the person in the session, so the most a model can do with this argument is pick
 * between that person's own accounts. Anything it does not find is refused.
 *
 * OURS ONLY WHERE THE APP'S OWN SCHEMA DOES NOT ALREADY USE THE NAME. An action whose own parameters
 * include `account` keeps it: the argument goes to the vendor untouched and the call runs in the
 * person's default account. {@link accountArgumentFor} is the one test both halves ask, so the tool
 * a model is offered and the call path cannot disagree about whose `account` it is.
 */
export const ACCOUNT_ARG = "account";

/** Whether this action's schema leaves `account` free for the account choice. */
export function accountArgumentFor(
  inputSchema: Record<string, unknown> | null | undefined,
): typeof ACCOUNT_ARG | null {
  const properties = inputSchema?.properties;
  if (
    properties &&
    typeof properties === "object" &&
    Object.hasOwn(properties, ACCOUNT_ARG)
  )
    return null;
  return ACCOUNT_ARG;
}

/** One of a person's accounts at an app, as a model is told about it. */
export type AccountChoice = { label: string; isDefault: boolean };

/**
 * The action's schema with the `account` argument added, naming the person's accounts.
 *
 * Only where there is a choice to make: with one account, or none recorded, the schema is the
 * app's own and the call runs where it always did.
 */
export function withAccountArgument(
  inputSchema: Record<string, unknown>,
  appTitle: string,
  choices: readonly AccountChoice[],
): Record<string, unknown> {
  if (choices.length < 2 || accountArgumentFor(inputSchema) === null)
    return inputSchema;
  const fallback = choices.find((choice) => choice.isDefault) ?? choices[0];
  const properties =
    inputSchema.properties && typeof inputSchema.properties === "object"
      ? (inputSchema.properties as Record<string, unknown>)
      : {};
  return {
    ...inputSchema,
    type: "object",
    properties: {
      ...properties,
      [ACCOUNT_ARG]: {
        type: "string",
        enum: choices.map((choice) => choice.label),
        description: `Which of the person's ${appTitle} accounts to use: ${choices
          .map((choice) =>
            choice.isDefault ? `${choice.label} (default)` : choice.label,
          )
          .join(
            ", ",
          )}. Pick the one the request is about, for example their work or personal account. Leave it out to use ${fallback?.label}.`,
      },
    },
  };
}
