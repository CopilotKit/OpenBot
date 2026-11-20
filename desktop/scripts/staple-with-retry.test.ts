/**
 * staple-with-retry.sh, and the xcrun that sends Tauri's own staple of the .app through it
 * (xcrun-staple-retry/xcrun), run against a stand-in for `xcrun` that answers each call with what
 * stapler really printed and returned: the dropped CloudKit connection that failed v0.3.3's
 * signing run three times (exit 68, from that run's log), and, from stapler on a Mac, a file with
 * no ticket (65) and a file that is not there (66).
 *
 * A dropped connection is tried again; Apple's answer is not. Needs only bash, so it runs in
 * Desktop macOS signing's checks with no Apple access.
 */
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const script = join(import.meta.dir, "staple-with-retry.sh");
const shimDir = join(import.meta.dir, "xcrun-staple-retry");
const root = join(import.meta.dir, "../..");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type Action = "staple" | "validate";
type Answer = "worked" | "connection lost" | "no ticket" | "no file";

const actionName = { staple: "staple and validate", validate: "validate" };

/** What `xcrun stapler <action> <file>` prints (all of it on stdout) and exits with. */
function stapler(action: Action, answer: Answer, file: string) {
  const name = basename(file);
  switch (answer) {
    case "worked":
      return {
        code: 0,
        out: `Processing: ${file}\nThe ${actionName[action]} action worked!\n`,
      };
    case "connection lost":
      return {
        code: 68,
        out:
          `Processing: ${file}\n` +
          'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." UserInfo={_kCFStreamErrorCodeKey=-4, NSUnderlyingError=0x600002948b40 {Error Domain=kCFErrorDomainCFNetwork Code=-1005 "(null)" UserInfo={_kCFStreamErrorCodeKey=-4, _kCFStreamErrorDomainKey=4}}, NSLocalizedDescription=The network connection was lost., NSErrorFailingURLStringKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup, NSErrorFailingURLKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup, _kCFStreamErrorDomainKey=4}\n' +
          "CloudKit's response is inconsistent with expections: (null)\n" +
          `The ${actionName[action]} action failed! Error 68.\n`,
      };
    case "no ticket":
      // Validating reads the ticket stapled to the file; stapling asks CloudKit for one.
      return action === "validate"
        ? {
            code: 65,
            out: `Processing: ${file}\n${name} does not have a ticket stapled to it.\n`,
          }
        : {
            code: 65,
            out:
              `Processing: ${file}\n` +
              `CloudKit query for ${name} (2/057463d555919acb8076228b49a929c016971c62) failed due to "Record not found".\n` +
              "Could not find base64 encoded ticket in response for 2/057463d555919acb8076228b49a929c016971c62\n" +
              "The staple and validate action failed! Error 65.\n",
          };
    case "no file":
      return {
        code: 66,
        out: `File ${file} does not exist. Error Domain=NSCocoaErrorDomain Code=260 "The file “${name}” couldn’t be opened because there is no such file." UserInfo={NSFilePath=${file}, NSUnderlyingError=0x10303b090 {Error Domain=NSPOSIXErrorDomain Code=2 "No such file or directory"}}\n`,
      };
  }
}

/** What `xcrun notarytool submit --output-format json --wait` prints for an accepted app. */
const notarized = {
  code: 0,
  out: '{"id":"ff7d14df-f2e5-4917-aec5-ccd15cd619e5","message":"Processing complete","status":"Accepted"}\n',
};

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "staple-with-retry-"));
  temps.push(dir);
  return dir;
}

/** An executable bash script at `path`. */
function executable(path: string, lines: string[]) {
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(path, 0o755);
}

/**
 * A stand-in xcrun that gives `answers` in order, one per call, and records each call's arguments.
 */
