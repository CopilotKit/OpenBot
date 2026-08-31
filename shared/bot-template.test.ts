import { describe, expect, test } from "bun:test";
import {
  BOT_TEMPLATE_FORMAT,
  type BotTemplate,
  botTemplateDigest,
  parseBotTemplate,
  serializeBotTemplate,
  STRICT_BOUNDARY,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LIMITS,
  TemplateRefusedError,
  templateGrantMark,
} from "./bot-template";

/** The sequence under test, built rather than written, for the reason the module states. */
const INTERPOLATION = `${"$"}{KEY_ENCRYPTION_KEY}`;

/** A minimal document every test can start from, so each one varies exactly one thing. */
const MINIMAL = `
openbot_template: 1
template:
  slug: renewal-desk
  summary: Chases overdue invoices.
bot:
  name: Renewal Desk
  title: Accounts Receivable
  role_description: Chase overdue invoices and draft the follow-up.
  runtime: managed
`.trimStart();

function withRoot(extra: string): string {
  return `${MINIMAL}${extra}`;
}

/** The same document filed under one group, for the tests about the closed list. */
function withCategory(category: string): string {
  return MINIMAL.replace(
    "  summary: Chases overdue invoices.",
    `  summary: Chases overdue invoices.\n  category: ${category}`,
  );
}

/** The whole refusal, for the tests that care what its sentence leaves an author able to do. */
function refusalFor(source: string): TemplateRefusedError {
  try {
    parseBotTemplate(source);
  } catch (error) {
    if (error instanceof TemplateRefusedError) return error;
    throw error;
  }
  throw new Error("the document was accepted, and the test expected a refusal");
}

/** Asserts the refusal code as well as the fact of refusal: a refusal for the wrong reason is a bug. */
function refusalOf(source: string): string {
  return refusalFor(source).reason;
}

describe("a document the format accepts", () => {
  test("reads the minimum a template can say", () => {
    const template = parseBotTemplate(MINIMAL);
    expect(template.format).toBe(BOT_TEMPLATE_FORMAT);
    expect(template.template.slug).toBe("renewal-desk");
    expect(template.bot.name).toBe("Renewal Desk");
    expect(template.bot.runtime).toBe("managed");
    expect(template.skills).toEqual([]);
    expect(template.requests).toEqual({ connectors: [], components: [] });
  });

  test("every category in the closed list travels as the slug it was written as", () => {
    for (const category of TEMPLATE_CATEGORIES) {
      expect(parseBotTemplate(withCategory(category)).template.category).toBe(
        category,
      );
    }
  });

  test("an absent category is uncategorised rather than defaulted to a group", () => {
    // The difference matters on the gallery: a template nobody filed must not appear under a
    // heading, and "general" is a group an author chooses rather than one they fall into.
    expect(parseBotTemplate(MINIMAL).template.category).toBeUndefined();
  });

  test("an absent boundary is the strictest one, not the most permissive", () => {
    expect(parseBotTemplate(MINIMAL).boundary).toEqual(STRICT_BOUNDARY);
  });

  test("a partial boundary fills the rest from the strict default", () => {
    const template = parseBotTemplate(
      withRoot(`
boundary:
  browser: read_only
`),
    );
    expect(template.boundary.browser).toBe("read_only");
    expect(template.boundary.shell).toBe("never");
    expect(template.boundary.files).toBe("none");
  });

  test("hostnames are lower-cased and de-duplicated", () => {
    const template = parseBotTemplate(
      withRoot(`
boundary:
  browser: read_only
  navigate_hosts: [Billing.ACME.example, billing.acme.example]
`),
    );
    expect(template.boundary.navigateHosts).toEqual(["billing.acme.example"]);
  });

  test("a skill and its tool declarations survive intact", () => {
    const template = parseBotTemplate(
      withRoot(`
skills:
  - slug: check-renewal-risk
    title: Check renewal risk
    summary: Pull the contract and the recent tickets.
    instructions: Find the contract before answering anything about a renewal.
    tools:
      - google-drive/search_files
      - google-drive/search_files
`),
    );
    expect(template.skills).toHaveLength(1);
    expect(template.skills[0]?.tools).toEqual(["google-drive/search_files"]);
  });

  test("a tool ref is not checked against anything that exists", () => {
    // The whole point: a template names tools for connectors nobody has added yet, and they sit
    // inert until somebody does. Refusing here would mean a template could only ship refs for
    // connectors it could guarantee, which is none of them.
    const template = parseBotTemplate(
      withRoot(`
skills:
  - slug: find-a-thing
    title: Find a thing
    summary: Look somewhere nobody has connected.
    instructions: Search before answering.
    tools: [nobody-has-connected-this/search_everything]
`),
    );
    expect(template.skills[0]?.tools).toEqual([
      "nobody-has-connected-this/search_everything",
    ]);
  });
});

