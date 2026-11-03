import { describe, expect, test } from "bun:test";
import {
  createNeedleChooser,
  NEEDLE_MIN_CONFIDENCE,
  needleIsUp,
  needleToolName,
  needleTools,
  readNeedlePick,
} from "../src/local-ai/needle";
import { type SelectableSkill, selectTools } from "../src/plugins/selection";

const skills: SelectableSkill[] = [
  {
    slug: "email",
    title: "Email",
    summary: "Read and send email.",
    tools: ["mail/list_emails", "mail/send_email"],
  },
  {
    slug: "web-research",
    title: "Web research",
    summary: "Search the web.",
    tools: ["search/web"],
  },
];
const tools = [
  "mail/list_emails",
  "mail/send_email",
  "search/web",
  ...Array.from({ length: 12 }, (_, index) => `other/tool_${index}`),
].map((ref) => ({ ref }));

const answering = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("Needle as pass one", () => {
  test("each skill is a tool Needle can call", () => {
    expect(needleToolName("web-research")).toBe("use_web_research");
    expect(needleTools(skills)[0]).toEqual({
      name: "use_email",
      description: "Email. Read and send email.",
      parameters: { type: "object", properties: {} },
    });
  });

  test("the skills Needle calls are the ones chosen, including ones it held back", () => {
    expect(
      readNeedlePick(
        {
          function_calls: [{ name: "use_email", arguments: {} }],
          suppressed_calls: [{ name: "use_web_research", arguments: {} }],
          confidence: 0.8,
        },
        skills,
      ),
    ).toEqual(["email", "web-research"]);
  });

  test("an unsure, empty or failed answer leaves the choice to the usual chooser", () => {
    const call = [{ name: "use_email", arguments: {} }];
    expect(
      readNeedlePick(
        { function_calls: call, confidence: NEEDLE_MIN_CONFIDENCE - 0.01 },
        skills,
      ),
    ).toBeNull();
    expect(
      readNeedlePick({ function_calls: [], confidence: 0.9 }, skills),
    ).toBeNull();
    expect(readNeedlePick({ error: "boom" }, skills)).toBeNull();
    expect(
      readNeedlePick({ function_calls: [{ name: "use_made_up" }] }, skills),
    ).toBeNull();
  });

  test("an unreachable helper is a quiet null", async () => {
    const down = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(
      await createNeedleChooser("http://127.0.0.1:1", down)(
        "check my email",
        skills,
      ),
    ).toBeNull();
    expect(
      await createNeedleChooser("http://x", answering({}, 500))(
        "check my email",
        skills,
      ),
    ).toBeNull();
    expect(await needleIsUp("http://127.0.0.1:1", down)).toBe(false);
  });

  test("selection uses Needle's pick and never asks the model", async () => {
    let asked = false;
    const chosen = await selectTools({
      tools,
      skills,
      text: "any new email from the bank?",
      choose: async () => {
        asked = true;
        return '{"skills": []}';
      },
      chooseFast: createNeedleChooser(
        "http://needle",
        answering({
          function_calls: [{ name: "use_email", arguments: {} }],
          confidence: 0.9,
        }),
      ),
    });
    expect(asked).toBe(false);
    expect(chosen.reason).toBe("selected");
    expect(chosen.by).toBe("needle");
    expect(chosen.offered.map((tool) => tool.ref)).not.toContain("search/web");
    expect(chosen.offered.map((tool) => tool.ref)).toContain("mail/send_email");
  });

  test("when Needle can't say, the model chooses exactly as before", async () => {
    const chosen = await selectTools({
      tools,
      skills,
      text: "find me a recipe",
      choose: async () => '{"skills": ["web-research"]}',
      chooseFast: async () => null,
    });
    expect(chosen.by).toBeUndefined();
    expect(chosen.skills).toEqual(["web-research"]);
  });

  test("a Needle that throws costs nothing", async () => {
    const chosen = await selectTools({
      tools,
      skills,
      text: "find me a recipe",
      choose: async () => '{"skills": ["web-research"]}',
      chooseFast: async () => {
        throw new Error("down");
      },
    });
    expect(chosen.skills).toEqual(["web-research"]);
  });
});
