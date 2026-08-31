import { describe, expect, test } from "bun:test";
import {
  type BotTemplate,
  parseBotTemplate,
  serializeBotTemplate,
  STRICT_BOUNDARY,
  TemplateRefusedError,
} from "../../shared/bot-template";
import type { AgentProfile } from "../src/agents/profile-types";
import {
  type PackInput,
  packBotTemplate,
  refuseSecrets,
  SecretInTemplateError,
} from "../src/templates/pack";

/**
 * Packing a coworker, tested as the export boundary it is.
 *
 * Two things are being proved here and they pull in opposite directions. The first is that everything
 * a coworker IS survives the trip: its prose, its skills, the pairing between them, and enough of its
 * ask that an importer knows what to grant. The second is that nothing about the deployment it was
 * packed from goes with it, and that the author is told what was left behind rather than finding out
 * later from a Bot that does not work.
 *
 * The round-trip test is the load-bearing one. `pack` and `parse` live in different files and each
 * restates the other's limits, so a draft this module produces that the parser then refuses is a
 * shipped file nobody can import — including the deployment that wrote it.
 */

/**
 * The two characters that open an environment reference, kept apart from the name they open.
 *
 * Written this way so the file itself is not a template literal the linter has to be told about,
 * and so a reader can see that the sequence under test is exactly the two characters and nothing
 * clever. `shared/bot-template.ts` holds the same pair as a plain string for the same reason.
 */
const INTERPOLATION_OPEN = "${";

/** An id in the shape `create` mints, which is also what it writes into `avatar_seed` today. */
const AGENT_ID = "agent_9f0c4b1e-7d52-4a3f-9c88-1b0d5e6a2f34";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: AGENT_ID,
    name: "Renewal Desk",
    title: "Accounts Receivable",
    roleDescription:
      "Chase overdue invoices. Work out who is late and by how much, and draft a follow-up for a person to send.",
    avatarSeed: AGENT_ID,
    visibility: "public",
    ownerUserId: "user_7",
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
}

const RENEWAL_SKILL = {
  slug: "check-renewal-risk",
  title: "Check renewal risk",
  summary:
    "Pull the contract, the recent tickets and the usage trend for one account.",
  instructions:
    "Find the contract and read the renewal date and the notice period from it. Name each document you used.",
  tools: ["google-drive/search_files", "google-drive/read_file_content"],
};

function packInput(overrides: Partial<PackInput> = {}): PackInput {
  return {
    profile: profile(),
    configuration: {},
    skills: [RENEWAL_SKILL],
    grants: [
      { ref: "google-drive/search_files" },
      { ref: "google-drive/read_file_content" },
    ],
    components: ["showBarChart"],
    ...overrides,
  };
}

/** A Bot with every strippable thing set at once, so the strip list can be checked whole. */
function loadedInput(): PackInput {
  return packInput({
    profile: profile({
      systemOwned: true,
      hasCallbackToken: true,
      hasAuth: true,
      endpoint: "https://renewals.example.com/agui",
    }),
    configuration: {
      endpoint: "https://renewals.example.com/agui",
      auth: { header: "Authorization", credentialId: "cred_4471" },
    },
  });
}

function names(stripped: string[], field: string): boolean {
  return stripped.some((entry) => entry.includes(field));
}