describe("the refusals that read bytes rather than a document", () => {
  test("an environment reference anywhere is refused", () => {
    expect(refusalOf(withRoot(`notes: the key is ${INTERPOLATION}\n`))).toBe(
      "interpolation",
    );
  });

  test("an environment reference in a comment is refused too", () => {
    // Checked before parse precisely so a YAML parser cannot drop it out from under the check.
    const comment = `# ${INTERPOLATION} is expanded by the package loader, not here\n`;
    expect(refusalOf(comment + MINIMAL)).toBe("interpolation");
  });

  // Written as escapes, not as the characters themselves: a source file carrying these has the
  // same problem the check exists to solve, and a reviewer cannot tell a test fixture from a payload.
  test.each([
    ["zero-width space", "\u200B"],
    ["right-to-left override", "\u202E"],
    ["private use area", "\uE000"],
    ["soft hyphen", "\u00AD"],
    ["byte order mark inside the text", "\uFEFF"],
    ["word joiner", "\u2060"],
    ["a tag character", "\u{E0041}"],
    ["a C0 control", "\u0007"],
    ["a C1 control", "\u0085"],
    // The half of the variation-selector alphabet the enumerated ranges used to let through. Two of
    // these per byte carries arbitrary data invisibly inside prose the consent screen calls verbatim.
    ["the first variation selector", "\uFE00"],
    ["the sixteenth variation selector", "\uFE0F"],
    ["a variation selector from the supplement", "\u{E0100}"],
    // Format characters outside the nine blocks the list happened to name.
    ["an Arabic number mark", "\u0605"],
    ["an Arabic end of ayah", "\u06DD"],
    ["a Syriac abbreviation mark", "\u070F"],
    ["a musical symbol format character", "\u{1D173}"],
    ["an Egyptian hieroglyph format control", "\u{13430}"],
    // Kept from the ranges the property classes replaced, so the rewrite cannot have narrowed them.
    ["a supplementary private use codepoint", "\u{F0000}"],
    ["an unpaired surrogate", "\uD800"],
  ] as const)("an invisible codepoint is refused: %s", (_name, character) => {
    expect(refusalOf(withRoot(`notes: hello${character}world\n`))).toBe(
      "invisible_character",
    );
  });

  test("tab, newline and carriage return are not invisible characters", () => {
    const template = parseBotTemplate(
      `${MINIMAL.replace(/\n/g, "\r\n")}notes: "a\\tb"\r\n`,
    );
    expect(template.notes).toBe("a\tb");
  });

  test("a document larger than the limit is refused before it is parsed", () => {
    const padding = "x".repeat(TEMPLATE_LIMITS.DOCUMENT_BYTES);
    expect(refusalOf(withRoot(`notes: ${padding}\n`))).toBe("too_large");
  });
});

describe("the refusals that make parsing strict", () => {
  test("an unknown key at the root is refused rather than ignored", () => {
    expect(refusalOf(withRoot("channels: [general]\n"))).toBe("unknown_key");
  });

  test("an unknown key inside a block is refused just as loudly", () => {
    expect(
      refusalOf(`
openbot_template: 1
template:
  slug: renewal-desk
  summary: Chases overdue invoices.
bot:
  name: Renewal Desk
  title: Accounts Receivable
  role_description: Chase overdue invoices.
  runtime: managed
  model: gpt-4o
`),
    ).toBe("unknown_key");
  });

  test.each([
    ["a credential value", "auth_value: sk-live-not-a-real-key"],
    ["a credential reference", "credential_secret_ref: model-key"],
    ["an endpoint", "endpoint: https://evil.example/agui"],
    ["a url", "url: https://evil.example/agui"],
    ["a system prompt", "system_prompt: You are helpful."],
    ["a package id", "package_id: 0000-1111"],
    ["a visibility", "visibility: public"],
    ["a policy rule", "deny: [true]"],
    ["component source", "components: []"],
  ])(
    "a forbidden field is named rather than quietly dropped: %s",
    (_name, line) => {
      expect(refusalOf(withRoot(`${line}\n`))).toBe("forbidden_field");
    },
  );

  test.each([
    ["a group nobody defined", "growth-hacking"],
    ["a sentence where a chip goes", "The best sales bot on the internet"],
    ["a label instead of a slug", "Customer Success & Support"],
    ["a value that sorts itself to the top", "aaa-sales"],
  ])(
    "a category outside the closed list is refused rather than folded into a group: %s",
    (_name, value) => {
      const refusal = refusalFor(withCategory(JSON.stringify(value)));
      expect(refusal.reason).toBe("bad_type");
      /*
       * The message has to carry the list. A refusal that only says the value is wrong leaves an
       * author guessing at a vocabulary they have no other way to read, and guessing at a closed list
       * is how a file ends up filed under whichever near-miss happened to parse somewhere else.
       */
      for (const category of TEMPLATE_CATEGORIES) {
        expect(refusal.message).toContain(category);
      }
    },
  );

  test("an unreadable format version is refused", () => {
    expect(
      refusalOf(MINIMAL.replace("openbot_template: 1", "openbot_template: 2")),
    ).toBe("format_version");
  });

  test("an absent format version is refused", () => {
    expect(refusalOf(MINIMAL.replace("openbot_template: 1\n", ""))).toBe(
      "format_version",
    );
  });

  test("malformed YAML is refused as malformed YAML", () => {
    expect(refusalOf("openbot_template: 1\n  bad: [indent\n")).toBe(
      "malformed_yaml",
    );
  });
});

