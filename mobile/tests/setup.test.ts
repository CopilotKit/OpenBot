/**
 * Finishing setting up on the phone (src/setup.ts): which step a signed-in person meets next, decided from the
 * server's verdicts as the web app decides it, and an OpenBot older than a question never holding anybody out. The
 * server is stood in for by the questions the gate asks, handed in.
 */
import { expect, test } from "bun:test";
import {
  ENDPOINT_PRESETS as WEB_PRESETS,
  AI_PROVIDERS as WEB_PROVIDERS,
} from "../../app/src/lib/ai-connection/providers";
import type {
  Person,
  PersonalAiConnection,
  ServiceTerms,
} from "../src/api/generated/model";
import {
  aiConnectMode,
  askSetupFacts,
  CONNECT_YOUR_AI_ROUTE,
  connectAiRouteFor,
  connectionInput,
  missingOperation,
  NO_AI_CONNECTION,
  NO_PERSONAL_AI_CONNECTION,
  nextSetupStep,
  onboardingSteps,
  PHONE_PROVIDERS,
  resumeStep,
  type SetupQuestions,
} from "../src/setup";

/** A refusal as the phone's request function throws it (src/api/request.ts's ApiError). */
class Refusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const TERMS_AGREED: ServiceTerms = {
  current: {
    version: "2026-11-21",
    termsOfServiceUrl: "https://open.bot/terms",
    acceptableUseUrl: "https://open.bot/acceptable-use",
  },
  accepted: { version: "2026-11-21", acceptedAt: "2026-11-21T10:00:00Z" },
  acceptanceNeeded: false,
};
const TERMS_NEEDED: ServiceTerms = {
  ...TERMS_AGREED,
  accepted: null,
  acceptanceNeeded: true,
};

const PERSON: Person = {
  id: "p_1",
  email: "sam@example.com",
  name: "Sam",
  image: null,
  role: "owner",
  needsName: false,
  onboarding: { step: 4, completedAt: "2026-11-21T10:05:00Z" },
  providers: ["google"],
  lastSignedInAt: null,
  revoked: false,
  configuredAdmin: false,
};
const NEW_PERSON: Person = {
  ...PERSON,
  name: "sam@example.com",
  needsName: true,
  onboarding: { step: 0, completedAt: null },
};

const AI_CONNECTED: PersonalAiConnection = {
  connection: {
    provider: "openai",
    login: "api-key",
    model: null,
    endpointHost: null,
    keySet: true,
    ready: true,
    source: "stored",
    editable: true,
    saved: [],
    changedAt: null,
  },
  organization: { ready: false, provider: null },
  uses: "personal",
  required: true,
  available: true,
  signIns: ["openai", "anthropic"],
};
const AI_NONE: PersonalAiConnection = {
  ...AI_CONNECTED,
  connection: { ...AI_CONNECTED.connection, provider: null, login: null },
  uses: "none",
};

function questions(over: Partial<SetupQuestions> = {}): SetupQuestions {
  return {
    terms: async () => TERMS_AGREED,
    person: async () => PERSON,
    ai: async () => AI_CONNECTED,
    ...over,
  };
}

const refused = (status: number, code?: string) => async () => {
  throw new Refusal("Refused.", status, code);
};

test("somebody with everything done goes straight into the app", async () => {
  expect(nextSetupStep(await askSetupFacts(questions()))).toBeNull();
});

test("a brand-new OpenBot Cloud account meets the terms first, then onboarding", async () => {
  const fresh = questions({
    terms: async () => TERMS_NEEDED,
    person: async () => NEW_PERSON,
    ai: async () => AI_NONE,
  });
  expect(nextSetupStep(await askSetupFacts(fresh))).toBe("terms");
  const agreed = questions({
    person: async () => NEW_PERSON,
    ai: async () => AI_NONE,
  });
  expect(nextSetupStep(await askSetupFacts(agreed))).toBe("onboarding");
});

test("somebody who finished onboarding before Connect your AI existed has their AI to connect", async () => {
  const facts = await askSetupFacts(questions({ ai: async () => AI_NONE }));
  expect(nextSetupStep(facts)).toBe("ai");
});

test("an AI the server doesn't require, or one the organization provides, is nothing to connect", async () => {
  const notRequired = questions({
    ai: async () => ({ ...AI_NONE, required: false }),
  });
  expect(nextSetupStep(await askSetupFacts(notRequired))).toBeNull();
  const organizations = questions({
    ai: async () => ({ ...AI_NONE, uses: "organization" }),
  });
  expect(nextSetupStep(await askSetupFacts(organizations))).toBeNull();
});

test("an OpenBot older than every question holds nobody out", async () => {
  const older = questions({
    terms: refused(404),
    person: refused(405),
    ai: refused(404, "NOT_FOUND"),
  });
  const facts = await askSetupFacts(older);
  expect(facts.terms.kind).toBe("missing");
  expect(facts.person.kind).toBe("missing");
  expect(facts.ai.kind).toBe("missing");
  expect(nextSetupStep(facts)).toBeNull();
  expect(missingOperation(new Refusal("Not implemented.", 501))).toBe(true);
});

test("terms the server refused to read hold the person at the terms, where they can try again", async () => {
  const facts = await askSetupFacts(questions({ terms: refused(500) }));
  expect(facts.terms).toMatchObject({ kind: "failed", status: 500 });
  expect(nextSetupStep(facts)).toBe("terms");
  // A 404 about this request (the person isn't there) is a refusal, not an older OpenBot.
  const notFound = await askSetupFacts(
    questions({ terms: refused(404, "PERSON_NOT_FOUND") }),
  );
  expect(nextSetupStep(notFound)).toBe("terms");
});

