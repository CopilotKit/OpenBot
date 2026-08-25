import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlainBotId } from "../src/bot-id";
import { botIdsIn } from "../src/profile-listing";

/**
 * Which directories under the profiles root are Bots.
 *
 * The root is a mounted volume, and a volume is not an empty directory. A real disk formatted ext4
 * arrives with `lost+found` already in it, so on a cloud the fleet page listed a Bot by that name and
 * offered to reset it. Never seen locally, because a bind mount and kind's local-path volumes have no
 * such directory: the bug appears only on the deployment shape the feature is for.
 *
 * The rule is the one that already exists. `isPlainBotId` decides what may become a profile path, so
 * an entry it would refuse to create is not one of ours to list.
 */
async function knownIn(root: string): Promise<string[]> {
  const onDisk = await readdir(root, { withFileTypes: true }).catch(() => []);
  /*
   * THE SHIPPED PREDICATE, imported rather than restated.
   *
   * This test used to carry its own copy of the filter, which meant it proved the copy rather than
   * the product: deleting the real one left the suite green and the fleet page listing `lost+found`
   * as a Bot again.
   */
  return botIdsIn(onDisk);
}

describe("listing the Bots that have a computer", () => {
  test("lists Bot profiles and ignores what the filesystem put there", async () => {
    const root = await mkdtemp(join(tmpdir(), "profiles-"));
    await mkdir(join(root, "knowledge"));
    await mkdir(join(root, "risk-analyst"));
    // What an ext4 volume brings with it, which is the whole reason this test exists.
    await mkdir(join(root, "lost+found"));
    // A file is not a computer either.
    await writeFile(join(root, "notes.txt"), "");

    expect(await knownIn(root)).toEqual(["knowledge", "risk-analyst"]);
  });

  test("the name a real volume arrives with is not a usable Bot id", () => {
    // Stated directly, because this is the property the filter leans on.
    expect(isPlainBotId("lost+found")).toBe(false);
    expect(isPlainBotId("knowledge")).toBe(true);
  });
});
