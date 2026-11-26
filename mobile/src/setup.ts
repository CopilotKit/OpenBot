/**
 * Finishing setting up on the phone: what a signed-in person still has to do before OpenBot Mobile works for them,
 * decided as the web app decides it (app/src/routes/_authed.tsx), from the server's own verdicts and never from a
 * version.
 *
 * 1. The terms (getServiceTerms): the server says `acceptanceNeeded`.
 * 2. Onboarding (getPerson): the person's `onboarding` is tracked and not finished.
 * 3. Their AI (getPersonalAiConnection): the server requires one (OpenBot Cloud) and their runs have none.
 *
 * It imports nothing from the phone, so the decisions are tested without one (tests/setup.test.ts).
 */
import type {
  AiConnectionInput,
  AiConnectionLogin,
  AiConnectionProvider,
  Person,
  PersonalAiConnection,
  ServiceTerms,
} from "./api/generated/model";

/** What one question to the server came back with. */
export type Answer<T> =
  | { kind: "answered"; value: T }
  /** An OpenBot older than the question: the operation isn't there. Read as nothing to do. */
  | { kind: "missing" }
  /**
   * The question failed. `status` is the server's refusal, when it answered one; with none, it never reached the
   * server (no network) or the phone couldn't ask yet (no organization to ask in).
   */
  | { kind: "failed"; message: string; status?: number };

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Whether a refusal is an OpenBot older than the operation: the address isn't served (404 with the API's plain
 * NOT_FOUND, or with no code at all), or the method isn't (405, 501). Any other 404 is about this request, such as
 * the person or the organization it names, and fails like any other refusal.
 */
export function missingOperation(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 405 || status === 501) return true;
  if (status !== 404) return false;
  const code = codeOf(error);
  return code === undefined || code === "NOT_FOUND";
}

/** Ask one question, and read its failure as an answer. */
export async function ask<T>(question: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { kind: "answered", value: await question() };
  } catch (error) {
    if (missingOperation(error)) return { kind: "missing" };
    const status = statusOf(error);
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
      ...(status === undefined ? {} : { status }),
    };
  }
}

/** The three answers the gate decides from. */
export type SetupFacts = {
  terms: Answer<ServiceTerms>;
  person: Answer<Person>;
  ai: Answer<PersonalAiConnection>;
};

/** How the gate asks each question. Stood in for in the tests. */
export type SetupQuestions = {
  terms: () => Promise<ServiceTerms>;
  person: () => Promise<Person>;
  ai: () => Promise<PersonalAiConnection>;
};

/** Ask all three at once. Never throws: each failure is an answer of its own. */
export async function askSetupFacts(
  questions: SetupQuestions,
): Promise<SetupFacts> {
  const [terms, person, ai] = await Promise.all([
    ask(questions.terms),
    ask(questions.person),
    ask(questions.ai),
  ]);
  return { terms, person, ai };
}

/** Whether onboarding is tracked for this person and not finished. Null `onboarding` is nothing to finish. */
export function needsOnboarding(person: Pick<Person, "onboarding">): boolean {
  const onboarding = person.onboarding;
  return (
    onboarding !== null &&
    onboarding !== undefined &&
    onboarding.completedAt === null
  );
}

/** Whether the person has to connect an AI before Bots work for them: the server's two verdicts, never recomputed. */
export function needsAiConnection(
  personal: Pick<PersonalAiConnection, "required" | "uses"> | null | undefined,
): boolean {
  return personal?.required === true && personal.uses === "none";
}

/** A step of finishing setting up, in the order the person meets them. */
export type SetupStep = "terms" | "onboarding" | "ai";

/**
 * The step the person has to take next, or null when the app is theirs to use.
 *
 * - Terms come first. A refusal the server answered reads as terms to agree to, as on the web: letting somebody in
 *   because the question failed would let them use OpenBot Cloud without agreeing, so the terms step says it failed
 *   and offers Try again. A question that never reached the server (no network) blocks nothing: the app's screens say
 *   that themselves, and the gate asks again.
 * - Onboarding next, and the person's own record decides it. Unanswered, nothing is blocked.
 * - Then the AI, for somebody who finished onboarding before that step existed, or whose organization's AI went away.
 *   Unanswered, it isn't required: only OpenBot Cloud requires one, and it answers.
 */
export function nextSetupStep(facts: SetupFacts): SetupStep | null {
  const { terms, person, ai } = facts;
  if (terms.kind === "answered" && terms.value.acceptanceNeeded === true)
    return "terms";
  if (terms.kind === "failed" && terms.status !== undefined) return "terms";
  if (person.kind === "answered" && needsOnboarding(person.value))
    return "onboarding";
  if (ai.kind === "answered" && needsAiConnection(ai.value)) return "ai";
  return null;
}

