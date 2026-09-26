import { describe, expect, test } from "bun:test";
import {
  APPROVAL_LEVELS,
  DEFAULT_APPROVAL_LEVEL,
  DEFAULT_RISKY_PATTERNS,
  decide,
  isApprovalLevel,
  readApprovalConfig,
} from "./approval-levels";

describe("approval levels", () => {
  describe("isApprovalLevel", () => {
    test("accepts the three levels and nothing else", () => {
      for (const level of APPROVAL_LEVELS) {
        expect(isApprovalLevel(level)).toBe(true);
      }
      expect(isApprovalLevel("confirm")).toBe(false);
      expect(isApprovalLevel("")).toBe(false);
      expect(isApprovalLevel(null)).toBe(false);
      expect(isApprovalLevel(3)).toBe(false);
    });
  });

  describe("readApprovalConfig", () => {
    test("defaults when the configuration says nothing", () => {
      const config = readApprovalConfig({});
      expect(config.approvalLevel).toBe(DEFAULT_APPROVAL_LEVEL);
      expect(config.riskyPatterns).toEqual(DEFAULT_RISKY_PATTERNS);
    });

    test("defaults on junk: null, a string, a bad level, junk patterns", () => {
      expect(readApprovalConfig(null).approvalLevel).toBe("confirm-risky");
      expect(readApprovalConfig("autonomous").approvalLevel).toBe(
        "confirm-risky",
      );
      const bad = readApprovalConfig({ approvalLevel: "yolo" });
      expect(bad.approvalLevel).toBe(DEFAULT_APPROVAL_LEVEL);
      const junkPatterns = readApprovalConfig({ riskyPatterns: [1, "", "  "] });
      expect(junkPatterns.riskyPatterns).toEqual(DEFAULT_RISKY_PATTERNS);
    });

    test("reads a stored level and patterns", () => {
      const config = readApprovalConfig({
        approval: { approvalLevel: "autonomous", riskyPatterns: ["purge"] },
      });
      expect(config.approvalLevel).toBe("autonomous");
      expect(config.riskyPatterns).toEqual(["purge"]);
    });

    test("drops non-string patterns but keeps real ones", () => {
      const config = readApprovalConfig({
        approvalLevel: "confirm-risky",
        riskyPatterns: ["send", 42, null, "buy"],
      });
      expect(config.riskyPatterns).toEqual(["send", "buy"]);
    });
  });

  describe("decide", () => {
    test("autonomous allows everything", () => {
      for (const ref of ["slack/send_message", "drive/delete_file", "x/post"]) {
        expect(decide(ref, "autonomous").action).toBe("allow");
      }
    });

    test("confirm-all asks for everything", () => {
      const decision = decide("drive/list_files", "confirm-all");
      expect(decision.action).toBe("ask");
      expect(decision.matched).toBeUndefined();
      expect(decision.reason).toContain("confirm every tool call");
    });

    test("confirm-risky asks only when a pattern matches the tool name", () => {
      const risky = decide("slack/send_message", "confirm-risky");
      expect(risky.action).toBe("ask");
      expect(risky.matched).toBe("send");

      const safe = decide("drive/list_files", "confirm-risky");
      expect(safe.action).toBe("allow");
      expect(safe.matched).toBeUndefined();
    });

    test("confirm-risky matches the tool name, not the server id", () => {
      expect(decide("post/list_servers", "confirm-risky").action).toBe("allow");
      expect(decide("post/create_draft", "confirm-risky").action).toBe("ask");
    });

    test("matching is case-insensitive on both sides", () => {
      expect(decide("slack/Send_Message", "confirm-risky").matched).toBe(
        "send",
      );
      expect(
        decide("slack/send_message", "confirm-risky", ["SEND"]).action,
      ).toBe("ask");
    });

    test("custom patterns are honoured", () => {
      expect(decide("db/purge_cache", "confirm-risky", ["purge"]).action).toBe(
        "ask",
      );
      expect(decide("db/purge_cache", "confirm-risky").action).toBe("allow");
    });

    test("an unknown level fails closed and asks", () => {
      const decision = decide("slack/send_message", "whenever" as never);
      expect(decision.action).toBe("ask");
    });

    test("a tool name with a slash in it is matched whole", () => {
      expect(decide("wiki/blogs/post_comment", "confirm-risky").action).toBe(
        "ask",
      );
    });
  });
});
