import { describe, expect, test } from "bun:test";
import policy from "../../release-policy.json";
import { version } from "../../package.json";
import {
  API_VERSIONS,
  belowMinimum,
  CLIENT_KINDS,
  type ClientKind,
  clientToken,
  clientUpdateDetail,
  compareVersions,
  compatibility,
  EXTENSION_API,
  LAUNCHER_API,
  MINIMUM_CLIENTS,
  parseClientHeader,
  RELEASE,
  SECURITY_UPDATE_SENTENCE,
  clientTokens,
} from "../client-version";
import { countedClients } from "../api-deprecations";
import cases from "../fixtures/client-version/cases.json";

describe("which app is asking", () => {
  test("an app names itself as kind/version, and Desktop adds its own to its page's", () => {
    expect(clientToken("desktop", "1.1.0")).toBe("desktop/1.1.0");
    expect(clientToken("web")).toBe(`web/${version}`);
    expect(parseClientHeader("web/1.2.0 desktop/1.1.5")).toEqual([
      { kind: "web", version: "1.2.0" },
      { kind: "desktop", version: "1.1.5" },
    ]);
  });

  test("anything that is not an OpenBot app with a release number is not read", () => {
    expect(parseClientHeader(null)).toEqual([]);
    expect(parseClientHeader("")).toEqual([]);
    expect(
      parseClientHeader("curl/8.7.1 desktop/main-ci web/ /1.0.0 desktop"),
    ).toEqual([]);
    expect(parseClientHeader("Desktop/v1.0.3")).toEqual([
      { kind: "desktop", version: "v1.0.3" },
    ]);
  });
});

describe("release order", () => {
  test("numbers in order, and a candidate before its release", () => {
    const ordered = [
      "1.0.2-rc.1",
      "1.0.2-rc.3",
      "1.0.2",
      "1.0.10",
      "1.1.0-rc.2",
      "1.1.0",
      "v1.2.0",
      "2.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(
        compareVersions(ordered[i] as string, ordered[i + 1] as string),
      ).toBe(-1);
      expect(
        compareVersions(ordered[i + 1] as string, ordered[i] as string),
      ).toBe(1);
    }
    expect(compareVersions("1.1.0", "v1.1.0")).toBe(0);
    expect(compareVersions("test-20261117-71", "1.1.0")).toBeUndefined();
  });

  test("an app below a minimum is the one refused, and not one at it", () => {
    // As a server whose admin raised Desktop to 1.2.0 (OPENBOT_MINIMUM_CLIENTS=desktop=1.2.0).
    const raised = cases.deployments.raised.minimumClients;
    const named = parseClientHeader("web/1.1.0 desktop/1.1.0");
    expect(belowMinimum(named, raised)).toEqual({
      kind: "desktop",
      version: "1.1.0",
      minimum: "1.2.0",
    });
    expect(
      belowMinimum(parseClientHeader("desktop/1.2.0"), raised),
    ).toBeUndefined();
    // With no minimum, every app is served.
    expect(belowMinimum(named, MINIMUM_CLIENTS)).toBeUndefined();
  });
});

describe("what this release publishes", () => {
  test("its own release, the API it serves, and release-policy's contract numbers", () => {
    expect(RELEASE).toBe(version);
    expect(API_VERSIONS).toEqual(["v2"]);
    expect(LAUNCHER_API).toBe(policy.compatibility.launcherApi);
    expect(EXTENSION_API).toBe(policy.compatibility.extensionApi);
    expect(cases.deployments.current.minimumClients).toEqual({
      ...MINIMUM_CLIENTS,
    });
  });

  test("no built-in minimum: every OpenBot release is less than 12 months old", () => {
    // A server serves every app released in the last 12 months, so a release may name as a built-in
    // minimum only a release published more than 12 months before it. The first OpenBot release,
    // 0.0.1, is from 2026-08-16. Until one is old enough, only an admin raises a minimum.
    expect(MINIMUM_CLIENTS).toEqual({});
  });

  test("the sentence a refused app reads says to update OpenBot", () => {
    for (const kind of CLIENT_KINDS) {
      const detail = clientUpdateDetail(kind, "1.2.0");
      expect(detail).toContain("Update OpenBot");
      expect(detail).not.toMatch(/reload|refresh|—/i);
    }
    expect(clientUpdateDetail("desktop", "v1.2.0")).toBe(
      "This OpenBot needs OpenBot Desktop 1.2.0 or later. Update OpenBot, then try again.",
    );
  });

  test("a minimum raised for a security problem says so, for every app", () => {
    expect(SECURITY_UPDATE_SENTENCE).toBe(
      "This version of OpenBot has a security problem. Update to keep using it.",
    );
    for (const kind of CLIENT_KINDS) {
      expect(clientUpdateDetail(kind, "1.2.0", true)).toBe(
        SECURITY_UPDATE_SENTENCE,
      );
      expect(clientUpdateDetail(kind, "1.2.0", false)).toBe(
        clientUpdateDetail(kind, "1.2.0"),
      );
    }
  });
});

describe("each app's decision from real deployment answers", () => {
  for (const each of cases.cases) {
    const client = each.client as {
      kind: ClientKind;
      version: string;
      speaks?: string[];
    };
    test(`${each.deployment}, ${client.kind}/${client.version}${client.speaks ? ` speaking ${client.speaks}` : ""}: ${each.fit}`, () => {
      const deployment =
        cases.deployments[each.deployment as keyof typeof cases.deployments];
      const fit = compatibility(deployment, client);
      expect(fit.fit).toBe(each.fit as "ok" | "app" | "server");
      // An app below a minimum raised for security is told so; one below a plain raise is not.
      if ("minimum" in each)
        expect(fit).toEqual({
          fit: "app",
          minimum: each.minimum as string,
          ...("security" in each && each.security ? { security: true } : {}),
        });
    });
  }
});

describe("one reading of the header", () => {
  const HEADERS = [
    "desktop/1.1.0",
    "web/1.2.0 desktop/1.1.5",
    "Desktop/v1.0.3",
    "web/1.1.0 web/1.1.0",
    "desktop/main-ci",
    "curl/8.7.1",
    "web/ /1.0.0 desktop",
    "mobile/1.1.0-rc.2 recorder/1.1.0 laptop/9.9.9",
    "a/1.0.0 b/1.0.0 c/1.0.0 d/1.0.0 e/1.0.0 f/1.0.0 g/1.0.0 h/1.0.0 desktop/1.0.0",
  ];

  test("the version check and the deprecation count read the same apps from every header", () => {
    for (const header of HEADERS) {
      const tokens = clientTokens(header);
      const counted = countedClients(header).filter(
        (client) => client.kind !== "other" && client.kind !== "unknown",
      );
      // The count names exactly the apps the tokenizer reads, each once.
      expect(new Set(counted.map((client) => client.kind))).toEqual(
        new Set(tokens.map((token) => token.kind)),
      );
      // And every app the version check holds against a minimum is counted at that release.
      for (const named of parseClientHeader(header))
        expect(counted).toContainEqual({
          kind: named.kind,
          version: named.version.replace(/^v/, ""),
        });
    }
  });
});
