import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import type { LearnedSkillsSnapshotResult } from "@copilotkit/runtime/v2";

/**
 * A published learned-skills snapshot holding the named Skills, built the way Intelligence builds one: a ZIP with a
 * `manifest.json` and a `<name>/SKILL.md` per Skill, the manifest naming each file's size and SHA-256, and the ETag the
 * archive's SHA-256. Stored rather than deflated, which the SDK reads the same way. For tests that need Skills with
 * chosen names; `learned-skills.ts` holds the fixed pair the older tests use.
 */
export function skillArchive(
  revision: string,
  skills: readonly { name: string; description?: string; body?: string }[],
): LearnedSkillsSnapshotResult {
  const sorted = [...skills].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
  );
  const files: { path: string; bytes: Buffer }[] = [];
  const manifest = {
    schemaVersion: 1,
    revision,
    skills: sorted.map((skill) => {
      const bytes = Buffer.from(
        skill.body ?? `# ${skill.name}\n\nGuidance for ${skill.name}.\n`,
      );
      files.push({ path: `${skill.name}/SKILL.md`, bytes });
      return {
        name: skill.name,
        description: skill.description ?? `What ${skill.name} does.`,
        files: [
          {
            path: "SKILL.md",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      };
    }),
  };
  files.unshift({
    path: "manifest.json",
    bytes: Buffer.from(JSON.stringify(manifest)),
  });
  const bytes = zip(files);
  return {
    status: "snapshot",
    bytes: Uint8Array.from(bytes),
    revision,
    etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
    contentType: "application/zip",
  };
}

/** A minimal stored ZIP: one local header per file, then the central directory and its end record. */
function zip(files: readonly { path: string; bytes: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    const crc = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, file.bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + file.bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
