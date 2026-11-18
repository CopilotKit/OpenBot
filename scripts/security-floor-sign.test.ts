import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { verifySecurityFloor } from "../shared/security-floor";
import { nextFloor, publicKeyOf, signFloor } from "./security-floor-sign";

function testKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

const first = nextFloor({
  floors: { desktop: "1.1.2", backend: "v1.1.2" },
  latestRelease: "v1.1.2",
  previous: null,
});

describe("signing a security floor", () => {
  test("what it signs, the apps verify, and nothing signed with another key", async () => {
    const pem = testKey();
    const text = JSON.stringify(signFloor(first, pem));
    const verified = await verifySecurityFloor(text, [publicKeyOf(pem)]);
    expect(verified.ok && verified.floor).toEqual({
      serial: 1,
      issued: first.issued,
      floors: { desktop: "1.1.2", backend: "1.1.2" },
      cloud: [],
    });
    expect((await verifySecurityFloor(text, [publicKeyOf(testKey())])).ok).toBe(
      false,
    );
  });

  test("each floor raises the serial and keeps what it doesn't change", () => {
    const next = nextFloor({
      floors: { mobile: "1.1.3" },
      cloud: ["https://cloud.openbot.example"],
      latestRelease: "1.1.3",
      previous: first,
    });
    expect(next.serial).toBe(2);
    expect(next.floors).toEqual({
      desktop: "1.1.2",
      backend: "1.1.2",
      mobile: "1.1.3",
    });
    expect(next.cloud).toEqual(["https://cloud.openbot.example"]);
  });

  test("a floor above the Latest release is refused: nobody could update past it", () => {
    expect(() =>
      nextFloor({
        floors: { desktop: "1.2.0" },
        latestRelease: "v1.1.2",
        previous: first,
      }),
    ).toThrow(/above the Latest release/);
  });

  test("lowering a floor takes FLOOR_LOWER", () => {
    expect(() =>
      nextFloor({
        floors: { desktop: "1.1.1" },
        latestRelease: "v1.1.2",
        previous: first,
      }),
    ).toThrow(/FLOOR_LOWER/);
    expect(
      nextFloor({
        floors: { desktop: "1.1.1" },
        lower: true,
        latestRelease: "v1.1.2",
        previous: first,
      }).floors.desktop,
    ).toBe("1.1.1");
  });

  test("a cloud address must be an https origin", () => {
    expect(() =>
      nextFloor({
        floors: {},
        cloud: ["http://cloud.example"],
        latestRelease: "1.1.2",
        previous: first,
      }),
    ).toThrow(/https origin/);
  });
});
