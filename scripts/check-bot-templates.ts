/**
 * Every template shipped in the box parses, and none of them collides with the deployment it lands
 * on.
 *
 * A template is the one file in this repository that is *written to be given to somebody else's
 * deployment*, so it is the one file whose mistakes are not the author's to notice. Nothing else in
 * the build reads these: they are data copied into the image, so a broken one compiles, ships, and
 * is refused for the first time on a stranger's machine at the moment they try to install it. This
 * runs in CI so the refusal happens here instead, where somebody is looking.
 *
 * The hostile-input refusals are NOT repeated here. The environment-reference sequence, the
 * invisible codepoints, the size ceilings and the endpoint and credential key names are all refused
 * by `parseBotTemplate`, against the raw bytes, before it looks at the document — so calling the
 * parser is what asserts them, and asserting them a second time in this file would create a second
 * copy to drift from. The same function runs at preview and again at install; that is the point of
 * it being pure.
 *
 * What is left for this script is everything the parser deliberately cannot know, because nothing in
 * `shared/bot-template.ts` reads the disk: whether the file is named after the template inside it,
 * whether the ask on the consent screen is the same set of tools the skills actually declare, and
 * whether a skill slug is one the tenant package already seeds. That last one is not hypothetical.
 * `TENANT_PACKAGE_DIR` defaults to `../examples/fintech`, whose `skills.yaml` is seeded at every
 * boot as ownerless deployment skills, so a flagship template reusing one of those slugs would
 * collide on a stock install — and collision resolution is first-taker-keeps, which means the
 * template's own instructions are silently the ones NOT used.
 *
 *     bun scripts/check-bot-templates.ts [directory]
 */
import { parse } from "yaml";
import {
  type BotTemplate,
  parseBotTemplate,
  TemplateRefusedError,
} from "../shared/bot-template";

const directory = process.argv[2] ?? "examples/templates";

const problems: string[] = [];

/**
 * The slugs a deployment already has before any template arrives.
 *
 * Every `skills.yaml` under `examples/`, not only the default package's, because which directory
 * `TENANT_PACKAGE_DIR` points at is an operator's choice and a template is supposed to be
 * installable on all of them. The file it came from is carried along so the failure names it.
 */
const packageSlugs = new Map<string, string>();
for await (const file of new Bun.Glob("examples/*/skills.yaml").scan(".")) {
  const document = parse(await Bun.file(file).text()) as {
    skills?: Array<{ slug?: unknown }>;
  } | null;
  for (const skill of document?.skills ?? []) {
    if (typeof skill.slug === "string") packageSlugs.set(skill.slug, file);
  }
}

/*
 * A directory that is not there is the same failure as one with nothing in it, and gets the same
 * sentence below. Left to throw, a rename nobody followed reports itself as a stack trace out of a
 * glob, which reads like a broken script rather than like the answer to the question this asks.
 */
let files: string[] = [];
try {
  files = [...new Bun.Glob("*.{yaml,yml}").scanSync({ cwd: directory })].sort();
} catch {
  files = [];
}

/*
 * A check that finds nothing is not a check that passed.
 *
 * This directory is what the image ships, so an empty one is either a rename nobody followed or a
 * glob that has quietly stopped matching. Either way the green tick would mean "I looked at
 * nothing", which is worse than no check at all because somebody trusts it.
 */
if (files.length === 0) {
  console.error(
    `::error::No templates found in ${directory}. This check is meant to have files to check.`,
  );
  process.exit(1);
}

for (const name of files) {
  const path = `${directory}/${name}`;
  let template: BotTemplate;
  try {
    template = parseBotTemplate(await Bun.file(path).text());
  } catch (error) {
    /*
     * The refusal code as well as the sentence. The sentence is written for the person importing a
     * stranger's file and says what is wrong; the code is what a reader of this log greps for when
     * the same class of mistake turns up twice.
     */
    const why =
      error instanceof TemplateRefusedError
        ? `${error.reason}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    problems.push(`${path} does not parse. ${why}`);
    continue;
  }

  /*
   * The file is named after the template inside it.
   *
   * `template.slug` names the file and nothing else — it is not an id and nothing installs under it
   * — so the two drifting apart costs nothing at runtime and everything to a reviewer, who reads a
   * pull request as a list of filenames and would be told the wrong thing about what changed.
   */
  const expected = `${template.template.slug}.openbot.yaml`;
  if (name !== expected) {
    problems.push(
      `${path} declares template.slug "${template.template.slug}", so the file should be named ${expected}.`,
    );
  }

  for (const skill of template.skills) {
    const seededIn = packageSlugs.get(skill.slug);
    if (seededIn) {
      problems.push(
        `${path} defines the skill "${skill.slug}", which ${seededIn} already seeds at every boot. On a stock install the import would keep the seeded skill and the template's own instructions would never be used. Rename it.`,
      );
    }
  }

  /*
   * The ask and the declarations are the same set of tools.
   *
   * These are two different things and both are shown to the importer: `skills[].tools` is what the
   * per-run selector narrows to, and `requests.connectors[].tools[]` is what the consent screen
   * renders with the author's reason beside it. A ref in the first and not the second is a
   * capability the Bot will quietly want and nobody was asked for; a ref in the second and not the
   * first is a reason to grant something no skill will ever use, which is how a consent screen
   * teaches people to click through it.
   */
  const declared = new Set(template.skills.flatMap((skill) => skill.tools));
  const asked = new Set(
    template.requests.connectors.flatMap((connector) =>
      connector.tools.map((tool) => tool.ref),
    ),
  );
  for (const ref of declared) {
    if (!asked.has(ref)) {
      problems.push(
        `${path} declares the tool "${ref}" on a skill but never asks for it under requests.connectors, so the consent screen would not mention it.`,
      );
    }
  }
  for (const ref of asked) {
    if (!declared.has(ref)) {
      problems.push(
        `${path} asks for the tool "${ref}" but no skill in it declares that tool, so granting it would give the Bot something nothing uses.`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

const counted = `${files.length} template${files.length === 1 ? "" : "s"}`;
console.log(
  `Checked ${counted} in ${directory}: every one parses, is named after itself, asks for exactly what its skills declare, and reuses none of the ${packageSlugs.size} slugs the example packages seed.`,
);