describe("what a template carries", () => {
  test("the coworker's identity and its prose", () => {
    const { template } = packBotTemplate(packInput());
    expect(template.bot.name).toBe("Renewal Desk");
    expect(template.bot.title).toBe("Accounts Receivable");
    expect(template.bot.roleDescription).toBe(profile().roleDescription);
    // The gallery line is drafted from the Bot's own first sentence rather than invented.
    expect(template.template.summary).toBe("Chase overdue invoices.");
  });

  test("each skill's text and the Bot-to-skill pairing", () => {
    const { template } = packBotTemplate(packInput());
    expect(template.skills).toHaveLength(1);
    expect(template.skills[0]).toEqual({
      slug: "check-renewal-risk",
      title: RENEWAL_SKILL.title,
      summary: RENEWAL_SKILL.summary,
      instructions: RENEWAL_SKILL.instructions,
      // Sorted, so the same Bot packs to the same document and therefore the same digest.
      tools: ["google-drive/read_file_content", "google-drive/search_files"],
    });
    // Without the pairing the imported Bot boots with skills attached to nobody.
    expect(template.bot.skills).toEqual(["check-renewal-risk"]);
  });

  test("the header name, and that a key is wanted, for a remote coworker", () => {
    const { template } = packBotTemplate(
      packInput({
        profile: profile({
          endpoint: "https://renewals.example.com/agui",
          hasAuth: true,
        }),
        configuration: {
          endpoint: "https://renewals.example.com/agui",
          auth: { header: "X-Api-Key", credentialId: "cred_4471" },
        },
      }),
    );
    expect(template.bot.runtime).toBe("remote");
    expect(template.bot.remote).toEqual({
      authHeader: "X-Api-Key",
      requiresKey: true,
    });
  });

  test("no address, in any field, for a remote coworker", () => {
    const { template } = packBotTemplate(
      packInput({
        profile: profile({ endpoint: "https://renewals.example.com/agui" }),
        configuration: { endpoint: "https://renewals.example.com/agui" },
      }),
    );
    // Not as a url, not as documentation, and not as the claim about where conversations go: the
    // host of the Bot being packed is a server on the deployment being packed.
    expect(template.bot.remote?.exampleUrl).toBeUndefined();
    expect(template.bot.remote?.sendsConversationTo).toBeUndefined();
    expect(serializeBotTemplate(template)).not.toContain(
      "renewals.example.com",
    );
  });

  test("an author claim is never invented on the author's behalf", () => {
    const { template } = packBotTemplate(packInput());
    expect(template.template.author).toBeUndefined();
    expect(template.template.source).toBeUndefined();
    expect(template.template.license).toBeUndefined();
  });

  test("no category, because a Bot on a deployment has none to carry", () => {
    /*
     * Nothing in `agents` or `agent_profiles` records what kind of work a coworker does, so a
     * category here could only be the packer guessing from a name or a paragraph of prose — and the
     * guess would file a stranger's template under a gallery heading the author never chose. Left
     * for the author to write into the draft.
     */
    const { template } = packBotTemplate(
      packInput({ profile: profile({ name: "Sales Desk" }) }),
    );
    expect(template.template.category).toBeUndefined();
    expect(serializeBotTemplate(template)).not.toContain("category");
  });
});

describe("where the coworker runs", () => {
  test("its own endpoint makes it remote", () => {
    const { template } = packBotTemplate(
      packInput({
        profile: profile({ endpoint: "https://renewals.example.com/agui" }),
        configuration: { endpoint: "https://renewals.example.com/agui" },
        managedEndpoint: "http://agent:8000/",
      }),
    );
    expect(template.bot.runtime).toBe("remote");
  });

  test("this deployment's own managed address makes it managed", () => {
    // A managed Bot carries an endpoint too — the deployment's own — so the presence of one is not
    // the signal. Without this, every Bot on a deployment with a managed agent packs as remote and
    // every importer is asked to type an address for a coworker that should run in their box.
    const { template } = packBotTemplate(
      packInput({
        profile: profile({ endpoint: "http://agent:8000/" }),
        configuration: { endpoint: "http://agent:8000/" },
        managedEndpoint: "http://agent:8000/",
      }),
    );
    expect(template.bot.runtime).toBe("managed");
    expect(template.bot.remote).toBeUndefined();
  });

  test("no endpoint at all is managed", () => {
    const { template } = packBotTemplate(packInput());
    expect(template.bot.runtime).toBe("managed");
    expect(template.bot.remote).toBeUndefined();
  });
});

