#!/usr/bin/env bun
/** The agent's entry point in its container. */
import { ManagementAgent } from "./agent";
import { ManagementClient } from "./client";
import { loadAgent } from "./config";
import { enrolledAgent } from "./enroll";
import { Kube } from "./kube";

const log = (message: string, fields?: Record<string, unknown>) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), message, ...fields }),
  );
const loaded = loadAgent();
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    // A promotion cut off here leaves its journal unfinished, which blocks further upgrades until a
    // person looks: the same as any other interruption.
    controller.abort();
    process.exit(0);
  });

const kube = new Kube();
// With enrollment and no certificate yet, this waits until the agent has enrolled.
const agent = await enrolledAgent(loaded, kube, {
  log,
  signal: controller.signal,
});
const management = new ManagementAgent(
  agent,
  kube,
  new ManagementClient(agent.config.managementUrl, agent.credentials),
  log,
);
console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    message: "openbot management agent started",
    installId: agent.config.installId,
    managementUrl: agent.config.managementUrl,
    product: agent.config.product,
  }),
);
await management.loop(controller.signal);
