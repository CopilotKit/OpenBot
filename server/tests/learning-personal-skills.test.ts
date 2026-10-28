import { describe, expect, test } from "bun:test";
import type { VerifiedSnapshot } from "@copilotkit/runtime/internal/learned-skills";
import {
  CopilotKitIntelligence,
  LearnedSkillsError,
  type LearnedSkillsSnapshotResult,
} from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import { personalLearningContainerId } from "../src/learning/personal-space";
import {
  createLearningRuntime,
  mergeLearnedSkills,
} from "../src/learning/runtime";
import type { LearningSettingsStore } from "../src/learning/settings";
import type { OpenSkillSource } from "../src/learning/sharing";
import { skillArchive } from "./fixtures/learned-skill-archive";

const ADA = "person-ada";
const GRACE = "person-grace";
const ALAN = "person-alan";
const space = personalLearningContainerId;

/** What each Learning container publishes, or the error its skills read answers with. */
type Published = Record<
  string,
  | LearnedSkillsSnapshotResult
  | LearnedSkillsError
  | (() => Promise<LearnedSkillsSnapshotResult>)
>;

function runtime(
  options: {
    settings?: LearningSettings;
    published?: Published;
    open?: OpenSkillSource[] | (() => Promise<OpenSkillSource[]>);
    personalWaitMs?: number;
    people?: false;
  } = {},
) {
  let clock = 1_000_000;
  const settings: LearningSettings = options.settings ?? {
    enabled: true,
    defaultTarget: { containerId: "openbot" },
    agents: {},
  };
  const store = {
    read: async () => settings,
  } as unknown as LearningSettingsStore;
  const client = new CopilotKitIntelligence({ apiKey: "synthetic-never-sent" });
  const requests: string[] = [];
  client.getLearnedSkillsSnapshot = async ({ containerId }) => {
    requests.push(containerId);
    const answer = options.published?.[containerId];
    if (answer === undefined)
      throw new LearnedSkillsError("CONTAINER_NOT_FOUND", false);
    if (answer instanceof LearnedSkillsError) throw answer;
    return typeof answer === "function" ? answer() : answer;
  };
  const open = options.open ?? [];
  const learning = createLearningRuntime({
    store,
    client,
    freshnessWindowMs: 0,
    ...(options.people === false
      ? {}
      : {
          people: {
            containerFor: space,
            openSkills: typeof open === "function" ? open : async () => open,
            // An administrator has turned on Skill sharing; the switch itself is learning-sharing.integration.test.ts's.
            sharingAllowed: () => true,
          },
        }),
    ...(options.personalWaitMs === undefined
      ? {}
      : { personalWaitMs: options.personalWaitMs }),
    now: () => clock,
  });
  return {
    learning,
    requests,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** The Skill names a run's catalog offers. */
function names(catalog: string | undefined): string[] {
  const json = catalog?.match(/\[.*\]/s)?.[0];
  return json
    ? (JSON.parse(json) as { name: string }[]).map((skill) => skill.name)
    : [];
}

const botSkills = skillArchive("bot-r1", [
  { name: "bot-only" },
  { name: "refund-order", body: "The Bot's own refund steps." },
]);
const adaSkills = skillArchive("ada-r1", [
  { name: "ada-only" },
  { name: "refund-order", body: "Ada's refund steps." },
  { name: "shared-name", body: "Ada's shared-name." },
]);
const graceSkills = skillArchive("grace-r1", [
  { name: "grace-only" },
  { name: "grace-picked" },
  { name: "refund-order", body: "Grace's refund steps." },
  { name: "ada-only", body: "Grace's ada-only." },
  { name: "both-opened", body: "Grace's both-opened." },
]);
const alanSkills = skillArchive("alan-r1", [
  { name: "both-opened", body: "Alan's both-opened." },
  { name: "alan-only" },
]);

describe("a person's run", () => {
  test("gets the Bot's own Skills and the person's own, and the Bot's own wins a name clash", async () => {
    const { learning } = runtime({
      published: { openbot: botSkills, [space(ADA)]: adaSkills },
    });
    const run = await learning.acquire("bot", undefined, ADA);
    expect(names(run?.catalog)).toEqual([
      "ada-only",
      "bot-only",
      "refund-order",
      "shared-name",
    ]);
    expect(
      await run?.execute("copilotkit_load_skill", {
        skill_name: "refund-order",
      }),
    ).toContain("The Bot's own refund steps.");
    expect(
      await run?.execute("copilotkit_load_skill", { skill_name: "ada-only" }),
    ).toContain("Guidance for ada-only.");
  });

  test("of a Bot with no Learning space of its own still gets the person's Skills", async () => {
    const { learning } = runtime({
      settings: { enabled: true, defaultTarget: null, agents: {} },
      published: { [space(ADA)]: adaSkills },
    });
    const run = await learning.acquire("bot", undefined, ADA);
    expect(names(run?.catalog)).toEqual([
      "ada-only",
      "refund-order",
      "shared-name",
    ]);
    expect(run?.tools.map((tool) => tool.name)).toEqual([
      "copilotkit_load_skill",
      "copilotkit_read_skill_file",
    ]);
  });

  test("with no person named gets the Bot's own Skills only, exactly as before", async () => {
    const { learning, requests } = runtime({
      published: { openbot: botSkills, [space(ADA)]: adaSkills },
    });
    const run = await learning.acquire("bot");
    expect(names(run?.catalog)).toEqual(["bot-only", "refund-order"]);
    expect(requests).toEqual(["openbot"]);
  });

  test("Learning off, or the Bot excluded by an administrator, gets nothing and asks nothing", async () => {
    // Annotated rather than `satisfies`: an array literal's element type is the union of its
    // elements, normalised so the first one's `agents: {}` reads `{ bot?: undefined }`, which a
    // `LearningSettings` does not accept.
    const switchedOff: LearningSettings[] = [
      { enabled: false, defaultTarget: { containerId: "openbot" }, agents: {} },
      {
        enabled: true,
        defaultTarget: { containerId: "openbot" },
        agents: { bot: null },
      },
    ];
    for (const settings of switchedOff) {
      const { learning, requests } = runtime({
        settings,
        published: { openbot: botSkills, [space(ADA)]: adaSkills },
      });
      expect(await learning.acquire("bot", undefined, ADA)).toBeUndefined();
      expect(requests).toEqual([]);
    }
  });

  test("a Bot with no space and a person with no Skills runs exactly as one with no Learning", async () => {
    const { learning } = runtime({
      settings: { enabled: true, defaultTarget: null, agents: {} },
    });
    expect(await learning.acquire("bot", undefined, ADA)).toBeUndefined();
  });
});

describe("a person's space failing", () => {
  test.each([
    ["missing", new LearnedSkillsError("CONTAINER_NOT_FOUND", false)],
    ["unreachable", new LearnedSkillsError("NETWORK_ERROR", true)],
    ["refused", new LearnedSkillsError("AUTHORIZATION_FAILED", false)],
    ["not served", new LearnedSkillsError("UNSUPPORTED_SERVER", false)],
  ])(
    "%s never breaks the run: it goes on with the Bot's own Skills",
    async (_label, error) => {
      const { learning } = runtime({
        published: { openbot: botSkills, [space(ADA)]: error },
      });
      const run = await learning.acquire("bot", undefined, ADA);
      expect(names(run?.catalog)).toEqual(["bot-only", "refund-order"]);
    },
  );

  test("a space that never answers is left behind after the wait, and the run goes on", async () => {
    const { learning } = runtime({
      published: {
        openbot: botSkills,
        [space(ADA)]: () => new Promise(() => {}),
      },
      personalWaitMs: 30,
    });
    const started = performance.now();
    const run = await learning.acquire("bot", undefined, ADA);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(names(run?.catalog)).toEqual(["bot-only", "refund-order"]);
  });

  test("a refused space is not asked again by runs for a minute", async () => {
    const { learning, requests, advance } = runtime({
      published: {
        openbot: botSkills,
        [space(ADA)]: new LearnedSkillsError("CONTAINER_NOT_FOUND", false),
      },
    });
    await learning.acquire("bot", undefined, ADA);
    await learning.acquire("bot", undefined, ADA);
    expect(requests.filter((id) => id === space(ADA))).toHaveLength(1);
    advance(60_001);
    await learning.acquire("bot", undefined, ADA);
    expect(requests.filter((id) => id === space(ADA))).toHaveLength(2);
  });

  test("an open-Skill index that cannot be read leaves the person's own Skills in the run", async () => {
    const { learning } = runtime({
      published: { openbot: botSkills, [space(ADA)]: adaSkills },
      open: async () => {
        throw new Error("database down");
      },
    });
    const run = await learning.acquire("bot", undefined, ADA);
    expect(names(run?.catalog)).toContain("ada-only");
  });

  test("the Bot's own refusal still fails the run, as it always has", async () => {
    const { learning } = runtime({
      published: {
        openbot: new LearnedSkillsError("DELIVERY_DISABLED", false),
        [space(ADA)]: adaSkills,
      },
    });
    await expect(learning.acquire("bot", undefined, ADA)).rejects.toThrow();
  });
});

describe("other people's opened Skills", () => {
  const published = {
    openbot: botSkills,
    [space(ADA)]: adaSkills,
    [space(GRACE)]: graceSkills,
    [space(ALAN)]: alanSkills,
  };

  test("closed: nobody else's Bots see them", async () => {
    // A closed person has no entry in the index at all.
    const { learning, requests } = runtime({ published, open: [] });
    const run = await learning.acquire("bot", undefined, ADA);
    expect(names(run?.catalog)).not.toContain("grace-only");
    expect(requests).not.toContain(space(GRACE));
  });

  test("open: every Skill joins another person's run, under the clash rule", async () => {
    const { learning } = runtime({
      published,
      open: [{ userId: GRACE, containerId: space(GRACE), skills: "all" }],
    });
    const run = await learning.acquire("bot", undefined, ADA);
    expect(names(run?.catalog)).toEqual([
      "ada-only",
      "bot-only",
      "both-opened",
      "grace-only",
      "grace-picked",
      "refund-order",
      "shared-name",
    ]);
    // The Bot's own beats an opened one; the person's own beats an opened one.
    expect(
      await run?.execute("copilotkit_load_skill", {
        skill_name: "refund-order",
      }),
    ).toContain("The Bot's own refund steps.");
    expect(
      await run?.execute("copilotkit_load_skill", { skill_name: "ada-only" }),
    ).toContain("Guidance for ada-only.");
  });

  test("choose: only the Skills picked join another person's run", async () => {
    const { learning } = runtime({
      published,
      open: [
        {
          userId: GRACE,
          containerId: space(GRACE),
          skills: new Set(["grace-picked"]),
        },
      ],
    });
    const run = await learning.acquire("bot", undefined, ADA);
    expect(names(run?.catalog)).toContain("grace-picked");
    expect(names(run?.catalog)).not.toContain("grace-only");
  });

  test("a person's own run always has all their own Skills, whatever they opened", async () => {
    const { learning } = runtime({
      published,
      open: [
        {
          userId: GRACE,
          containerId: space(GRACE),
          skills: new Set(["grace-picked"]),
        },
      ],
    });
    const run = await learning.acquire("bot", undefined, GRACE);
    expect(names(run?.catalog)).toEqual(
      expect.arrayContaining(["grace-only", "grace-picked", "both-opened"]),
    );
  });

  test("two people opening a Skill with the same name both keep it, each under their space's name", async () => {
    const { learning } = runtime({
      published,
      open: [
        { userId: GRACE, containerId: space(GRACE), skills: "all" },
        { userId: ALAN, containerId: space(ALAN), skills: "all" },
      ],
    });
    const run = await learning.acquire("bot", undefined, ADA);
    const offered = names(run?.catalog);
    expect(offered).not.toContain("both-opened");
    expect(offered).toEqual(
      expect.arrayContaining([
        `${space(GRACE)}/both-opened`,
        `${space(ALAN)}/both-opened`,
        "alan-only",
        "grace-only",
      ]),
    );
    expect(
      await run?.execute("copilotkit_load_skill", {
        skill_name: `${space(ALAN)}/both-opened`,
      }),
    ).toContain("Alan's both-opened.");
    expect(
      await run?.execute("copilotkit_load_skill", {
        skill_name: `${space(GRACE)}/both-opened`,
      }),
    ).toContain("Grace's both-opened.");
  });

  test("an opened space that fails is left out, and the rest still arrive", async () => {
    const { learning } = runtime({
      published: {
        ...published,
        [space(GRACE)]: new LearnedSkillsError("NETWORK_ERROR", true),
      },
      open: [
        { userId: GRACE, containerId: space(GRACE), skills: "all" },
        { userId: ALAN, containerId: space(ALAN), skills: "all" },
      ],
    });
    const run = await learning.acquire("bot", undefined, ADA);
    expect(names(run?.catalog)).toEqual(
      expect.arrayContaining(["alan-only", "both-opened"]),
    );
    expect(names(run?.catalog)).not.toContain("grace-only");
  });
});

describe("mergeLearnedSkills", () => {
  const snapshot = (revision: string, skillNames: string[]): VerifiedSnapshot =>
    Object.freeze({
      revision,
      etag: `"${revision}"`,
      skills: skillNames.map((name) =>
        Object.freeze({
          name,
          description: `${revision}:${name}`,
          files: [],
        }),
      ),
    });

  test("with nothing to add, the Bot's own snapshot comes back unchanged", () => {
    const bot = snapshot("bot", ["a"]);
    expect(mergeLearnedSkills({ bot })).toBe(bot);
    expect(mergeLearnedSkills({ bot, opened: [] })).toBe(bot);
  });

  test("the Bot's own, then the person's own, then opened ones, with clashing opened names qualified", () => {
    const merged = mergeLearnedSkills({
      bot: snapshot("bot", ["x", "y"]),
      own: snapshot("own", ["y", "z"]),
      opened: [
        {
          source: { userId: "g", containerId: "user-g", skills: "all" },
          snapshot: snapshot("g", ["x", "z", "w", "v"]),
        },
        {
          source: {
            userId: "h",
            containerId: "user-h",
            skills: new Set(["w"]),
          },
          snapshot: snapshot("h", ["w", "u"]),
        },
      ],
    });
    expect(
      merged?.skills.map((skill) => [skill.name, skill.description]),
    ).toEqual([
      ["x", "bot:x"],
      ["y", "bot:y"],
      ["z", "own:z"],
      ["v", "g:v"],
      ["user-g/w", "g:w"],
      ["user-h/w", "h:w"],
    ]);
  });

  test("the merged snapshot's identity changes with any source and stays the same for the same sources", () => {
    const input = {
      bot: snapshot("bot", ["a"]),
      own: snapshot("own", ["b"]),
    };
    const first = mergeLearnedSkills(input);
    expect(mergeLearnedSkills(input)?.etag).toBe(first?.etag);
    expect(
      mergeLearnedSkills({ ...input, own: snapshot("own-2", ["b"]) })?.etag,
    ).not.toBe(first?.etag);
    expect(first?.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });
});