describe("the refusals that keep an imported Bot editable", () => {
  test.each([
    ["one character", "x"],
    ["a trailing hyphen", "find-"],
    ["a leading hyphen", "-find"],
    ["upper case", "Find-A-Document"],
    ["an underscore", "find_a_document"],
  ])(
    "a slug the Skills API would refuse is refused here: %s",
    (_name, slug) => {
      expect(
        refusalOf(
          withRoot(`
skills:
  - slug: ${JSON.stringify(slug)}
    title: A skill
    summary: A summary.
    instructions: Some instructions.
`),
        ),
      ).toBe("bad_slug");
    },
  );

  test.each([
    ["name", "name", TEMPLATE_LIMITS.NAME],
    ["title", "title", TEMPLATE_LIMITS.TITLE],
    ["role_description", "role_description", TEMPLATE_LIMITS.ROLE_DESCRIPTION],
  ])(
    "a field longer than the edit form allows is refused: %s",
    (_name, key, limit) => {
      const long = "a".repeat(limit + 1);
      expect(
        refusalOf(MINIMAL.replace(new RegExp(`${key}: .*`), `${key}: ${long}`)),
      ).toBe("too_long");
    },
  );

  test("a role description is measured in the units the edit form measures it in", () => {
    // 501 astral characters is 501 codepoints and 1002 UTF-16 code units. `parseAgentInput` and the
    // browser form both count code units, so counting codepoints here let a template land a Bot
    // whose owner could not save it from its own edit form until they shortened prose they had
    // never written. 500 of the same character is exactly the limit and still imports.
    const overLimit = "\u{1F600}".repeat(
      TEMPLATE_LIMITS.ROLE_DESCRIPTION / 2 + 1,
    );
    expect(
      refusalOf(
        MINIMAL.replace(
          /role_description: .*/,
          `role_description: ${overLimit}`,
        ),
      ),
    ).toBe("too_long");

    const atLimit = "\u{1F600}".repeat(TEMPLATE_LIMITS.ROLE_DESCRIPTION / 2);
    expect(
      parseBotTemplate(
        MINIMAL.replace(/role_description: .*/, `role_description: ${atLimit}`),
      ).bot.roleDescription.length,
    ).toBe(TEMPLATE_LIMITS.ROLE_DESCRIPTION);
  });

  test("a padded value lands trimmed, the way every later save would store it", () => {
    const template = parseBotTemplate(
      MINIMAL.replace("name: Renewal Desk", 'name: "  Renewal Desk  "'),
    );
    expect(template.bot.name).toBe("Renewal Desk");
  });

  test("the same slug twice in one file is refused", () => {
    expect(
      refusalOf(
        withRoot(`
skills:
  - slug: a-skill
    title: One
    summary: One.
    instructions: One.
  - slug: a-skill
    title: Two
    summary: Two.
    instructions: Two.
`),
      ),
    ).toBe("bad_slug");
  });
});

