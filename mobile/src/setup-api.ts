/**
 * The requests finishing setting up makes (src/setup.ts decides from their answers). Every one is the generated
 * client's, in the organization the person works in, as the person (`me`).
 */
import { ME, ORGANIZATION_ID } from "./api";
import type {
  AiConnection,
  AiConnectionInput,
  PersonalAiConnection,
  ServiceTerms,
} from "./api/generated/model";
import {
  connectAiConnection,
  connectPersonalAiConnection,
  getAiConnection,
  getPersonalAiConnection,
  replaceAiConnection,
  replacePersonalAiConnection,
} from "./api/generated/models/models";
import {
  acceptServiceTerms,
  advanceOnboarding,
  completeOnboarding,
  getPerson,
  getServiceTerms,
  updatePerson,
} from "./api/generated/people/people";
import {
  type AiConnectMode,
  aiConnectMode,
  askSetupFacts,
  missingOperation,
  type SetupFacts,
} from "./setup";

/** The terms, the person and their AI, asked at once. Never throws. */
export function readSetupFacts(): Promise<SetupFacts> {
  return askSetupFacts({
    terms: () => getServiceTerms(ORGANIZATION_ID, ME),
    person: async () => (await getPerson(ORGANIZATION_ID, ME)).person,
    ai: () => getPersonalAiConnection(ORGANIZATION_ID, ME),
  });
}

/** Agree to one version of the terms, the one the person read. */
export function agreeToTerms(version: string): Promise<ServiceTerms> {
  return acceptServiceTerms(ORGANIZATION_ID, ME, { version });
}

/** Keep the person's place in onboarding, by the web app's number for the step. */
export async function keepOnboardingStep(step: number): Promise<void> {
  await advanceOnboarding(ORGANIZATION_ID, ME, { step });
}

export async function finishOnboarding(): Promise<void> {
  await completeOnboarding(ORGANIZATION_ID, ME);
}

export async function saveName(name: string): Promise<void> {
  await updatePerson(ORGANIZATION_ID, ME, { name });
}

/** What Connect your AI draws from: the person's own AI, and whether an admin could connect the organization's. */
export type AiState = {
  /** Null from an OpenBot older than a person's own AI. */
  personal: PersonalAiConnection | null;
  /** The organization's, asked only where a person can't have their own. Null when it can't be read. */
  organization: AiConnection | null;
  mode: AiConnectMode;
};

export async function readAiState(): Promise<AiState> {
  let personal: PersonalAiConnection | null = null;
  try {
    personal = await getPersonalAiConnection(ORGANIZATION_ID, ME);
  } catch (error) {
    if (!missingOperation(error)) throw error;
  }
  let organization: AiConnection | null = null;
  if (personal?.available !== true) {
    // A member may be refused the organization's: they can't change it either way.
    organization = await getAiConnection(ORGANIZATION_ID).catch(() => null);
  }
  return {
    personal,
    organization,
    mode: aiConnectMode(personal, organization?.editable === true),
  };
}

/** Whether Bots have an AI to run on for this person now. */
export function aiConnected(state: AiState): boolean {
  if (state.personal) return state.personal.uses !== "none";
  return Boolean(state.organization?.provider);
}

/**
 * Connect an AI: one more beside the others (connectPersonalAiConnection, connectAiConnection), or, on an OpenBot
 * older than several connections, the one connection (replacePersonalAiConnection, replaceAiConnection). The server
 * checks it with the provider before it keeps anything, and a refusal throws its own sentence.
 */
export async function connectAi(
  mode: "personal" | "organization",
  input: AiConnectionInput,
): Promise<void> {
  try {
    if (mode === "personal")
      await connectPersonalAiConnection(ORGANIZATION_ID, ME, input);
    else await connectAiConnection(ORGANIZATION_ID, input);
  } catch (error) {
    if (!missingOperation(error)) throw error;
    if (mode === "personal")
      await replacePersonalAiConnection(ORGANIZATION_ID, ME, input);
    else await replaceAiConnection(ORGANIZATION_ID, input);
  }
}