/**
 * Each onboarding step by id, with the number the server keeps for it (advanceOnboarding). The web app's numbers
 * (app/src/routes/_authed/onboarding.tsx), so a person who starts on one and goes on on the other is where they left
 * off. `selfhost` is OpenBot for Business, shown only to somebody trying OpenBot on their own computer, never here.
 */
export const STEP_NUMBER = { welcome: 1, selfhost: 2, name: 3, ai: 4 } as const;
type AnyStepId = keyof typeof STEP_NUMBER;
const ORDER: readonly AnyStepId[] = ["welcome", "ai", "selfhost", "name"];

/** The onboarding steps the phone shows. */
export type OnboardingStepId = "welcome" | "ai" | "name";

/** Whether the person already has a real name: one they or their sign-in gave, and not only their address. */
export function nameKnown(
  person: Pick<Person, "name" | "email" | "needsName">,
): boolean {
  const name = person.name?.trim();
  return person.needsName !== true && Boolean(name) && name !== person.email;
}

/**
 * The onboarding steps this person has, decided once when they arrive. Somebody who finished onboarding and only has
 * an AI to connect has that one step. Otherwise Welcome, then Connect your AI where one is needed, then their name
 * where it isn't known.
 */
export function onboardingSteps(
  person: Pick<Person, "onboarding" | "name" | "email" | "needsName"> | null,
  personal: Pick<PersonalAiConnection, "required" | "uses"> | null,
): OnboardingStepId[] {
  const aiNeeded = needsAiConnection(personal);
  if (!person || !needsOnboarding(person)) return aiNeeded ? ["ai"] : [];
  return [
    "welcome",
    ...(aiNeeded ? (["ai"] as const) : []),
    ...(nameKnown(person) ? [] : (["name"] as const)),
  ];
}

function stepForNumber(step: number | undefined): AnyStepId | null {
  const found = Object.entries(STEP_NUMBER).find(([, at]) => at === step);
  return found ? (found[0] as AnyStepId) : null;
}

/**
 * Where the person picks up: the step the server kept for them, else the first. A kept step they don't have (OpenBot
 * for Business, a name now known, an AI now connected) reads as the next one they have, or the last. Nothing after
 * Connect your AI is reachable until an AI is connected.
 */
export function resumeStep(
  ids: readonly OnboardingStepId[],
  savedStep: number | undefined,
  aiConnected: boolean,
): OnboardingStepId | undefined {
  const saved = stepForNumber(savedStep);
  if (!saved) return ids[0];
  const found = (ids as readonly AnyStepId[]).includes(saved)
    ? (saved as OnboardingStepId)
    : (ids.find((id) => ORDER.indexOf(id) > ORDER.indexOf(saved)) ??
      ids[ids.length - 1]);
  if (
    found &&
    ids.includes("ai") &&
    !aiConnected &&
    ids.indexOf(found) > ids.indexOf("ai")
  )
    return "ai";
  return found;
}

/**
 * Who connects the AI here, by the web app's rules. Where a person can have their own (OpenBot Cloud, `available`),
 * everybody connects their own, admins included. Elsewhere the organization's AI is the only one: an admin connects
 * it for everyone (`editable`), and anybody else asks an admin.
 */
export type AiConnectMode = "personal" | "organization" | "ask-admin";

export function aiConnectMode(
  personal: Pick<PersonalAiConnection, "available"> | null,
  organizationEditable: boolean,
): AiConnectMode {
  if (personal?.available === true) return "personal";
  return organizationEditable ? "organization" : "ask-admin";
}

/** A provider the phone connects with a key, the web app's words for it (app/src/lib/ai-connection/providers.ts). */
export type PhoneProvider = {
  id: AiConnectionProvider;
  name: string;
  summary: string;
  login: Extract<AiConnectionLogin, "api-key" | "endpoint">;
  /** The address, model and key page a named provider's endpoint fills in. The person types only the key. */
  preset?: { baseUrl: string; model: string; keyUrl: string; keyLink: string };
};

/**
 * The providers, in the setup window's order, each with its key or address way in. A sign-in (a ChatGPT or Claude
 * plan, a Google, xAI or Unbiased AI account) runs in the browser and comes back to OpenBot on a computer: the API
 * has no way back to the phone, so those are connected there.
 */