test("a question that never reached the server blocks nothing", async () => {
  const offline = questions({
    terms: async () => {
      throw new TypeError("Network request failed");
    },
    person: async () => {
      throw new TypeError("Network request failed");
    },
    ai: async () => {
      throw new TypeError("Network request failed");
    },
  });
  expect(nextSetupStep(await askSetupFacts(offline))).toBeNull();
});

test("onboarding is Welcome, then Connect your AI where one is needed, then the name where it isn't known", () => {
  expect(onboardingSteps(NEW_PERSON, AI_NONE)).toEqual([
    "welcome",
    "ai",
    "name",
  ]);
  expect(onboardingSteps(NEW_PERSON, AI_CONNECTED)).toEqual([
    "welcome",
    "name",
  ]);
  const named = { ...NEW_PERSON, name: "Sam", needsName: false };
  expect(onboardingSteps(named, AI_CONNECTED)).toEqual(["welcome"]);
  // A name that is only the address isn't known.
  expect(
    onboardingSteps({ ...named, name: "sam@example.com" }, AI_CONNECTED),
  ).toEqual(["welcome", "name"]);
  // Somebody who finished onboarding has only their AI, or nothing.
  expect(onboardingSteps(PERSON, AI_NONE)).toEqual(["ai"]);
  expect(onboardingSteps(PERSON, AI_CONNECTED)).toEqual([]);
  // An OpenBot that doesn't track onboarding has none to do.
  expect(onboardingSteps({ ...NEW_PERSON, onboarding: null }, null)).toEqual(
    [],
  );
});

test("the person picks up where the server kept them, by the web app's numbers", () => {
  const all = ["welcome", "ai", "name"] as const;
  expect(resumeStep(all, 0, false)).toBe("welcome");
  expect(resumeStep(all, 1, false)).toBe("welcome");
  expect(resumeStep(all, 4, false)).toBe("ai");
  expect(resumeStep(all, 3, true)).toBe("name");
  // Nothing after Connect your AI until it is connected.
  expect(resumeStep(all, 3, false)).toBe("ai");
  // OpenBot for Business (2), which the phone never shows, reads as the next step the person has.
  expect(resumeStep(all, 2, true)).toBe("name");
  expect(resumeStep(["welcome", "name"], 4, true)).toBe("name");
  expect(resumeStep(["welcome"], 3, true)).toBe("welcome");
  // A number no step has starts at the beginning.
  expect(resumeStep(all, 99, false)).toBe("welcome");
});

test("everybody connects their own AI where they can; elsewhere an admin connects the organization's", () => {
  expect(aiConnectMode({ available: true }, false)).toBe("personal");
  expect(aiConnectMode({ available: true }, true)).toBe("personal");
  expect(aiConnectMode({ available: false }, true)).toBe("organization");
  expect(aiConnectMode({ available: false }, false)).toBe("ask-admin");
  expect(aiConnectMode(null, true)).toBe("organization");
  expect(aiConnectMode(null, false)).toBe("ask-admin");
});

test("a key form sends what the API asks for, and nothing while it is missing something", () => {
  const byId = (id: string) => {
    const found = PHONE_PROVIDERS.find((one) => one.id === id);
    if (!found) throw new Error(id);
    return found;
  };
  const empty = { apiKey: "", baseUrl: "", model: "" };
  expect(connectionInput(byId("openai"), empty)).toBeNull();
  expect(
    connectionInput(byId("anthropic"), { ...empty, apiKey: " sk-ant " }),
  ).toEqual({ provider: "anthropic", login: "api-key", apiKey: "sk-ant" });
  expect(connectionInput(byId("google"), empty)).toBeNull();
  expect(connectionInput(byId("google"), { ...empty, apiKey: "AIza" })).toEqual(
    {
      provider: "google",
      login: "endpoint",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-3.8-flash",
      apiKey: "AIza",
    },
  );
  const own = byId("openai-compatible");
  expect(connectionInput(own, { ...empty, model: "llama" })).toBeNull();
  expect(
    connectionInput(own, {
      ...empty,
      baseUrl: "https://user:pass@example.com/v1",
      model: "llama",
    }),
  ).toBeNull();
  // Its key is the person's to leave out.
  expect(
    connectionInput(own, {
      ...empty,
      baseUrl: "http://10.0.0.2:11434/v1",
      model: "llama",
    }),
  ).toEqual({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "http://10.0.0.2:11434/v1",
    model: "llama",
  });
});

test("the phone offers every provider the web app does, with its key way in and the same presets", () => {
  expect(PHONE_PROVIDERS.map((one) => one.id)).toEqual(
    WEB_PROVIDERS.map((one) => one.id),
  );
  for (const phone of PHONE_PROVIDERS) {
    const web = WEB_PROVIDERS.find((one) => one.id === phone.id);
    expect(phone.name).toBe(web?.name ?? "");
    expect(phone.summary).toBe(web?.keySummary ?? "");
    expect(web?.logins).toContain(phone.login);
    expect(phone.preset).toEqual(WEB_PRESETS[phone.id]);
  }
});

test("a run that failed for want of an AI points to Connect your AI", () => {
  expect(connectAiRouteFor(NO_PERSONAL_AI_CONNECTION)).toBe(
    CONNECT_YOUR_AI_ROUTE,
  );
  expect(connectAiRouteFor(`${NO_AI_CONNECTION}\n`)).toBe(
    CONNECT_YOUR_AI_ROUTE,
  );
  expect(connectAiRouteFor("The model is overloaded. Try again.")).toBeNull();
  expect(connectAiRouteFor(undefined)).toBeNull();
});