function fakeXcrun(answers: { code: number; out: string }[]) {
  const dir = temp();
  answers.forEach(({ code, out }, i) => {
    writeFileSync(join(dir, `answer-${i + 1}.out`), out);
    writeFileSync(join(dir, `answer-${i + 1}.code`), String(code));
  });
  const path = join(dir, "xcrun");
  executable(path, [
    `dir=${JSON.stringify(dir)}`,
    'printf \'%s\\n\' "$*" >> "$dir/calls"',
    'n=$(wc -l < "$dir/calls" | tr -d " ")',
    '[ -f "$dir/answer-$n.code" ] || { echo "unexpected call $n: $*" >&2; exit 99; }',
    'cat "$dir/answer-$n.out"',
    'exit "$(cat "$dir/answer-$n.code")"',
  ]);
  return {
    path,
    calls(): string[] {
      try {
        return readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
  };
}

function spawn(cmd: string[], env: Record<string, string>, cwd?: string) {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, STAPLE_RETRY_DELAY: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

/**
 * Runs the script with a stand-in xcrun that gives `answers` in order, one per call, and reports
 * what the script exited with, printed, and asked xcrun.
 */
function run(
  action: Action,
  file: string,
  answers: Answer[],
  { attempts = 5, delay = 0 } = {},
) {
  const xcrun = fakeXcrun(
    answers.map((answer) => stapler(action, answer, file)),
  );
  const result = spawn(["bash", script, file, String(attempts)], {
    XCRUN: xcrun.path,
    STAPLER_ACTION: action,
    STAPLE_RETRY_DELAY: String(delay),
  });
  return { ...result, calls: xcrun.calls() };
}

const app = "desktop/src-tauri/target/release/bundle/macos/OpenBot.app";
const image =
  "desktop/src-tauri/target/release/bundle/dmg/OpenBot_0.3.3_aarch64.dmg";

test("validating tries a dropped CloudKit connection again, and passes once it holds", () => {
  const result = run("validate", app, [
    "connection lost",
    "connection lost",
    "worked",
  ]);
  expect(result.code).toBe(0);
  expect(result.calls).toEqual(Array(3).fill(`stapler validate ${app}`));
  expect(result.out).toContain("The validate action worked!");
});

test("stapling tries a dropped CloudKit connection again, waiting longer each time", () => {
  const result = run(
    "staple",
    image,
    ["connection lost", "connection lost", "worked"],
    { delay: 1 },
  );
  expect(result.code).toBe(0);
  expect(result.calls).toEqual(Array(3).fill(`stapler staple ${image}`));
  expect(result.out).toContain("trying again in 1s");
  expect(result.out).toContain("trying again in 2s");
});

test("a connection that keeps dropping fails after the last attempt, with stapler's code", () => {
  const result = run(
    "validate",
    app,
    ["connection lost", "connection lost", "connection lost"],
    { attempts: 3 },
  );
  expect(result.code).toBe(68);
  expect(result.calls).toHaveLength(3);
});

// An ad-hoc build, or one whose image was never notarized, carries no ticket. That is Apple's
// answer, and asking again would only delay the failure.
test("validating a file with no ticket fails at once, with stapler's code", () => {
  const result = run("validate", app, ["no ticket", "worked"]);
  expect(result.code).toBe(65);
  expect(result.calls).toEqual([`stapler validate ${app}`]);
  expect(result.out).toContain(
    "OpenBot.app does not have a ticket stapled to it.",
  );
});

test("stapling a file Apple has no ticket for fails at once, with stapler's code", () => {
  const result = run("staple", image, ["no ticket", "worked"]);
  expect(result.code).toBe(65);
  expect(result.calls).toEqual([`stapler staple ${image}`]);
  expect(result.out).toContain('failed due to "Record not found"');
});

test("a file that is not there fails at once, with stapler's code", () => {
  const result = run("validate", app, ["no file", "worked"]);
  expect(result.code).toBe(66);
  expect(result.calls).toHaveLength(1);
});

type Workflow = {
  jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
};

/** The signing job's build step, as Desktop macOS signing runs it. */
function buildStep() {
  const workflow = Bun.YAML.parse(
    readFileSync(
      join(root, ".github/workflows/desktop-macos-signing.yml"),
      "utf8",
    ),
  ) as Workflow;
  const run = workflow.jobs.sign?.steps?.find(
    (step) => step.name === "Build, sign and notarize",
  )?.run;
  if (!run) throw new Error("The signing job has no build step.");
  return run;
}

// Tauri notarizes the .app, staples it, ignores what stapler returns, and builds the disk image and
// the updater archive from that .app straight after (notarize_inner and staple_app in
// tauri-macos-sign, Tauri CLI 2.11). The stand-in for `bun desktop/scripts/signed-build.ts` makes
// those two xcrun calls the same way, from the bundle folder, and discards the staple's output.
test("the signing build staples Tauri's .app through the retry, before the image and archive are made", () => {
  const work = temp();
  const bundle = join(work, "bundle/macos");
  mkdirSync(join(bundle, "OpenBot.app"), { recursive: true });
  const xcrun = fakeXcrun([
    notarized,
    stapler("staple", "connection lost", "OpenBot.app"),
    stapler("staple", "connection lost", "OpenBot.app"),
    stapler("staple", "worked", "OpenBot.app"),
  ]);
  const bin = join(work, "bin");
  mkdirSync(bin);
  executable(join(bin, "bun"), [
    `printf '%s\\n' "$*" > ${JSON.stringify(join(work, "bun-args"))}`,
    `cd ${JSON.stringify(bundle)} || exit 1`,
    `xcrun notarytool submit OpenBot.zip --output-format json --wait > ${JSON.stringify(join(work, "notarytool.json"))} || exit 1`,
    "xcrun stapler staple -v OpenBot.app > /dev/null 2>&1",
    "exit 0",
  ]);
  // Any xcrun the build reaches without the retry, the real one included, is this one.
  const unwrapped = join(work, "unwrapped");
  mkdirSync(unwrapped);
  executable(join(unwrapped, "xcrun"), [
    'echo "xcrun $* reached the build without the retry." >&2',
    "exit 1",
  ]);
  const result = spawn(
    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", buildStep()],
    {
      PATH: `${bin}:${unwrapped}:/usr/bin:/bin`,
      ARCH: "arm64",
      RUNNER_TEMP: work,
      REAL_XCRUN: xcrun.path,
    },
    root,
  );
  expect(result.out).not.toContain("without the retry");
  expect(result.code).toBe(0);
  expect(readFileSync(join(work, "bun-args"), "utf8")).toStartWith(
    "desktop/scripts/signed-build.ts darwin arm64 src-tauri/tauri.macos-signing.conf.json",
  );
  expect(xcrun.calls()).toEqual([
    "notarytool submit OpenBot.zip --output-format json --wait",
    ...Array(3).fill("stapler staple OpenBot.app"),
  ]);
  // notarytool's answer reaches Tauri unchanged; Tauri reads its JSON.
  expect(readFileSync(join(work, "notarytool.json"), "utf8")).toBe(
    notarized.out,
  );
  // The step shows the staple Tauri does not print.
  expect(result.out).toContain(
    "Stapling lost the connection to Apple (attempt 1 of 5)",
  );
  expect(result.out).toContain("The staple and validate action worked!");
});

test("Tauri's staple of an app Apple has no ticket for fails at once, with stapler's code", () => {
  const log = join(temp(), "staple.log");
  const xcrun = fakeXcrun([
    stapler("staple", "no ticket", "OpenBot.app"),
    stapler("staple", "worked", "OpenBot.app"),
  ]);
  const result = spawn(
    [join(shimDir, "xcrun"), "stapler", "staple", "-v", "OpenBot.app"],
    { REAL_XCRUN: xcrun.path, STAPLE_LOG: log },
  );
  expect(result.code).toBe(65);
  expect(xcrun.calls()).toEqual(["stapler staple OpenBot.app"]);
  expect(readFileSync(log, "utf8")).toContain(
    'failed due to "Record not found"',
  );
});

test("every other xcrun call reaches the real xcrun as it was, with its output and exit code", () => {
  const cases: { args: string[]; answer: { code: number; out: string } }[] = [
    {
      args: [
        "notarytool",
        "submit",
        "OpenBot.zip",
        "--output-format",
        "json",
        "--wait",
        "--key",
        "AuthKey.p8",
        "--key-id",
        "KEY",
        "--issuer",
        "ISSUER",
      ],
      answer: notarized,
    },
    {
      args: ["--sdk", "macosx", "--show-sdk-path"],
      answer: {
        code: 0,
        out: "/Applications/Xcode_16.4.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk\n",
      },
    },
    {
      args: ["stapler", "validate", "OpenBot.app"],
      answer: stapler("validate", "no ticket", "OpenBot.app"),
    },
  ];
  for (const { args, answer } of cases) {
    const xcrun = fakeXcrun([answer, answer]);
    const result = spawn([join(shimDir, "xcrun"), ...args], {
      REAL_XCRUN: xcrun.path,
    });
    expect(xcrun.calls()).toEqual([args.join(" ")]);
    expect(result.stdout).toBe(answer.out);
    expect(result.code).toBe(answer.code);
  }
});