export const PHONE_PROVIDERS: readonly PhoneProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    summary: "Use an OpenAI API key.",
    login: "api-key",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    summary: "Use an Anthropic API key.",
    login: "api-key",
  },
  {
    id: "google",
    name: "Google Gemini",
    summary: "Use a Google AI Studio key for the Gemini API.",
    login: "endpoint",
    preset: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-3.8-flash",
      keyUrl: "https://aistudio.google.com/apikey",
      keyLink: "Get a Google Gemini API key",
    },
  },
  {
    id: "xai",
    name: "xAI",
    summary: "Use an xAI API key.",
    login: "endpoint",
    preset: {
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.7",
      keyUrl: "https://console.x.ai/",
      keyLink: "Get an xAI API key",
    },
  },
  {
    id: "unbiased",
    name: "Unbiased AI",
    summary: "Use an Unbiased AI API key for Pareto.",
    login: "endpoint",
    preset: {
      baseUrl: "https://api.unbiased.ai/v1",
      model: "pareto",
      keyUrl: "https://platform.unbiased.ai/dashboard/keys",
      keyLink: "Get an Unbiased AI API key",
    },
  },
  {
    id: "trustedrouter",
    name: "TrustedRouter",
    summary: "Use a TrustedRouter API key for models from many providers.",
    login: "endpoint",
    preset: {
      baseUrl: "https://api.trustedrouter.com/v1",
      model: "anthropic/claude-sonnet-5.5",
      keyUrl: "https://trustedrouter.com/console/api-keys",
      keyLink: "Get a TrustedRouter API key",
    },
  },
  {
    id: "openai-compatible",
    name: "Any OpenAI-compatible endpoint",
    summary: "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.",
    login: "endpoint",
  },
];

/** A provider's name, by its id. One this app doesn't know is shown by its id (the list grows). */
export function providerName(id: string | null | undefined): string {
  return PHONE_PROVIDERS.find((one) => one.id === id)?.name ?? id ?? "Your AI";
}

/** The spec's pattern for an endpoint's address: http or https, with nothing in it that signs in. */
const ENDPOINT_ADDRESS = /^https?:\/\/[^@/?#]+([/?#].*)?$/;

export function isEndpointAddress(address: string): boolean {
  return ENDPOINT_ADDRESS.test(address.trim());
}

/** What the person typed on the form. */
export type KeyForm = { apiKey: string; baseUrl: string; model: string };

/**
 * The request a filled form sends, or null while it is missing something. A key for every provider with a key page,
 * an address and a model for an endpoint of the person's own, where the key is theirs to leave out.
 */
export function connectionInput(
  provider: PhoneProvider,
  form: KeyForm,
): AiConnectionInput | null {
  const apiKey = form.apiKey.trim();
  if (provider.login === "api-key")
    return apiKey ? { provider: provider.id, login: "api-key", apiKey } : null;
  const model = form.model.trim() || provider.preset?.model || "";
  const baseUrl = provider.preset?.baseUrl ?? form.baseUrl.trim();
  if (!model || !isEndpointAddress(baseUrl)) return null;
  if (provider.preset && !apiKey) return null;
  return {
    provider: provider.id,
    login: "endpoint",
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
  };
}

/**
 * What the server says, word for word, when a run has no AI: on OpenBot Cloud, the person has none of their own and
 * their organization none for everyone (NO_PERSONAL_AI_CONNECTION); elsewhere, the organization has none
 * (NO_AI_CONNECTION). The web app reads the same sentences (app/src/components/channels/add-model-key-link.tsx).
 */
export const NO_PERSONAL_AI_CONNECTION =
  "Connect your AI to use Bots. An admin can also set one up for everyone in your organization.";
export const NO_AI_CONNECTION =
  "This organization doesn't have an AI connection yet. An admin can add a model key in Admin, under Vault.";

/** Where the phone connects an AI from anywhere in the app: app/setup/ai.tsx. */
export const CONNECT_YOUR_AI_ROUTE = "/setup/ai";

/**
 * For a conversation whose run failed: where to send the person to fix it, when the failure is that no AI is
 * connected, else null. The screen there decides who connects what (`aiConnectMode`), so a member of an organization
 * whose admin sets the AI is told to ask them. Link it as a "Connect your AI" button beside the failure.
 */
export function connectAiRouteFor(
  reason: string | null | undefined,
): typeof CONNECT_YOUR_AI_ROUTE | null {
  const said = reason?.trim();
  return said === NO_PERSONAL_AI_CONNECTION || said === NO_AI_CONNECTION
    ? CONNECT_YOUR_AI_ROUTE
    : null;
}