describe("what a template may say about where its Bot runs", () => {
  test("a remote block belongs only on a remote template", () => {
    expect(
      refusalOf(
        withRoot(`
bot_extra: ignored
`),
      ),
    ).toBe("unknown_key");
    expect(
      refusalOf(`
openbot_template: 1
template:
  slug: renewal-desk
  summary: Chases overdue invoices.
bot:
  name: Renewal Desk
  title: Accounts Receivable
  role_description: Chase overdue invoices.
  runtime: managed
  remote:
    requires_key: true
`),
    ).toBe("bad_type");
  });

  test("a remote template describes the ask and never the address", () => {
    const template = parseBotTemplate(`
openbot_template: 1
template:
  slug: renewal-desk
  summary: Chases overdue invoices.
bot:
  name: Renewal Desk
  title: Accounts Receivable
  role_description: Chase overdue invoices.
  runtime: remote
  remote:
    auth_header: Authorization
    requires_key: true
    example_url: https://renewals.example.com/agui
    sends_conversation_to: RENEWALS.example.com
`);
    expect(template.bot.remote?.authHeader).toBe("Authorization");
    expect(template.bot.remote?.requiresKey).toBe(true);
    expect(template.bot.remote?.sendsConversationTo).toBe(
      "renewals.example.com",
    );
    // There is no field that could hold the real address, which is what makes the
    // attacker-endpoint attack unrepresentable rather than merely gated.
    expect(Object.keys(template.bot)).not.toContain("endpoint");
  });

  test.each([
    ["a scheme", "https://billing.acme.example"],
    ["a port", "billing.acme.example:443"],
    ["a path", "billing.acme.example/invoices"],
    ["a wildcard", "*.acme.example"],
  ])(
    "a navigate host that is not a plain hostname is refused: %s",
    (_name, host) => {
      expect(
        refusalOf(
          withRoot(`
boundary:
  browser: read_only
  navigate_hosts: [${JSON.stringify(host)}]
`),
        ),
      ).toBe("bad_hostname");
    },
  );

  test.each([
    ["plain http", "http://example.com/x"],
    ["a javascript link", "javascript:alert(1)"],
    ["a credential in the address", "https://user:pass@example.com/x"],
  ])(
    "a link shown beside a Bot's name is held to https and a plain host: %s",
    (_name, url) => {
      // Nothing fetches these. They are attacker-controlled text rendered next to a Bot's name while
      // somebody decides whether to trust it, which is the one moment a clickable javascript: or a
      // credential-carrying address would be worth the most.
      expect(
        refusalOf(
          MINIMAL.replace(
            "  summary:",
            `  source: ${JSON.stringify(url)}\n  summary:`,
          ),
        ),
      ).toBe("bad_url");
    },
  );
});

describe("what a template may ask for", () => {
  test("a tool must belong to the connector it is filed under", () => {
    expect(
      refusalOf(
        withRoot(`
requests:
  connectors:
    - id: google-drive
      why: The ledger lives in Drive.
      tools:
        - ref: notion/notion-search
          why: Sneaking this in under a familiar heading.
`),
      ),
    ).toBe("bad_tool_ref");
  });

  test.each([
    [
      "a tool ref wearing a connector's clothes",
      "google-drive/read_file_content",
    ],
    ["a sentence", "Google Drive (connected)"],
    ["upper case", "Google-Drive"],
    ["a single character", "x"],
    ["a trailing hyphen", "google-drive-"],
  ])(
    "a connector id that could never name an MCP server is refused: %s",
    (_name, id) => {
      // With no tools filed under it the per-tool check below never runs, so this id is the whole of
      // what a person is shown and the whole of what is written to the ledger. Nothing downstream
      // tags a request as connector-level or tool-level: both the server and the profile screen ask
      // whether the string contains a slash. This is the only place that shape can be made true.
      expect(
        refusalOf(
          withRoot(`
requests:
  connectors:
    - id: ${JSON.stringify(id)}
      why: Reading the ledger.
`),
        ),
      ).toBe("bad_slug");
    },
  );

  test("an ask is read as an ask, with the author's reason attached", () => {
    const template = parseBotTemplate(
      withRoot(`
requests:
  connectors:
    - id: google-drive
      why: The invoice ledger export lives in Drive.
      tools:
        - ref: google-drive/search_files
          why: Find the ledger for one customer.
  components:
    - name: showBarChart
      why: Ageing buckets.
`),
    );
    expect(template.requests.connectors[0]?.id).toBe("google-drive");
    expect(template.requests.connectors[0]?.tools[0]?.why).toBe(
      "Find the ledger for one customer.",
    );
    expect(template.requests.components[0]?.name).toBe("showBarChart");
  });

  test("a Bot may only be given skills the same file defines", () => {
    expect(
      refusalOf(
        withRoot(`
skills:
  - slug: a-skill
    title: One
    summary: One.
    instructions: One.
`).replace(
          "  runtime: managed",
          "  runtime: managed\n  skills: [somebody-elses-skill]",
        ),
      ),
    ).toBe("unknown_skill");
  });
});

