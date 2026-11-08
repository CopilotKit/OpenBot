/**
 * staple-with-retry.sh, run against a stand-in for `xcrun` that answers each call with what
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
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const script = join(import.meta.dir, "staple-with-retry.sh");
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
  const dir = mkdtempSync(join(tmpdir(), "staple-with-retry-"));
  temps.push(dir);
  answers.forEach((answer, i) => {
    const { code, out } = stapler(action, answer, file);
    writeFileSync(join(dir, `answer-${i + 1}.out`), out);
    writeFileSync(join(dir, `answer-${i + 1}.code`), String(code));
  });
  const fake = join(dir, "xcrun");
  writeFileSync(
    fake,
    [
      "#!/usr/bin/env bash",
      `dir=${JSON.stringify(dir)}`,
      'printf \'%s\\n\' "$*" >> "$dir/calls"',
      'n=$(wc -l < "$dir/calls" | tr -d " ")',
      '[ -f "$dir/answer-$n.code" ] || { echo "unexpected call $n: $*" >&2; exit 99; }',
      'cat "$dir/answer-$n.out"',
      'exit "$(cat "$dir/answer-$n.code")"',
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  const result = Bun.spawnSync(["bash", script, file, String(attempts)], {
    env: {
      ...process.env,
      XCRUN: fake,
      STAPLER_ACTION: action,
      STAPLE_RETRY_DELAY: String(delay),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  } catch {}
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
    calls,
  };
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
