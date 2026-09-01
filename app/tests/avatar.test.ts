import { describe, expect, test } from "bun:test";
import { avatarFileError, MAX_AVATAR_BYTES } from "@/lib/avatar";

describe("avatar file selection", () => {
  test.each(["image/png", "image/jpeg", "image/webp"])(
    "accepts %s within the upload limit",
    (type) => {
      expect(avatarFileError({ size: MAX_AVATAR_BYTES, type })).toBeNull();
    },
  );

  test("rejects executable, empty, and oversized files before upload", () => {
    expect(avatarFileError({ size: 10, type: "image/svg+xml" })).toContain(
      "PNG",
    );
    expect(avatarFileError({ size: 0, type: "image/png" })).toContain("empty");
    expect(
      avatarFileError({ size: MAX_AVATAR_BYTES + 1, type: "image/png" }),
    ).toContain("2 MB");
  });
});
