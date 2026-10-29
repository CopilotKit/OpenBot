import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/*
 * Found in review: the skin's controls moved for people who asked their system for less motion.
 * Every class list in the skin that animates (a transition, a press that scales, a spin or pulse)
 * has to say what happens under `motion-reduce:` in the same list, so a new one cannot slip in
 * without it. The orb is OpenBot's `AgentOrb`, which reads the same preference itself.
 */

const folder = new URL("../src/skins/openduet/", import.meta.url);

const MOVES =
  /\b(transition(?:-[a-z]+)?|animate-[a-z-]+|active:scale-[\d.[\]]+)\b/;

test("every animated class list in the OpenDuet skin also says what reduced motion does", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(folder).filter((name) =>
    name.endsWith(".tsx"),
  )) {
    const source = readFileSync(new URL(file, folder), "utf8");
    for (const [literal] of source.matchAll(/"[^"\n]*"/g)) {
      if (MOVES.test(literal) && !literal.includes("motion-reduce:"))
        offenders.push(`${file}: ${literal.slice(0, 80)}`);
    }
  }
  expect(offenders).toEqual([]);
});
