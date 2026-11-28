/**
 * The agent authenticates to the management service with its install's client certificate. That
 * only happens over TLS, so a plain-http management URL is not a harmless chart typo: it silently
 * sends the heartbeat and the full release manifest in the clear, with no client certificate.
 */
import { describe, expect, test } from "bun:test";
import { AgentConfig } from "../src/config";

const valid = {
  managementUrl: "https://management.example.test/v1",
  installId: "6f1c1a52-2f0e-4c3b-9b1e-6a3f0f6b2d11",
  cloud: "other",
  commandPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  window: null,
  agentNamespace: "openbot-system",
  product: {
    chart: "bundle",
    releaseName: "openbot",
    namespace: "openbot",
    helmRelease: "openbot",
    ociRepository: "openbot",
    pinsConfigMap: "openbot-pins",
    source: {
      url: "oci://registry.example.test/charts/openbot-bundle",
      digest: null,
      insecure: false,
      pullSecret: null,
      verify: null,
    },
    release: {
      serviceAccountName: "openbot-deployer",
      timeout: "20m",
      valuesFrom: [],
    },
  },
  backup: { kind: "command", timeoutSeconds: 600 },
  stateConfigMap: "openbot-agent-state",
  supportBundle: { pvc: "support-bundle" },
};

describe("agent config", () => {
  test("accepts an HTTPS management URL", () => {
    expect(AgentConfig.safeParse(valid).success).toBe(true);
  });

  test("refuses an HTTP management URL instead of silently dropping mutual TLS", () => {
    const result = AgentConfig.safeParse({
      ...valid,
      managementUrl: "http://management.example.test/v1",
    });
    expect(result.success).toBe(false);
  });

  test("refuses a management URL with no scheme at all", () => {
    expect(
      AgentConfig.safeParse({
        ...valid,
        managementUrl: "management.example.test/v1",
      }).success,
    ).toBe(false);
  });
});