describe("what is left behind", () => {
  test("every strippable field is named", () => {
    const { stripped } = packBotTemplate(loadedInput());
    for (const field of [
      "agents.id",
      "agents.package_id",
      "agent_profiles.owner_user_id",
      "agent_profiles.visibility",
      "agents.callback_token_hash",
      "agent_profiles.deleted_at",
      "agent_preferences",
      "configuration.endpoint",
      "configuration.auth.credentialId",
      "agent_profiles.avatar_seed",
      "skills.owner_user_id",
    ]) {
      expect(names(stripped, field)).toBe(true);
    }
  });

  test("none of it reaches the document", () => {
    const { template } = packBotTemplate(loadedInput());
    const yaml = serializeBotTemplate(template);
    for (const value of [
      AGENT_ID,
      "cred_4471",
      "https://renewals.example.com/agui",
      "user_7",
    ]) {
      expect(yaml).not.toContain(value);
    }
  });

  test("it does not claim to strip what the coworker does not have", () => {
    // Telling an author their Bot's key was stripped when their Bot has no key teaches them the
    // wrong thing about what a template carries.
    const { stripped } = packBotTemplate(
      packInput({
        profile: profile({
          ownerUserId: null,
          avatarSeed: "renewal-desk",
        }),
        skills: [],
        grants: [],
        components: [],
      }),
    );
    expect(names(stripped, "package_id")).toBe(false);
    expect(names(stripped, "callback_token_hash")).toBe(false);
    expect(names(stripped, "configuration.endpoint")).toBe(false);
    expect(names(stripped, "credentialId")).toBe(false);
    expect(names(stripped, "avatar_seed")).toBe(false);
    expect(names(stripped, "skills.owner_user_id")).toBe(false);
    expect(names(stripped, "configuration.systemPrompt")).toBe(false);
    // The rules that are true of every export are still stated.
    expect(names(stripped, "agents.id")).toBe(true);
    expect(names(stripped, "agent_profiles.visibility")).toBe(true);
  });

  test("a package Bot's system prompt is reported as missing, not silently dropped", () => {
    // Exporting a shipped Bot is allowed and is not a faithful round trip: the format has no field
    // for a system prompt, so the author has to be told the behaviour did not travel with it.
    const { stripped } = packBotTemplate(
      packInput({
        profile: profile({ systemOwned: true }),
        configuration: {
          systemPrompt: "You are a careful analyst. Cite every document.",
        },
      }),
    );
    expect(names(stripped, "configuration.systemPrompt")).toBe(true);
  });

  test("an id-shaped avatar seed is replaced rather than carried", () => {
    const { template, stripped } = packBotTemplate(packInput());
    expect(template.bot.avatarSeed).toBe("renewal-desk");
    expect(names(stripped, "agent_profiles.avatar_seed")).toBe(true);
  });

  test("a real style token keeps the Bot's face", () => {
    const { template, stripped } = packBotTemplate(
      packInput({ profile: profile({ avatarSeed: "amber-fox" }) }),
    );
    expect(template.bot.avatarSeed).toBe("amber-fox");
    expect(names(stripped, "agent_profiles.avatar_seed")).toBe(false);
  });
});

describe("the ask", () => {
  test("grants become requests, grouped by connector", () => {
    const { template } = packBotTemplate(
      packInput({
        grants: [
          { ref: "notion/notion-search" },
          { ref: "google-drive/search_files" },
          { ref: "google-drive/read_file_content" },
          // A duplicate row must not become a duplicate ask.
          { ref: "notion/notion-search" },
        ],
      }),
    );
    expect(template.requests.connectors.map((entry) => entry.id)).toEqual([
      "google-drive",
      "notion",
    ]);
    expect(
      template.requests.connectors[0]?.tools.map((tool) => tool.ref),
    ).toEqual(["google-drive/read_file_content", "google-drive/search_files"]);
    expect(template.requests.connectors[1]?.tools).toHaveLength(1);
  });

  test("the why is a draft the author is expected to replace", () => {
    const { template } = packBotTemplate(packInput());
    expect(template.requests.connectors[0]?.why).toBe(
      "Granted to this Bot on the deployment it was packed from.",
    );
    expect(template.requests.components).toEqual([
      {
        name: "showBarChart",
        why: "Granted to this Bot on the deployment it was packed from.",
      },
    ]);
  });

  test("nothing in the ask is written as a permission", () => {
    const { template } = packBotTemplate(packInput());
    // The whole request block is names and prose. There is no field here that could be read as a
    // grant, which is the property the import module depends on.
    expect(Object.keys(template.requests).sort()).toEqual([
      "components",
      "connectors",
    ]);
    expect(Object.keys(template.requests.connectors[0] ?? {}).sort()).toEqual([
      "id",
      "tools",
      "why",
    ]);
  });

  test("a grant that is not a serverId/toolName ref is refused, not dropped", () => {
    expect(() =>
      packBotTemplate(packInput({ grants: [{ ref: "google-drive" }] })),
    ).toThrow(TemplateRefusedError);
  });

  test("an ask nobody would read to the end is refused", () => {
    const grants = Array.from({ length: 30 }, (_, index) => ({
      ref: `server-${index}/tool`,
    }));
    expect(() => packBotTemplate(packInput({ grants }))).toThrow(
      /may ask for 40/,
    );
  });
});

