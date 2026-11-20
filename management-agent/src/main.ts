#!/usr/bin/env bun
/** The agent's entry point in its container. */
import { ManagementAgent } from "./agent";
import { ManagementClient } from "./client";
import { loadAgent } from "./config";
import { enrolledAgent, newInstallCheck } from "./enroll";
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
// The service refusing this agent's heartbeats can mean its install was retired (an admin's
// Disconnect revokes the certificate) and the cluster connected again as a new install. Then
// OpenBot holds that install's token: the agent keeps it and starts again to enroll for it,
// instead of failing every minute until somebody restarts it. Asked at most every 5 minutes.
const newInstall = newInstallCheck(loaded, kube, { log });
let askedAt = 0;
if (newInstall)
  management.onHeartbeatFailure = async () => {
    if (Date.now() - askedAt < 5 * 60_000) return;
    askedAt = Date.now();
    if (await newInstall(agent.config.installId)) {
      controller.abort();
      process.exit(0);
    }
  };
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
