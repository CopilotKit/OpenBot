# CopilotKit management on Kubernetes

A self-hosted team install of OpenBot on Kubernetes connects to CopilotKit's management service by
default. This page says when that happens, exactly what leaves your cluster, how to turn it off, and
how to let CopilotKit run your upgrades, which is a separate step you take on purpose. It applies to
the charts published from the release after v1.1.2; earlier charts install no agent.

## When it connects

The `openbot` chart (and `openbot-bundle`, which installs it) installs the management agent into the
namespace `openbot-system` (`management.enabled`, on by default). The OpenBot server then connects
the install by itself, with its CopilotKit licence. There is no enrollment step and nobody approves a
code: CopilotKit's service accepts a valid team licence at once. The server tries when it starts and
again every hour until it is connected.

It never connects:

- on OpenBot Desktop, whose own install runs OpenBot with Docker Compose, not the chart, and has
  no agent;
- on the personal edition (`OPENBOT_EDITION=personal`), where the server never enrolls;
- on OpenBot Cloud, which CopilotKit runs itself (the chart refuses `management.enabled` there);
- without a licence (`COPILOTKIT_LICENSE_TOKEN`, the chart's `secrets.licenseToken`), or with one
  that isn't a team licence: the service refuses it and nothing connects;
- once you opt out with `management.enabled=false`, or an admin presses Disconnect (see
  [Turning it off](#turning-it-off)).

Once enrolled, the agent collects a one-time token from the server's internal port, proving who it
is with a projected service account token. It makes its own key, gets its certificate, and keeps
both in the Secret `openbot-agent-credentials`. The key never leaves the cluster.

## What leaves your cluster

Every connection starts inside your cluster. Nothing calls in.

**The agent's heartbeat**, every minute (plus up to 10% jitter), to `https://fleet.bot.copilotkit.ai`
over mutual TLS. Its fields are fixed in [`shared/management-contract.ts`](../shared/management-contract.ts)
(`Heartbeat`), and the service refuses a heartbeat that carries any other field:

- the install id, the agent's version, and the cloud you set (`aws`, `azure`, `gcp` or `other`);
- OpenBot's version and chart version, the Intelligence chart's version, and the image digest of
  each container in OpenBot's namespace, keyed by workload and container name;
- the last database migration the server applied;
- each Deployment and StatefulSet in OpenBot's namespace, by name, with its ready and desired
  replica counts;
- the upgrade state (`idle`, `waiting-window`, `backing-up`, `upgrading`, `verifying`,
  `recovery-required` or `paused`), the target version, and one line on the current or last
  operation;
- whether upgrades are set up (`on` or `not-set-up`);
- with upgrades set up, the readiness, reason and message of the Flux HelmRelease that installs
  OpenBot.

**Command results.** The service can send two commands to the default agent: restart a workload,
and write a support bundle. A command runs only if CopilotKit's Ed25519 signature on it verifies and
it hasn't expired. The agent answers with the command's id, whether it worked, and one line saying
why. A support bundle is written to a volume in your cluster and is never uploaded.

**The server's enrollment calls**, to `https://enroll.bot.copilotkit.ai`: your licence token, a name
for the install (the host of OpenBot's address), OpenBot's address, and a random id the server makes
once for the install. The server then reads the install's status from there for Admin, and tells the
service when an admin disconnects. The agent sends it only a certificate request.

**Health metrics, only once upgrades are set up.** The default agent sends no metrics. The
`openbot-agent` release you install to set up upgrades (below) also runs an OpenTelemetry Collector
that sends the health metrics on its allowlist: request rate, errors and latency, database
reachability and connection pool, pod restarts and readiness, and CPU and memory. Any other metric is
dropped, and any label that could name a person, an organization or a tenant is removed before it
leaves. No logs or traces are read or sent. `otel.enabled=false` on that release turns it off.

**What never leaves:** conversations, messages, files, prompts, Bot settings, people's names or
email addresses, secrets, logs and database contents. The agent never reads Secrets in OpenBot's
namespace, and logs no token, key or certificate.

## What it does in your cluster

By default it does not upgrade anything. No Flux is installed, and a cluster that already runs Flux
is not touched: no CRD, controller or Flux object is created, changed or removed. The agent reports
`upgrades: not-set-up`. It refuses pause, resume and rollback, and a version the service asks for
waits, until you set upgrades up.

## Turning it off

**With Helm.** This installs no agent, removes the internal port's network policy peer for it, and
tells the server not to enroll (`OPENBOT_MANAGEMENT_ENABLED=false`):

```sh
helm upgrade openbot <chart> --reuse-values --set management.enabled=false          # openbot chart
helm upgrade openbot <chart> --reuse-values --set openbot.management.enabled=false  # openbot-bundle
```

An install opted out this way makes no connection to `fleet.bot.copilotkit.ai`. The namespace
`openbot-system` and the Secret `openbot-agent-credentials` stay; delete them if you want nothing
left. The agent was part of the `openbot` release, so that upgrade removed it and there is no
`openbot-agent` release to uninstall. To have CopilotKit retire the install and revoke its
certificate too, press Disconnect in Admin → Managed updates. If you had set upgrades up, the
`openbot-agent` release is still there: uninstall it first (see the end of this page).

Admin → Managed updates still shows, so an admin can connect by hand later. To hide it as well, also
set `server.managementEnrollment.enabled=false` (`openbot.server.managementEnrollment.enabled=false`
on the bundle).

**From Admin.** An admin presses Disconnect on Admin → Managed updates. OpenBot retires the install
at CopilotKit's service, which revokes the agent's certificate, so the service refuses the agent
from then on. The choice is kept: the server doesn't connect by itself again, after a restart or an
upgrade, until an admin presses Connect. The agent's pod stays until you also opt out with Helm.

## Admin → Managed updates

Only admins of the organization `default` see this screen, and only on a team install you run
yourself in a cluster the chart set up. Elsewhere it says **Not available here**. It shows one of
these states:

| State | What it means | What you can do |
| --- | --- | --- |
| **Not connected** | Nothing is connected yet. With the chart's agent, OpenBot tries again every hour. | Connect, to try now. |
| **Connecting** | OpenBot is connecting with its licence. The page updates itself. | Stop. OpenBot then doesn't try again by itself. |
| **Connected** | Status (Connected, or Not reporting when the agent has gone quiet), last heartbeat, agent version, whether upgrades are on or not set up (with a link to this page), the maintenance window, and the install id. | Disconnect, under Turn off managed updates. |
| **Turned off** | An admin disconnected or stopped. OpenBot doesn't connect by itself. | Connect, to turn managed updates back on. |
| **Not in your licence** | The licence doesn't include managed updates. | Get in touch with CopilotKit. |

With `management.enabled=false`, Connect takes two steps instead: **Step 1 of 2: approve the code**,
at CopilotKit's page, signed in as an admin of the organization your licence belongs to, then **Step
2 of 2: install the management agent**, with one `helm install` command that holds nothing secret.
After that, Disconnect asks you to uninstall that agent's `openbot-agent` release with Helm first.

## Letting CopilotKit run your upgrades

Upgrades run through the `openbot-agent` release, which brings Flux's source and Helm controllers,
limited to `openbot-system`. It takes over from the default agent with the same certificate, so the
install keeps its identity: there is never a second agent or a second install.

Once set up, the agent upgrades only to a release the service names, and only inside the maintenance
window: the one agreed with CopilotKit (by default Tuesdays, 14:00 to 18:00 UTC), and yours too if
you set one in the agent's `window` value. Before an upgrade that changes the database, it checks
that the backup settings name the database OpenBot actually uses, then takes a verified backup. If
the check fails, it changes nothing and stops for a person. It never rolls back by itself.

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
   `upgrades: on`, and Admin → Managed updates shows Upgrades: On.

If a cluster already runs Flux, see the `openbot-agent` chart's README (`helm show readme`) before
step 4: install with `--skip-crds` (Helm 4 would otherwise rewrite your Flux's CRDs to the chart's
versions), and keep your Flux off `openbot-system`, where the controllers it installs work.

To stop managed upgrades again, `helm uninstall openbot-agent -n openbot-system` (OpenBot stays
installed and upgradable with plain Helm), then set `management.agent.enabled=true` on the product
release to have the default agent back, or `management.enabled=false` to opt out.