describe("the boundary", () => {
  test("is the strictest thing the vocabulary can say", () => {
    const { template } = packBotTemplate(packInput());
    expect(template.boundary).toEqual(STRICT_BOUNDARY);
  });

  test("is a copy, so a draft cannot edit every other template's ceiling", () => {
    const { template } = packBotTemplate(packInput());
    expect(template.boundary).not.toBe(STRICT_BOUNDARY);
    template.boundary.navigateHosts.push("billing.acme.example");
    expect(STRICT_BOUNDARY.navigateHosts).toEqual([]);
  });
});

describe("the slug", () => {
  test("is derived from the Bot's name", () => {
    const { template } = packBotTemplate(packInput());
    expect(template.template.slug).toBe("renewal-desk");
  });

  test("folds accents rather than dropping the letters they sit on", () => {
    const { template } = packBotTemplate(
      packInput({ profile: profile({ name: "Über Desk" }) }),
    );
    expect(template.template.slug).toBe("uber-desk");
  });

  test("punctuation collapses and a trailing hyphen never survives", () => {
    const { template } = packBotTemplate(
      packInput({ profile: profile({ name: "Renewal / Desk (v2) — " }) }),
    );
    expect(template.template.slug).toBe("renewal-desk-v2");
  });

  test("a long name is cut to something the parser accepts", () => {
    const { template } = packBotTemplate(
      packInput({
        profile: profile({
          name: "The Accounts Receivable Renewal Desk For Overdue Invoices",
        }),
      }),
    );
    expect(template.template.slug.length).toBeLessThanOrEqual(40);
    expect(template.template.slug.endsWith("-")).toBe(false);
  });

  test("a name with nothing to make a slug of falls back to one that is valid", () => {
    const { template } = packBotTemplate(
      packInput({ profile: profile({ name: "更新デスク" }) }),
    );
    expect(template.template.slug).toBe("unnamed-bot");
  });
});

describe("the round trip", () => {
  test("a managed coworker survives serialize and parse", () => {
    const { template } = packBotTemplate(packInput());
    expect(parseBotTemplate(serializeBotTemplate(template))).toEqual(template);
  });

  test("a remote coworker survives serialize and parse", () => {
    const { template } = packBotTemplate(
      packInput({
        profile: profile({
          endpoint: "https://renewals.example.com/agui",
          hasAuth: true,
          avatarSeed: "amber-fox",
        }),
        configuration: {
          endpoint: "https://renewals.example.com/agui",
          auth: { header: "Authorization", credentialId: "cred_4471" },
        },
      }),
    );
    expect(parseBotTemplate(serializeBotTemplate(template))).toEqual(template);
  });

  test("a coworker with no skills, no grants and no components survives too", () => {
    const { template } = packBotTemplate(
      packInput({ skills: [], grants: [], components: [] }),
    );
    expect(parseBotTemplate(serializeBotTemplate(template))).toEqual(template);
  });
});

