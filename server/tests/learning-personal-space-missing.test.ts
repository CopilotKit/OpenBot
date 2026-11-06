import { afterEach, expect, spyOn, test } from "bun:test";
import type { LearnedSkillsSnapshotResult } from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import { IntelligenceKnowingANewThread } from "@openbot/toolkit/copilotkit/agents";
import { observeIntelligenceAuthentication } from "../src/intelligence-client";
import { personalLearningContainerId as space } from "../src/learning/personal-space";
import { createLearningRuntime } from "../src/learning/runtime";
import type { LearningSettingsStore } from "../src/learning/settings";
import type { OpenSkillSource } from "../src/learning/sharing";
import { skillArchive } from "./fixtures/learned-skill-archive";

/**
 * Kink 24 of the Helm bundle build. Every Bot run on a vanilla install logged
 * `learning-personal-skills-unavailable` with `CONTAINER_NOT_FOUND` for the person's own Learning
 * space. That space is made when the person first connects a browser to record with
 * (learning/personal-space.ts, docs/automatic-learning.md "Made on first need"), and nobody on that
 * install had, so it did not exist, as designed. A missing space of one's own is said once, as
 * information; one somebody opened to everyone and that is gone is still a warning.
 *
 * Real: the Learning runtime and the runtime client copilot.ts gives it, reading over HTTP.
 * Faked: Intelligence's skills route, answering with its own envelope for a container it does not
 * have (`CONTAINER_NOT_FOUND`, apps/app-api/src/errors/registry.ts) and a published snapshot for
 * the Bot's own.
 */

const ADA = "dev-local-user";
const GRACE = "person-grace";
const botSkills = skillArchive("bot-r1", [{ name: "bot-only" }]);
const adaSkills = skillArchive("ada-r1", [{ name: "ada-only" }]);

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function intelligence(published: Map<string, LearnedSkillsSnapshotResult>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const id = decodeURIComponent(
        new URL(request.url).pathname.split("/")[5] ?? "",
      );
      const snapshot = published.get(id);
      if (snapshot?.status === "snapshot")
        return new Response(Uint8Array.from(snapshot.bytes), {
          headers: {
            "Content-Type": "application/zip",
            ETag: snapshot.etag,
            "X-CopilotKit-Skills-Revision": snapshot.revision,
          },
        });
      return Response.json(
        {
          error: {
            code: "CONTAINER_NOT_FOUND",
            message: "The Learning container was not found in this project.",
            category: "not_found",
            retryable: false,
          },
          requestId: "request-test",
          traceId: "trace-test",
        },
        { status: 404 },
      );
    },
  });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

function learningOver(apiUrl: string, open: OpenSkillSource[] = []) {
  let clock = 1_000_000;
  const settings: LearningSettings = {
    enabled: true,
    defaultTarget: { containerId: "openbot" },
    agents: {},
  };
  const learning = createLearningRuntime({
    store: { read: async () => settings } as unknown as LearningSettingsStore,
    // The client copilot.ts hands the Learning runtime.
    client: observeIntelligenceAuthentication(
      new IntelligenceKnowingANewThread({
        apiUrl,
        wsUrl: "ws://127.0.0.1:9",
        apiKey: "cpk-test-key",
      }),
    ),
    freshnessWindowMs: 0,
    people: {
      containerFor: space,
      openSkills: async () => open,
      withheld: async () => new Map(),
      sharingAllowed: () => true,
    },
    now: () => clock,
  });
  return {
    learning,
    later: () => {
      clock += 61_000;
    },
  };
}

function names(catalog: string | undefined): string[] {
  const json = catalog?.match(/\[.*\]/s)?.[0];
  return json
    ? (JSON.parse(json) as { name: string }[]).map((skill) => skill.name)
    : [];
}

function lines(spy: { mock: { calls: unknown[][] } }, type: string) {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes(`"type":"${type}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a person who has not connected a browser yet has no space of their own, said once as information", async () => {
  const published = new Map([["openbot", botSkills]]);
  const { learning, later } = learningOver(intelligence(published));
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  const told = spyOn(console, "info").mockImplementation(() => {});
  try {
    // Runs across several minutes, each past the minute a missing space is left alone for.
    for (let run = 0; run < 3; run++) {
      const acquired = await learning.acquire("bot", undefined, ADA);
      expect(names(acquired?.catalog)).toEqual(["bot-only"]);
      later();
    }
    expect(lines(warned, "learning-personal-skills-unavailable")).toEqual([]);
    expect(lines(told, "learning-personal-space-not-made")).toEqual([
      expect.objectContaining({ containerId: space(ADA) }),
    ]);

    // They connect a browser and the space is made: the next run past the minute has its Skills.
    published.set(space(ADA), adaSkills);
    const acquired = await learning.acquire("bot", undefined, ADA);
    expect(names(acquired?.catalog)).toEqual(["ada-only", "bot-only"]);
    expect(lines(warned, "learning-personal-skills-unavailable")).toEqual([]);
  } finally {
    warned.mockRestore();
    told.mockRestore();
  }
});

test("a space somebody opened to everyone that is now missing is still a warning", async () => {
  const published = new Map([
    ["openbot", botSkills],
    [space(ADA), adaSkills],
  ]);
  const { learning } = learningOver(intelligence(published), [
    {
      userId: GRACE,
      containerId: space(GRACE),
      skills: "all",
    },
  ]);
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  const told = spyOn(console, "info").mockImplementation(() => {});
  try {
    const acquired = await learning.acquire("bot", undefined, ADA);
    expect(names(acquired?.catalog)).toEqual(["ada-only", "bot-only"]);
    expect(lines(warned, "learning-personal-skills-unavailable")).toEqual([
      {
        type: "learning-personal-skills-unavailable",
        containerId: space(GRACE),
        code: "CONTAINER_NOT_FOUND",
      },
    ]);
    expect(lines(told, "learning-personal-space-not-made")).toEqual([]);
  } finally {
    warned.mockRestore();
    told.mockRestore();
  }
});
