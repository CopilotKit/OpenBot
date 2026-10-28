import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlainBotId, seatIdFor } from "../src/bot-id";
import { carryOverProfile } from "../src/carry-over";
import { seatIdsIn } from "../src/profile-listing";

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
  return seatIdsIn(onDisk);
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

describe("listing seats on a computer many people share", () => {
  test("each person's seat on a Bot is listed, and the work folders are not", async () => {
    const root = await mkdtemp(join(tmpdir(), "profiles-"));
    await mkdir(join(root, seatIdFor("sales", "ada")));
    await mkdir(join(root, seatIdFor("sales", "bo")));
    // The Bot's profile from before seats were per person, which is still a seat of its own.
    await mkdir(join(root, "sales"));
    // A move in flight and the control store's folder are not seats.
    await mkdir(join(root, ".control"));
    await mkdir(join(root, "ada~bo~sales"));

    expect(await knownIn(root)).toEqual(["ada~sales", "bo~sales", "sales"]);
  });
});

/**
 * Moving a private Bot's old profile to its owner's seat, once.
 *
 * The regression this pins is two-sided. Not moving it signs a private Bot's owner out of everything
 * on upgrade, for no reason: that profile only ever had one user. Moving it twice, or over a seat the
 * owner has used since, would throw away their newer logins.
 */
describe("carrying a private Bot's profile over to its owner", () => {
  async function rootWithOldProfile() {
    const root = await mkdtemp(join(tmpdir(), "profiles-"));
    await mkdir(join(root, "notes-bot", "Default"), { recursive: true });
    await writeFile(
      join(root, "notes-bot", "Default", "Cookies"),
      "ada's login",
    );
    return root;
  }

  test("moves it, closing the old browser first, and only once", async () => {
    const root = await rootWithOldProfile();
    const seat = seatIdFor("notes-bot", "ada");
    const closed: string[] = [];
    const close = async () => {
      closed.push("notes-bot");
    };

    expect(await carryOverProfile(root, "notes-bot", seat, close)).toBe(
      "moved",
    );
    expect(closed).toEqual(["notes-bot"]);
    expect(await readFile(join(root, seat, "Default", "Cookies"), "utf8")).toBe(
      "ada's login",
    );
    expect(await knownIn(root)).toEqual([seat]);

    // The second time the seat already has it, so nothing moves and nothing is closed.
    expect(await carryOverProfile(root, "notes-bot", seat, close)).toBe("kept");
    expect(closed).toEqual(["notes-bot"]);
  });

  test("keeps the seat's own profile when the owner has used the Bot since", async () => {
    const root = await rootWithOldProfile();
    const seat = seatIdFor("notes-bot", "ada");
    await mkdir(join(root, seat, "Default"), { recursive: true });
    await writeFile(join(root, seat, "Default", "Cookies"), "a newer login");

    expect(
      await carryOverProfile(root, "notes-bot", seat, async () => {}),
    ).toBe("kept");
    expect(await readFile(join(root, seat, "Default", "Cookies"), "utf8")).toBe(
      "a newer login",
    );
    // The old one is left where it was, not deleted.
    expect(await knownIn(root)).toEqual([seat, "notes-bot"]);
  });

  test("a seat that is the Bot itself has nothing to inherit", async () => {
    const root = await rootWithOldProfile();
    expect(
      await carryOverProfile(root, "notes-bot", "notes-bot", async () => {}),
    ).toBe("absent");
    expect(await knownIn(root)).toEqual(["notes-bot"]);
  });
});