describe("the digest a preview and an install agree on", () => {
  test("does not move when the same document is written differently", async () => {
    const one = parseBotTemplate(MINIMAL);
    const other = parseBotTemplate(`
openbot_template: 1
bot:
  runtime: managed
  role_description: >-
    Chase overdue invoices and draft the follow-up.
  title: Accounts Receivable
  name: Renewal Desk
template:
  summary: Chases overdue invoices.
  slug: renewal-desk
`);
    expect(await botTemplateDigest(one)).toBe(await botTemplateDigest(other));
  });

  test("moves when a single character of anybody's prose changes", async () => {
    const one = parseBotTemplate(MINIMAL);
    const other = parseBotTemplate(
      MINIMAL.replace("Chase overdue", "Chase all overdue"),
    );
    expect(await botTemplateDigest(one)).not.toBe(
      await botTemplateDigest(other),
    );
  });

  test("moves when the category does, so a refiled template is a changed one", async () => {
    // The category is on the card a person browses by, so a document that quietly changed groups
    // between the preview somebody read and the install would be a different document to them.
    const uncategorised = parseBotTemplate(MINIMAL);
    const sales = parseBotTemplate(withCategory("sales"));
    const marketing = parseBotTemplate(withCategory("marketing"));
    expect(await botTemplateDigest(sales)).not.toBe(
      await botTemplateDigest(uncategorised),
    );
    expect(await botTemplateDigest(sales)).not.toBe(
      await botTemplateDigest(marketing),
    );
  });

  test("is stable across Unicode forms, so the digest read is the digest installed", async () => {
    // The same name written two ways: precomposed U+00E9, and e followed by a combining acute. A
    // reviewer sees one string; without normalisation the install would recompute a different digest
    // and refuse a document nobody had changed.
    const composed = parseBotTemplate(
      MINIMAL.replace("Renewal Desk", "Renewal D\u00E9sk"),
    );
    const decomposed = parseBotTemplate(
      MINIMAL.replace("Renewal Desk", "Renewal De\u0301sk"),
    );
    expect(composed.bot.name).toBe(decomposed.bot.name);
    expect(await botTemplateDigest(composed)).toBe(
      await botTemplateDigest(decomposed),
    );
  });

  test("marks a grant with a short form of itself", () => {
    expect(templateGrantMark("abcdef0123456789")).toBe("template:abcdef012345");
  });
});

describe("serialising a template back to a file", () => {
  test("round-trips through parse unchanged", async () => {
    const source = `
openbot_template: 1
template:
  slug: renewal-desk
  version: "1.3"
  author: acme-revops
  source: https://github.com/acme/openbot-templates
  summary: Chases overdue invoices and drafts the follow-up.
  category: sales
  license: Apache-2.0
bot:
  name: Renewal Desk
  title: Accounts Receivable
  role_description: Chase overdue invoices and draft the follow-up.
  avatar_seed: renewal-desk
  runtime: remote
  skills: [check-renewal-risk]
  remote:
    auth_header: Authorization
    requires_key: true
    example_url: https://renewals.example.com/agui
    sends_conversation_to: renewals.example.com
skills:
  - slug: check-renewal-risk
    title: Check renewal risk
    summary: Pull the contract and the recent tickets.
    instructions: Find the contract before answering anything about a renewal.
    tools: [google-drive/search_files]
requests:
  connectors:
    - id: google-drive
      why: The ledger lives in Drive.
      tools:
        - ref: google-drive/search_files
          why: Find the ledger.
  components:
    - name: showBarChart
      why: Ageing buckets.
boundary:
  shell: never
  files: none
  browser: read_only
  navigate_hosts: [billing.acme.example]
  mcp: read_only
notes: Point this at whichever Drive folder holds your contracts.
`;
    const first = parseBotTemplate(source);
    const written = serializeBotTemplate(first);
    const second = parseBotTemplate(written);
    expect(second).toEqual(first);
    expect(await botTemplateDigest(second)).toBe(
      await botTemplateDigest(first),
    );
  });

  test("omits absent optional keys rather than writing them as null", () => {
    const written = serializeBotTemplate(parseBotTemplate(MINIMAL));
    expect(written).not.toContain("null");
    expect(written).not.toContain("category");
    expect(written).not.toContain("license");
    expect(written).not.toContain("remote");
  });

  test("always writes the boundary out, so the author sees the ceiling they are shipping", () => {
    const written = serializeBotTemplate(parseBotTemplate(MINIMAL));
    expect(written).toContain("boundary:");
    expect(written).toContain("shell: never");
  });

  test("what it writes never trips the byte refusals it will be read back through", () => {
    const template: BotTemplate = parseBotTemplate(MINIMAL);
    expect(() =>
      parseBotTemplate(serializeBotTemplate(template)),
    ).not.toThrow();
  });
});
