import { describe, expect, test } from "bun:test";
import {
  ENTERPRISE_DAYS_ERROR,
  parseEnterpriseActionsLimit,
  parseEnterpriseDays,
} from "../src/admin/routes";
import { PAGE_LIMIT_ERROR } from "../src/paging";

/**
 * The two paged enterprise GETs, held to the same strict rule as every other list.
 *
 * `GET /models/usage?days=` used `Number(raw) || 30`, so `?days=abc`, `?days=12abc`
 * and `?days=` all quietly returned the 30-day view while `?days=3.9` averaged a
 * fractional window. `GET /actions?limit=` did the same with its 100-row default,
 * where the audit, channel and people lists already answer 400 through `parsePageLimit`.
 */

describe("parseEnterpriseDays", () => {
  test("absent or blank means the 30-day default", () => {
    expect(parseEnterpriseDays(null)).toEqual({ ok: true, days: 30 });
    expect(parseEnterpriseDays("")).toEqual({ ok: true, days: 30 });
    expect(parseEnterpriseDays("   ")).toEqual({ ok: true, days: 30 });
  });

  test("a plain integer is clamped into 1..365 like the store enforces", () => {
    expect(parseEnterpriseDays("7")).toEqual({ ok: true, days: 7 });
    expect(parseEnterpriseDays(" 30 ")).toEqual({ ok: true, days: 30 });
    expect(parseEnterpriseDays("0")).toEqual({ ok: true, days: 1 });
    expect(parseEnterpriseDays("9999")).toEqual({ ok: true, days: 365 });
  });

  test("anything that is not digits is a 400, not a silent default", () => {
    for (const raw of ["abc", "12abc", "3.9", "-5", "0x10", "30days"]) {
      expect(parseEnterpriseDays(raw)).toEqual({
        ok: false,
        error: ENTERPRISE_DAYS_ERROR,
      });
    }
  });
});

describe("parseEnterpriseActionsLimit", () => {
  test("absent or blank means the 100-row default", () => {
    expect(parseEnterpriseActionsLimit(null)).toEqual({ ok: true, limit: 100 });
    expect(parseEnterpriseActionsLimit("")).toEqual({ ok: true, limit: 100 });
  });

  test("a plain integer is clamped into 1..500 like the store enforces", () => {
    expect(parseEnterpriseActionsLimit("25")).toEqual({ ok: true, limit: 25 });
    expect(parseEnterpriseActionsLimit("9999")).toEqual({
      ok: true,
      limit: 500,
    });
    expect(parseEnterpriseActionsLimit("0")).toEqual({ ok: true, limit: 1 });
  });

  test("anything that is not digits is the shared limit 400", () => {
    for (const raw of ["abc", "12abc", "3.9", "-5", "0x10"]) {
      expect(parseEnterpriseActionsLimit(raw)).toEqual({
        ok: false,
        error: PAGE_LIMIT_ERROR,
      });
    }
  });
});
