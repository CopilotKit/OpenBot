# CopilotKit management on Kubernetes

A self-hosted team install of OpenBot on Kubernetes is connected to CopilotKit's management service
by default. This page says what that does, how to turn it off, and how to let CopilotKit run your
upgrades, which is a separate step you take on purpose.

## What is on by default

The `openbot` chart (and `openbot-bundle`, which installs it) installs the management agent into
`openbot-system`. The server enrolls the install with its CopilotKit licence, and the agent picks up
a one-time token from the server, makes its own key, gets its certificate and keeps it in the Secret
`openbot-agent-credentials`. From then on the agent:

- sends a heartbeat every minute to `https://fleet.bot.copilotkit.ai` over mutual TLS: versions,
  image digests, pod readiness and the last migration, nothing that names a person;
- runs two signed commands, restart and support bundle (written to a volume in your cluster, never
  uploaded).

It does not upgrade anything. No Flux is installed, and a cluster that already runs Flux is not
touched: no CRD, controller or Flux object is created, changed or removed. It reports
`upgrades: not-set-up`, and CopilotKit's service and OpenBot's admin screen show the install as
connected, with upgrades not set up.

The agent is never installed by OpenBot Desktop's own install or on OpenBot Cloud.

## Turning it off

```sh
helm upgrade openbot <chart> --reuse-values --set management.enabled=false          # openbot chart
helm upgrade openbot <chart> --reuse-values --set openbot.management.enabled=false  # openbot-bundle
```

This removes the agent, the internal port's network policy peer for it, and tells the server never
to enroll on its own. An admin's Disconnect in Admin, CopilotKit management, does the same for the
server without a Helm change. The Secret `openbot-agent-credentials` stays; delete it if you want
nothing left, and CopilotKit revokes the certificate when the install is disconnected.

## Letting CopilotKit run your upgrades

Upgrades run through the `openbot-agent` release, which brings Flux's source and Helm controllers,
limited to `openbot-system`. It takes over from the default agent with the same certificate, so the
install keeps its identity: there is never a second agent or a second install.

1. **Your product values in a Secret.** Flux installs your release from these values, not from the
   ones Helm keeps, so put the values you install OpenBot with in a Secret in `openbot-system`
   (default name `openbot-values`, key `values.yaml`).
2. **How your database is backed up** before an upgrade that migrates it: `backup.kind`
   (`rds-snapshot`, `aurora-snapshot`, `azure-pg-backup`, `cloudsql-backup`, `alloydb-backup` or
   `command`) with its values, and the backup Job's cloud identity. Without it the agent refuses
   every such upgrade before touching anything.
3. **Take the default agent out of the product release**, keeping management on:

   ```sh
   helm upgrade openbot <chart> --reuse-values --set management.agent.enabled=false          # openbot
   helm upgrade openbot <chart> --reuse-values --set openbot.management.agent.enabled=false  # bundle
   ```

4. **Install the `openbot-agent` release**, pointing it at your server as the default agent was:

   ```sh
   helm install openbot-agent oci://ghcr.io/copilotkit/charts/openbot-agent -n openbot-system \
     --set managedUpgrades=true \
     --set enrollment.serverUrl=http://<release>-server-internal.<namespace>.svc:9464 \
     --values my-agent-values.yaml
   ```

   The agent finds `openbot-agent-credentials`, so it does not enroll again. It reports
   `upgrades: on`, and from then on it upgrades only to a release the service names, inside your
   maintenance window, with a verified backup first when the database changes.

If a cluster already runs Flux, see the `openbot-agent` chart's README before step 4: install with
`--skip-crds` (Helm 4 would otherwise rewrite your Flux's CRDs to the chart's versions), and keep your
Flux off `openbot-system`, where the controllers it installs work.

To stop managed upgrades again, `helm uninstall openbot-agent` (OpenBot stays installed and
upgradable with plain Helm), then set `management.agent.enabled=true` on the product release to have
the default agent back.
