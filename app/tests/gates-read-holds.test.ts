import { afterEach, beforeEach, expect, test } from "bun:test";
import { aiConnectionRequired } from "@/lib/ai-connection/queries";
import { ClientError } from "@/lib/client";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { serviceTermsRequired } from "@/lib/service-terms/queries";
import { queryClient } from "@/query-client";
import { problemBody } from "./conversations-api";

/**
 * The signed-in gate's questions never read a hold as their answer.
 *
 * While OpenBot moves an organization, or its database is out of reach for a moment, every read
 * about it is refused 503 with a sentence and Retry-After (organizations/holds.ts and
 * api/organization-unavailable.ts in the backend). Found by the end-to-end test of database sharding:
 * the terms gate read that refusal as "terms not agreed" and showed somebody who agreed long ago
 * "Agree to the terms"; the AI connection gate read it as "no AI connection needed", which takes
 * somebody on Connect your AI out of onboarding. Both throw the hold on now, for the page to say it
 * calmly and go on by itself (organization-held-recovery.test.tsx drives it in a browser).
 *
 * Any other failure still reads as before: the terms as to be agreed to (nobody gets in without the
 * answer), the AI connection as not required.
 */

const ORGANIZATION = "org_northwind";
const TERMS_PATH = `/api/v2/organizations/${ORGANIZATION}/people/me/terms`;
const AI_CONNECTION_PATH = `/api/v2/organizations/${ORGANIZATION}/people/me/ai-connection`;

const HOLDS = [
  {
    name: "a move",
    said: "OpenBot is moving this organization. Try again in a moment.",
    retryAfter: "15",
  },
  {
    name: "a database out of reach",
    said: "This organization is unavailable right now. Try again in a moment.",
    retryAfter: "10",
  },
] as const;

const originalFetch = globalThis.fetch;
const defaults = queryClient.getDefaultOptions();
/** What the server answers each address with. */
let answers: Map<string, () => Response>;

beforeEach(() => {
  queryClient.clear();
  // No wait between the app's own tries of a failure that isn't a hold.
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retryDelay: 0 },
  });
  setCurrentOrganization(ORGANIZATION);
  answers = new Map();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const answer = answers.get(path);
      return answer
        ? answer()
        : Response.json(problemBody(404, "Not found.", "NOT_FOUND"), {
            status: 404,
            headers: { "content-type": "application/problem+json" },
          });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
  setCurrentOrganization(undefined);
});

/** The hold, as the server answers it. */
function held(said: string, retryAfter: string): () => Response {
  return () =>
    Response.json(problemBody(503, said, "SERVICE_UNAVAILABLE"), {
      status: 503,
      headers: {
        "content-type": "application/problem+json",
        "retry-after": retryAfter,
      },
    });
}

/** A failure that isn't a hold. */
function broken(): Response {
  return Response.json(problemBody(500, "Something went wrong.", "INTERNAL"), {
    status: 500,
    headers: { "content-type": "application/problem+json" },
  });
}

const GATES = [
  {
    name: "the terms",
    path: TERMS_PATH,
    ask: serviceTermsRequired,
    otherwise: true,
  },
  {
    name: "the AI connection",
    path: AI_CONNECTION_PATH,
    ask: aiConnectionRequired,
    otherwise: false,
  },
] as const;

for (const gate of GATES) {
  for (const hold of HOLDS)
    test(`${gate.name}: ${hold.name} is thrown on in the server's sentence, never read as an answer`, async () => {
      answers.set(gate.path, held(hold.said, hold.retryAfter));
      const asked = gate.ask(queryClient);
      await expect(asked).rejects.toBeInstanceOf(ClientError);
      await expect(asked).rejects.toMatchObject({
        status: 503,
        said: hold.said,
        retryAfterMs: Number(hold.retryAfter) * 1000,
      });
    });

  test(`${gate.name}: any other failure reads as it always did`, async () => {
    answers.set(gate.path, broken);
    expect(await gate.ask(queryClient)).toBe(gate.otherwise);
  });
}
