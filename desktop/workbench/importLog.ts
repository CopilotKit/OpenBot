// The import CLI: makes a workbench scene from an OpenBot Desktop troubleshooting file.
//
//   bun run workbench:import <file> [--start first-run|relaunch] [--session <n>] [--id <id>]
//
// It writes `workbench/scenes/imported/<id>.json`. Git ignores that folder: the files come from
// customers. The scene is approximate (see `logImport.ts`).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultSceneId,
  parseTroubleshooting,
  pickSession,
  toScene,
} from "./logImport";

const USAGE =
  "Usage: bun run workbench:import <file> [--start first-run|relaunch] [--session <n>] [--id <id>]";

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

type Args = {
  file: string;
  start: "first-run" | "relaunch";
  session?: number;
  id?: string;
};

function parseArgs(argv: string[]): Args {
  let file: string | undefined;
  let start: Args["start"] = "first-run";
  let session: number | undefined;
  let id: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? fail(`${arg} needs a value.`);
    if (arg === "--start") {
      const value = next();
      if (value !== "first-run" && value !== "relaunch")
        fail(`--start must be first-run or relaunch, not "${value}".`);
      start = value;
    } else if (arg === "--session") {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 0)
        fail("--session must be a number from 0.");
      session = value;
    } else if (arg === "--id") {
      id = next();
      if (!/^[\w-]+$/.test(id))
        fail("--id can have only letters, digits, - and _.");
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("--")) fail(`Unknown option ${arg}.`);
    else if (file === undefined) file = arg;
    else fail(`One file only. Also got ${arg}.`);
  }
  if (file === undefined) fail("Give the troubleshooting file.");
  return { file, start, session, id };
}

const args = parseArgs(process.argv.slice(2));
let text: string;
try {
  text = readFileSync(args.file, "utf8");
} catch (error) {
  fail(`Could not read ${args.file}: ${(error as Error).message}`);
}

const parsed = parseTroubleshooting(text);
if (args.session !== undefined && args.session >= parsed.sessions.length)
  fail(
    `The log has ${parsed.sessions.length} sessions (0 to ${parsed.sessions.length - 1}). There is no session ${args.session}.`,
  );

console.log(`Sessions in the log (${parsed.sessions.length}):`);
parsed.sessions.forEach((session, index) => {
  console.log(
    `  ${index}: ${session.startedAt ?? "no time"}, ${session.steps.length} setup rows, ${session.problems.length} errors`,
  );
});

const picked = pickSession(parsed, args.session);
const id =
  args.id ??
  defaultSceneId(parsed, { session: args.session, start: args.start });
const scene = toScene(parsed, {
  session: picked?.index,
  start: args.start,
  id,
});

const folder = join(import.meta.dir, "scenes", "imported");
mkdirSync(folder, { recursive: true });
const out = join(folder, `${id}.json`);
writeFileSync(out, `${JSON.stringify(scene, null, 2)}\n`);

const rows = (scene.run ?? []).filter((step) => "emit" in step).length;
console.log(`
Session ${picked?.index ?? "none"}: ${rows} setup rows. ${scene.title}
Scene: ${id}
Written: ${out}
Open (the workbench must be running, "bun run workbench"): http://localhost:3021/workbench/?scene=${id}
Screenshot: bun run workbench:shot ${id}
(The page and the shot CLI show the scene once scenes/index.ts and shot.ts read the imported scenes.)
The scene is approximate: the log has the rows' words and times, not the download bytes.`);