describe("what cannot be packed", () => {
  test("a skill slug the format does not admit", () => {
    // The tenant package's rule admits `find-`; the Skills API's does not, and a template uses the
    // stricter one because a slug that installs and cannot then be edited is worse than a refusal.
    expect(() =>
      packBotTemplate(
        packInput({ skills: [{ ...RENEWAL_SKILL, slug: "find-" }] }),
      ),
    ).toThrow(TemplateRefusedError);
  });

  test("prose past a ceiling the parser would refuse anyway", () => {
    expect(() =>
      packBotTemplate(
        packInput({
          profile: profile({ roleDescription: "a".repeat(1001) }),
        }),
      ),
    ).toThrow(/1000 characters/);
  });

  test("an environment reference in the Bot's own prose", () => {
    // Exported cleanly, this file is refused on every deployment it reaches, including this one, and
    // the author hears about it from a stranger.
    let refusal: unknown;
    try {
      packBotTemplate(
        packInput({
          profile: profile({
            roleDescription: `Read the ledger at ${INTERPOLATION_OPEN}LEDGER_URL} first.`,
          }),
        }),
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(TemplateRefusedError);
    expect((refusal as TemplateRefusedError).reason).toBe("interpolation");
  });
});

/** A packed draft with one field replaced, so the scanner can be aimed at a single string. */
function templateWithProse(prose: string): BotTemplate {
  const { template } = packBotTemplate(packInput());
  return { ...template, bot: { ...template.bot, roleDescription: prose } };
}

describe("the secret scanner", () => {
  /**
   * Assembled at run time rather than written out.
   *
   * A fixture for a secret scanner is, by construction, a string shaped exactly like a credential,
   * and GitHub's push protection reads this file the same way `refuseSecrets` reads a template: it
   * blocked a push over the Slack token that used to sit on one of these lines. The tempting fix is
   * to click the "allow this secret" link, which teaches everybody that the warning is noise — the
   * habit that eventually waves a real one through.
   *
   * So the recognisable prefix is severed and joined back together here. The bytes exist only in
   * memory, the scanner under test sees exactly the string it would see in a real document, and no
   * literal in this repository looks like a credential to anything that scans for one.
   */
  const join = (...parts: string[]) => parts.join("");
  const SECRETS: [string, string][] = [
    ["an sk- key", join("sk", "-live-9aZk3mQ7bR1tYv2xLp8Nd4Wc")],
    [
      "a GitHub personal token",
      join("ghp", "_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
    ],
    [
      "a GitHub oauth token",
      join("gho", "_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
    ],
    [
      "a GitHub user token",
      join("ghu", "_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
    ],
    [
      "a GitHub server token",
      join("ghs", "_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
    ],
    [
      "a fine-grained GitHub token",
      join("github", "_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ"),
    ],
    ["a Slack bot token", join("xox", "b-2345678901-ABCDEFGHIJKLMNOP")],
    ["a Slack user token", join("xox", "p-2345678901-ABCDEFGHIJKLMNOP")],
    ["an AWS access key id", join("AKIA", "IOSFODNN7EXAMPLE")],
    [
      "a JSON web token",
      join(
        "eyJhbGciOiJIUzI1NiJ9",
        ".eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        ".dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
    ],
    [
      "an address carrying a password",
      join("https://svc", ":hunter2@renewals.example.com/agui"),
    ],
    ["a private key", join("-----BEGIN ", "RSA PRIVATE KEY-----")],
    [
      "a bare key beside the word that announces it",
      "The token is 8f3Kd9Lm2Qp7Rt4Vx6Zc1Bn5Hj0Wq8Ee.",
    ],
  ];

  for (const [what, value] of SECRETS) {
    test(`refuses ${what}`, () => {
      let refusal: unknown;
      try {
        refuseSecrets(templateWithProse(`Use this when you connect. ${value}`));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(SecretInTemplateError);
      expect((refusal as SecretInTemplateError).field).toBe(
        "bot.role_description",
      );
      // The refusal is rendered, logged and audited. Quoting the value would leak it into all three.
      expect((refusal as Error).message).not.toContain(value);
    });
  }

  const BENIGN: [string, string][] = [
    [
      "a company name that opens like an AWS key",
      "Ask the AKIA team before you touch the ledger.",
    ],
    [
      "a long English sentence with no key beside it",
      "Check the renewal date and the notice period in the contract before you answer anything.",
    ],
    [
      "a hyphenated runbook name that mentions keys and secrets",
      "Follow the api-key-rotation-and-secret-handling-runbook when a key expires.",
    ],
    [
      "a hyphenated phrase whose middle looks like an sk- key",
      "Use the task-management-system-for-the-whole-team board to file the follow-up.",
    ],
    [
      "prose about a password that carries none",
      "The password is in your own vault, and it is never in this file.",
    ],
  ];

  for (const [what, prose] of BENIGN) {
    test(`allows ${what}`, () => {
      expect(() => refuseSecrets(templateWithProse(prose))).not.toThrow();
      // And the same prose packs, since the scanner runs inside the packer.
      expect(() =>
        packBotTemplate(
          packInput({ profile: profile({ roleDescription: prose }) }),
        ),
      ).not.toThrow();
    });
  }

  test("names the field it found, wherever in the document it is", () => {
    const { template } = packBotTemplate(packInput());
    const withSecret: BotTemplate = {
      ...template,
      skills: [
        {
          ...template.skills[0],
          instructions: "Authenticate with sk-live-9aZk3mQ7bR1tYv2xLp8Nd4Wc.",
        },
      ],
    };
    let refusal: unknown;
    try {
      refuseSecrets(withSecret);
    } catch (error) {
      refusal = error;
    }
    expect((refusal as SecretInTemplateError).field).toBe(
      "skills[0].instructions",
    );
  });

  test("the packer refuses rather than exporting a warning", () => {
    // A warning on an export screen is a sentence an author clicks through, and a key that reaches a
    // file reaches everyone the file reaches.
    expect(() =>
      packBotTemplate(
        packInput({
          profile: profile({
            roleDescription:
              "Call the ledger with sk-live-9aZk3mQ7bR1tYv2xLp8Nd4Wc as the key.",
          }),
        }),
      ),
    ).toThrow(SecretInTemplateError);
  });
});
