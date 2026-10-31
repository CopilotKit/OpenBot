# OpenBot on Kubernetes

Runs OpenBot on any Kubernetes cluster: EKS, GKE, AKS, or your own. One chart, five targets, and the
only difference between them is values.

## What a cluster needs first

Four things this chart assumes and does not create.

**An image the cluster can pull.** A release publishes `ghcr.io/copilotkit/openbot:vX.Y.Z`
publicly, and that tag is what `image.tag` wants. It is built for **`linux/amd64` only**, so an
arm64 node group (Graviton on EKS, Tau T2A on GKE, Ampere on AKS) cannot run it: the pods sit in
`ImagePullBackOff`, which is the same thing a wrong tag or a missing pull secret looks like, so the
node pool being the wrong shape is the last thing anybody checks. Either run amd64 nodes, or build the image for the
architecture you have and push it somewhere the cluster can reach. Check before assuming:

```sh
docker manifest inspect ghcr.io/copilotkit/openbot:v0.0.9 | grep architecture
```

**Intelligence credentials.** OpenBot requires CopilotKit Intelligence and the chart refuses to
install without `secrets.intelligenceApiKey`. It comes from the CLI, on any machine with a browser:

```sh
npx --yes copilotkit@latest login           # browser sign-in
npx --yes copilotkit@latest project select  # prints the cpk-... runtime key
```

That key is the only Intelligence credential a managed install needs; the free plan is enough.
`secrets.licenseToken` is optional and exists for a self-hosted Intelligence that issues its own
licence. `npx --yes copilotkit@latest license --print` prints one without writing it to a local
`.env`, which is what you want for something you are about to paste into a Secret. With
`externalSecrets`, name `license-token` in its `data` and the server receives it the same way.

**A self-hosted Intelligence needs that licence too, on its own deployment.** Its chart takes it as
`appApi.licenseSecret` or `externalSecrets.secrets.license`. Without it Intelligence answers every
entitlement read with `RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED` and refuses memory, while
conversations carry on; OpenBot logs `intelligence-entitlement-not-ready` at boot when it does.

**A default StorageClass**, or a named one. Both a Bot's computer and the bundled database ask for
a volume, and a fresh cluster often has no class marked default. See
[Check for a default StorageClass first](#check-for-a-default-storageclass-first), which is the
single most common reason a first install comes up with a pod stuck `Pending` and nothing saying
why.

**A database, and the Secret that names it**, unless you are using the bundled one. The chart reads
a URL out of a Secret you make; it never writes your database credentials into a values file:

```sh
kubectl create namespace openbot
kubectl -n openbot create secret generic openbot-database \
  --from-literal=database-url='postgresql://USER:PASSWORD@HOST:5432/openbot?sslmode=require'
```

Then `--set database.existingSecret=openbot-database`. The key must be `database-url`, or name a
different one with `database.existingSecretKey`. See
[Your own database](#your-own-database-which-is-what-a-real-deployment-uses) for `sslmode` and the
`vector` extension, both of which a managed database will otherwise fail on in a way that names the
wrong problem.

### A cluster from nothing, on EKS

The three above, as one config and two commands. `eksctl` creates `gp2` and does not mark it
default, and the provisioner it names is the in-tree one current Kubernetes no longer has, so the
StorageClass below is not optional.

```yaml
# cluster.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata: { name: openbot, region: us-east-2, version: "1.34" }
iam: { withOIDC: true }
addons:
  - name: vpc-cni
  - name: coredns
  - name: kube-proxy
  - name: metrics-server
  # Last to be created, because it needs the OIDC provider that needs the control plane. Let it
  # finish; creating the same addon by hand while this is running fails the cluster create.
  - name: aws-ebs-csi-driver
    wellKnownPolicies: { ebsCSIController: true }
managedNodeGroups:
  - name: workers
    # amd64: the published image has no arm64 variant. See the image note above.
    instanceType: t3.large
    desiredCapacity: 2
    minSize: 2
    maxSize: 4
    volumeSize: 60
    volumeType: gp3
    # A Bot has a shell, and a shell reaches whatever its pod reaches. These two put the node's
    # own IAM role out of that reach. See below.
    disableIMDSv1: true
    disablePodIMDS: true
```

**Why the two IMDS lines.** A node's instance metadata service, at 169.254.169.254, hands out that
node's IAM role to anything that asks from the node. A Bot's computer is a pod on that node running
commands a model chose, so `curl` against that address is one `run_command` away, and no rule in
OpenBot's own policy engine is consulted: the engine decides browser navigation and tool calls, and
the shell reaches the network directly.

`disablePodIMDS` sets the hop limit to 1, so a packet from a pod, which has one more hop to make
than one from the node itself, no longer arrives. That hop limit applies to the IMDSv2 token PUT,
and IMDSv1 is a bare GET with no PUT to limit, so the hop limit only means anything once a token is
mandatory. It already is: eksctl documents `disableIMDSv1` as defaulting to true, and sets
`httpTokens: required` for either flag. `disableIMDSv1: true` is written out here to state that
rather than to change it, since a reader deciding whether this recipe is safe should not have to
know an upstream default. Note this covers pods on the cluster network; a pod running with
`hostNetwork: true` is on the node and still reaches the address.

**What the hop limit costs.** The EBS CSI driver reads EC2 instance metadata from IMDS, and its own
FAQ asks for "the hop limit for IMDSv2 responses ... set to 2 or greater" in a containerized
environment like EKS. A hop limit of 1 also rules out `MutableCSINodeAllocatableCount`, whose
documented prerequisites are that the driver "must be using IMDS Metadata" and that IMDS be its only
enabled or preferred metadata source. Drop these two lines if your cluster needs either, and lean on
the NetworkPolicy below instead.

Two things eksctl will refuse rather than warn about, both worth knowing before the next edit to
this file: `disablePodIMDS` cannot be combined with `iam.withAddonPolicies` on the same node group,
and neither field may be set on a node group that supplies its own `launchTemplate`.

The NetworkPolicy below also excepts `169.254.0.0/16`, and is the better control where it is
enforced. It is off by default and does nothing on EKS until the VPC CNI is told to enforce it, so
these two lines are what holds in the configuration a cluster actually starts in. Nothing in OpenBot
wants pod-level IMDS either way: the chart reaches AWS through IRSA, which is a ServiceAccount
annotation and a projected token rather than the node's role.

```sh
eksctl create cluster -f cluster.yaml

kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations: { storageclass.kubernetes.io/is-default-class: "true" }
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters: { type: gp3 }
EOF
```

The database goes in the same VPC, in the private subnets, with a security group admitting 5432
from the cluster's own security group. `aws eks describe-cluster` names both. Keep it
`--no-publicly-accessible`: the only thing that needs to reach it is in the cluster.

## Install

The bundled database and one administrator, which is the shortest thing that works:

```sh
helm dependency build charts/openbot
helm upgrade --install openbot charts/openbot \
  --namespace openbot --create-namespace \
  --set postgresql.enabled=true \
  --set config.initialAdminEmails=you@example.com \
  --set-string secrets.keyEncryptionKey="$(openssl rand -base64 32)"
```

`secrets.keyEncryptionKey` encrypts the credential vault. Generate it once, keep it, and do not put
it in a file anybody commits. The chart marks the Secret it creates `helm.sh/resource-policy: keep`,
so an uninstall does not take the key that every stored credential was encrypted with.

### Pin the image by digest

A tag can be moved; a digest cannot. Each release's `container-images.json` names the digest CI
tested, and `image.digest` deploys exactly that:

```sh
gh release download v0.2.0 --pattern container-images.json
helm upgrade --install openbot charts/openbot ... \
  --set image.tag=v0.2.0 \
  --set-string image.digest="$(jq -r '.images.openbot.reference | split("@")[1]' container-images.json)"
```

The image becomes `repository:tag@digest`, so the tag stays readable and the digest decides what is
pulled. Anything other than `sha256:` and 64 hex characters is refused at install.

### Your own tenant package

The tenant package is a directory (`config.tenantPackageDir`, `/app/examples/fintech` by default).
To run your own without building an image, put its files in a ConfigMap and mount it with
`config.extraVolumes` and `config.extraVolumeMounts`. They reach the server and the routines and
computer-culler CronJobs, the pods that load the package, so the package is the same wherever it is
read:

```yaml
config:
  tenantPackageDir: /tenant
  extraVolumes:
    - name: tenant
      configMap: { name: my-tenant-package }
  extraVolumeMounts:
    - name: tenant
      mountPath: /tenant
      readOnly: true
```

A ConfigMap is flat, so a package that uses `agents/` needs `items` with `path: agents/<file>.yaml`,
or keeps its coworkers in `agents.yaml`.

## What the defaults assume

**A plain cluster with no cloud features.** The cluster's own default StorageClass, no RuntimeClass,
a plain Kubernetes Secret, an Ingress. There is no cloud branching anywhere in the templates and
there should never be. A deployment on a managed cluster turns things on; a self-hosted one changes
nothing and still works.

Two replicas by default, because horizontal is the point. Everything that has to survive a replica is
in PostgreSQL, and one replica hides every bug that is not.

**No browser in the API pod.** The image runs a Bot's computer beside the API so that one container
works on its own. A replica must not carry one: a browser is a few hundred megabytes holding one
Bot's logins, so scaling the API would scale those with it. `server.embeddedComputer` is off here,
and asking for it with more than one replica is refused at install time.

## Your own database, which is what a real deployment uses

```sh
--set postgresql.enabled=false \
--set database.existingSecret=openbot-database   # key: database-url
```

`postgresql.enabled` is **off by default and not production-grade**. A database on a pod goes away
when the pod does: a rollout, a node drain or an eviction is a restart, and while the volume survives,
nothing about that shape gives you backups, failover or point-in-time recovery. It is there so
somebody can try OpenBot in one command.

Point it at RDS, Cloud SQL, Azure Database or your own server, and keep the URL in a Secret rather
than in a values file. Setting both a bundled database and a URL is refused, rather than one of them
silently winning.

**Put `?sslmode=require` on the URL.** Every managed database refuses an unencrypted connection:
RDS has `rds.force_ssl` on by default, and Cloud SQL and Azure Database do the same. Without it the
migration fails with `no pg_hba.conf entry for host ... no encryption`, which names the host and the
user and not the actual problem.

The server accepts `disable`, `require` and `verify-full` (with `sslrootcert=/path/to/ca.pem`, or
the system roots without it). `require` encrypts and checks nothing, as libpq's does. `verify-full`
needs Bun 1.4 or later, because Bun 1.3 connects whatever certificate it is shown, so the server
refuses it on 1.3 rather than appear to check. `verify-ca`, `prefer` and `allow` are refused: Bun
can neither check the authority without the host name nor fall back between TLS and plain.

**The migrating role has to OWN the `vector` extension, not just be able to see it.** The first
migration runs `CREATE EXTENSION IF NOT EXISTS vector` and migration `0010` runs
`DROP EXTENSION IF EXISTS "vector"` once the document index is gone. `DROP EXTENSION` is an ownership
check, and `IF EXISTS` does not waive it — it only makes a *missing* extension not an error. So a
role that can see an extension somebody else owns gets through the create and fails the drop, and the
migrations Job stops with:

```
must be owner of extension vector
```

In Postgres an extension's owner is whoever ran `CREATE EXTENSION`, and there is no
`ALTER EXTENSION ... OWNER TO` to hand it over afterwards. The advice that used to stand here — have
the administrative role create it once so `CREATE EXTENSION IF NOT EXISTS` passes for an ordinary
user — is therefore exactly what produces the failure: it makes the admin the owner and the migrating
role a bystander.

Do one of these instead:

- **Let the migrating role create it.** Simplest, and it needs no extra step: allow that role to run
  `CREATE EXTENSION` (`GRANT rds_superuser` on RDS, `cloudsqlsuperuser` on Cloud SQL, `azure_pg_admin`
  on Azure Database, plus whatever extension allow-list the vendor keeps), then leave the extension
  absent and let migration `0000` create it. The migrating role owns it and `0010` drops it cleanly.
- **Pre-create it AS the migrating role.** Where that grant is not on offer, the administrative role
  can still do it on the other role's behalf, which is the whole trick:

  ```sql
  SET ROLE openbot_migrator;      -- the role in DATABASE_URL
  CREATE EXTENSION IF NOT EXISTS vector;
  RESET ROLE;
  ```

  Ownership follows the role that ran the statement, so this is equivalent to the first option.

If you have already installed with the extension owned by somebody else, drop and recreate it under
the migrating role before upgrading — `DROP EXTENSION vector;` as the owner, then the block above.
Nothing of yours is in it: `vector` existed for the `embedding` column on `chunks`, which `0010`
drops in the same transaction. A deployment that added a vector column of its own is the one case
where that is not true, and `0010` is written to fail rather than take it; that deployment should
keep the extension and apply only the table drops by hand.

## The five targets

`ci/` holds a values file per target, and each is the shortest thing that expresses what is different
about that cluster:

| File | What it shows |
| --- | --- |
| `self-hosted-values.yaml` | Nothing turned on. If this file needs to grow, a default is wrong. |
| `eks-values.yaml` | IRSA, Secrets Manager, ALB, zone spread, autoscaling. |
| `eks-sandbox-values.yaml` | The same, with a computer for each person rather than one shared browser. `shared` and `sandbox` render a different Deployment, different RBAC and a different pod template, so a target that renders only one checks half the chart. |
| `gke-values.yaml` | Workload Identity, Secret Manager, Gateway API instead of an Ingress. |
| `aks-values.yaml` | Workload identity, Key Vault, the AKS web app routing class. |

Render any of them without a cluster:

```sh
helm template openbot charts/openbot -f charts/openbot/ci/eks-values.yaml
```

### Identity, in one map

IRSA on EKS, Workload Identity on GKE and workload identity on AKS are all annotations on a
ServiceAccount, so `serviceAccount.annotations` covers all three and the chart needs no idea which
cloud it is on.

### Secrets, without a vendor

A plain Kubernetes Secret is the default, because that is what a self-hosted cluster has. Setting
`externalSecrets.enabled` turns the same keys into an ExternalSecret against whatever store the
cluster has, so Secrets Manager, Secret Manager and Key Vault are a values block rather than three
code paths.

### Check for a default StorageClass first

A fresh EKS cluster very often has none. `eksctl` creates `gp2`, which is not marked default and uses
the in-tree `kubernetes.io/aws-ebs` provisioner that current Kubernetes no longer has. A volume asking
for "the default" then never binds, the computer sits `Pending`, and nothing says why. One line tells
you:

```sh
kubectl get sc
```

Either create a default class backed by `ebs.csi.aws.com`, or set `computers.persistence.storageClass`
and `postgresql.primary.persistence.storageClass` to one that exists. `ci/eks-values.yaml` does the
second.

`volumeBindingMode: WaitForFirstConsumer` matters on every cloud: without it the volume is created in
a zone chosen before the pod is scheduled, and pods stick unschedulable with a node-affinity conflict.
That only happens in multi-zone clusters, so it passes every single-zone test.

### Storage has gravity

The API tier holds nothing on disk. When per-Bot computers arrive they will, and the ordinary block
volume on all three clouds is **zonal**: once provisioned, every pod referencing it is scheduled into
that zone, so a Bot's computer is pinned to a zone for as long as its profile exists. That is
acceptable and worth stating rather than discovering. `storageClass` stays empty by default, meaning
the cluster's default class, because naming `gp3` or `pd-balanced` here is how a chart stops
installing on somebody's bare-metal cluster.

## Refused at install, not in a crash loop

The chart fails the install, naming the value to change, when: there is no database or two of them;
nobody could sign in or nobody would be an administrator; an identity provider is configured without
`secrets.betterAuthSecret` or `config.publicUrl`; `singleUser` is combined with a public URL or a
public LoadBalancer; the Intelligence URLs or `secrets.intelligenceApiKey` are missing;
`secrets.keyEncryptionKey` is not a base64 32-byte value, or is the public example key; there is no
`secrets.computerToken`; `computers.mode` is `external` with no `computers.url`, or `sandbox` on a
cluster with no Sandbox CRD; both an Ingress and an HTTPRoute are enabled; both `externalSecrets` and
an existing Secret are named; a Bot endpoint is named with no token to call it with; a browser is
asked for inside more than one API replica; `networkPolicy.enabled` is set with an external database
and no `networkPolicy.extraEgress`, or with `computers.mode: sandbox` and no
`networkPolicy.kubernetesApiCidr`; a computer proxy is named that the network policy blocks, or
`computers.egressProxy` is turned on with policies and no `networkPolicy.computerExtraEgress`, or with
no `secrets.egressProxyUrl` where this chart writes the Secret; or
`routines.enabled` is set with no `secrets.workerSharedSecret` — and, on `externalSecrets`, no
`worker-shared-secret` key named for it to read instead. One combination gets no refusal at all:
`secrets.existingSecret` with `routines.enabled`, because the Secret this chart would otherwise
validate is somebody else's to create — put `worker-shared-secret` in it yourself, or every pod that
mounts it fails to start — the routines CronJob, the culler, and the API server itself — with nothing
at install time to say so.

## Your own Bot

OpenBot is a shell for somebody else's agent, and `config.managedAgent.url` is where that agent goes:
an AG-UI endpoint the server pod can reach, so a Service in this cluster rather than localhost.

```yaml
config:
  managedAgent:
    url: http://my-agent.my-namespace:8000/ag-ui
secrets:
  managedAgentToken: <a long random value>
```

The token travels on every call and is required whenever a url is set. With an existing Secret or an
external store, the key is `managed-agent-token`.

Left empty, this deployment has the Bots its tenant package declares as built-in, and a coworker
somebody creates in the app without an endpoint runs here on its role description. A package entry
pointing at an endpoint that resolves to nothing is dropped rather than registered as a coworker
nobody can talk to.

## Automatic Learning

Learning is on by default, and it needs a container in the Intelligence project before it collects or
delivers anything. With nothing saved in Admin and no `config.learning.containerId`, the server
assigns the project's `openbot` container as the default by itself once it exists. The runtime key
cannot create it, so give the chart a credential that can and a setup Job creates it on install and
every upgrade:

- Managed Intelligence: a CopilotKit CLI login. Sign in into an empty folder and store the file it
  writes, then set `config.learning.setup.cliLoginSecret.name: openbot-copilotkit-cli`:

  ```sh
  COPILOTKIT_CONFIG_DIR="$(mktemp -d)"; export COPILOTKIT_CONFIG_DIR
  npx --yes copilotkit@latest login
  kubectl create secret generic openbot-copilotkit-cli \
    --from-file=config.json="$COPILOTKIT_CONFIG_DIR/auth/config.json"
  ```

  It is a person's 30-day session; only the Job reads it, never the server.
- A CopilotKit local evaluation install: a service token Secret in
  `config.learning.setup.serviceTokenSecret` with the project's numeric ID in
  `config.learning.setup.projectId`. The server gets it too, so Admin can create the container again.

Without either, create it once with `bun scripts/setup-learning.ts` from a computer that can sign in
to Intelligence, or in Intelligence itself; the server log and Admin → Automatic Learning say exactly
that. `config.learning.autoAssign: false` turns the automatic assignment off.
`config.learning.containerId` sets the initial default container
(`CPK_INTELLIGENCE_LEARNING_CONTAINER_ID`) and `config.learning.revision` the skills revision
(`CPK_INTELLIGENCE_SKILLS_REVISION`). Both are only starting values: settings saved in Admin →
Automatic Learning take precedence, including switching it off. See
[docs/automatic-learning.md](../../docs/automatic-learning.md).

## Memory and background research

Both are on by default: when a person talks to one of their Bots in a conversation with that Bot
alone, OpenBot switches on read-only background research by that Bot, and from any turn by a Bot it
makes each app the person connected in their own account a memory source for it (not on a Team Bot
somebody else published, where their accounts need consent). A person who turns either off, or
removes it, keeps it that way, through a Bot reset too.
`config.memory.sourceDefaults: false` and `config.memory.researchDefaults: false` stop new defaults
for the whole deployment.

## Slack, Teams, text messages, push, SCIM, inbound email and OpenTelemetry

Each is off until its values are set, and each is the same setting [docs/configuration.md](../../docs/configuration.md)
describes for a `.env`. Secrets go under `secrets`; with an existing Secret or an external store, use
the key in the last column.

| Feature                          | Switch                                            | Plain values                                              | Secret key                                                     |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| Slack and Teams, through OpenTag | `config.opentag.enabled`                          | `url`, `botIconUrlTemplate`                               | `opentag-shared-secret` (required, 32+ characters)             |
| Text messages, through Twilio    | `config.sms.enabled`                              | `accountSid`, `verifyServiceSid`, `fromNumber` (all three) | `twilio-auth-token` (required)                                 |
| Push and native-app sign-in      | `config.push.projectId` (the EAS project UUID)    |                                                           | `expo-access-token` (optional)                                 |
| Where Twilio calls back          | `config.deliveryPublicUrl`                        | defaults to `config.publicUrl`                            |                                                                |
| SCIM provisioning                | `config.scim.enabled`                             | `connectionId`                                            | `scim-bearer-token` (required), `scim-bearer-token-next` (optional) |
| Inbound email triggers           | `config.inboundEmail.domain` and `snsTopicArns`   | both needed, or the route is not mounted                  |                                                                |
| OpenTelemetry export             | `config.otel.endpoint` or `logsEndpoint`          | `serviceName`, `paused`                                   | `otel-logs-headers`, `otel-headers` (optional)                 |
| Composio app catalogue           | `secrets.composioApiKey` (the key is the switch)  |                                                           | `composio-api-key` (server only; see [Composio](../../docs/plugins/composio.md)) |

```yaml
config:
  opentag:
    enabled: true
    url: https://opentag.example.com
  scim:
    enabled: true
secrets:
  opentagSharedSecret: <openssl rand -hex 32>
  scimBearerToken: <openssl rand -hex 32>
```

The install refuses what the server would refuse at boot: a switch with no secret behind it (or, on
`externalSecrets`, no key named for it), an OpenTag secret under 32 characters, an OpenTag URL or icon
with the pairing off, an OpenTag URL that is not http(s) or an icon that is not https, a partial set
of Twilio settings, a push project id that is not a UUID, and a `deliveryPublicUrl` that is not
http(s). With `networkPolicy.enabled`, a collector inside the cluster has to be named in
`networkPolicy.extraEgress`; the providers themselves are reached on 443.

## Upgrading the server without the computers

`computers.mode: shared` runs one computer for every person's Bots, and on that shape the
transcript's kept screenshots need the computer image to be as new as the server's. A screenshot
only says which page it is of on a computer built after that field was added, and on a shared
computer a picture that cannot be told apart from another Bot's is refused rather than filed under
the wrong turn. The conversation still names the page it opened; it just does not show it, and the
server log says why each time.

With `computers.mode: sandbox`, each person has a computer of their own, there is nobody to race
with, and this does not arise. `external` is one computer somebody else runs, so it is the shared
case.

## A computer for each Bot

`computers.mode` decides how a Bot gets a browser:

| Mode | What it does | Needs |
| --- | --- | --- |
| `shared` | One computer for every person's Bots, run by this chart. | Nothing. |
| `sandbox` | A computer per person (and one per isolated Bot), suspended when idle and resumed with its logins intact. | The `agent-sandbox` controller in the cluster. |
| `external` | Neither; `computers.url` points at one computer somebody else runs, which every person's Bots share. | Nothing. |

`shared` is what a first install should use. Each person keeps their own browser profile and folder
for each Bot on it, so logins are not shared between people or Bots. What it cannot keep apart is a
command: every Bot's shell runs in the one container and can read another's files, which is stated
on the fleet page rather than hidden. `sandbox` gives each person a computer of their own.

`sandbox` uses `kubernetes-sigs/agent-sandbox`, whose `Sandbox` CRD is built for exactly this
workload: an isolated, stateful, singleton pod with a stable identity and persistent storage.
Suspending is `operatingMode: Suspended`, which terminates the pod and keeps the volumes.

**That controller is not installed by this chart, and the chart refuses to install without it.**
The check reads the cluster, so it is a real answer rather than a value somebody has to remember:

```sh
kubectl apply --server-side -f \
  https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.6/sandbox-with-extensions.yaml
```

Without that refusal the install succeeds, every pod is healthy, and the deployment looks finished
until the first Bot asks for a browser and the API server answers 404. Rendering offline? Pass
`--api-versions agents.x-k8s.io/v1beta1/Sandbox`.

**What decides that a computer is idle** is the audit trail, not the browser. Asking the browser
would wake it, so every computer anything asked about would come back up and the bill would never
fall. That is the known, invisible way to lose scale-to-zero: everything works, nothing suspends.

**A CronJob does the suspending, not a timer in the API.** Every replica would fire its own timer and
each would decide independently to suspend the same computer. The work is claimed and leased out of
PostgreSQL with `select ... for update skip locked`, so whichever pod runs the sweep takes what
nobody else holds, and one that dies mid-suspend hands its work back when the lease expires. The
decision is re-checked at the moment of acting, because somebody may have come back in between.

A second CronJob shares that same mechanism for a different job: `routines.enabled` turns on the
sweep that fires standing instructions a Bot was asked to carry out on a schedule, on
`routines.schedule`. It needs `secrets.workerSharedSecret` — the credential it presents to the API
server to be recognised as the worker rather than an arbitrary caller — and is off by default because
turning it on with no secret set is a CronJob whose every run is refused. See the routines refusal
below, and [docs/routines.md](../../docs/routines.md).

A third CronJob **deletes data, is on by default, and is the only one of the three that does**:
`attachments.culler` sweeps staged attachments that were never sent. A file uploaded into the
composer is stored the moment it is pasted or dropped, before anybody presses send — so closing the
tab, or changing your mind, leaves bytes in the database that no message will ever point at. The
sweep removes those, hourly (`attachments.culler.schedule`), once they are older than
`attachments.culler.olderThanHours` — **24 hours by default**.

It is on by default where the other two are off, because it needs nothing but the database that
every deployment already has, and because the alternative is a table of blobs that only grows. What
it will never remove is an attachment that was sent: those are stamped when the message they ride on
goes out, and the sweep asks only for unstamped rows. The window matters, though — a person who
uploads a file, leaves it in the composer overnight and comes back to send it will find it gone.
Raise `olderThanHours` if that is your deployment's shape, or set `attachments.culler.enabled:
false` to keep every staged row for ever and reclaim them some other way.

## NetworkPolicy, and whether your cluster enforces one

Off by default, because a NetworkPolicy on a cluster whose CNI does not enforce one is a resource
that silently does nothing, and on a cluster that does enforce one a wrong rule is an outage.

**On EKS it does nothing unless you turn it on.** The VPC CNI ships with
`--enable-network-policy=false`, so the policy installs, looks right, and is never applied. Check
before trusting it:

```sh
kubectl -n kube-system get ds aws-node -o yaml | grep enable-network-policy
```

The egress rules allow DNS, a Bot's computer on 4100, the API server when computers are Sandboxes,
and the bundled database. **A managed database is an address this chart cannot know**, so turning
the policy on with an external database and no `networkPolicy.extraEgress` is refused: on an
enforcing cluster it would fence the API off from its own database, which reads as the database
being down.

**`computers.mode: sandbox` now also requires `networkPolicy.kubernetesApiCidr`.** Two of these
policies carry a rule for the Kubernetes API server, which is where a per-Bot computer is asked for,
and the service range it answers on belongs to the cluster rather than to this release:

```sh
kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}'   # then name the range it sits in
```

Usually `172.20.0.0/16` on EKS and `10.96.0.0/12` on GKE and kubeadm. Leaving it empty used to be
allowed and meant "unscoped", which was not a looser version of the rule but the absence of one: an
egress rule with ports and no destination matches everything in Kubernetes, so the default handed
out 443 and 6443 to the private ranges the policy beside it goes to the trouble of excepting — and
on the computer culler, whose only other egress is DNS and the database, it was that pod's entire
reach. If your release has `networkPolicy.enabled` and `computers.mode: sandbox`, the next
`helm upgrade` stops with a message naming this value. Nothing in the cluster changes when it does;
set the range and run it again, and the policy is narrow for the first time.

A Bot's computer is allowed 80 and 443 to public addresses and nothing else, which is what stops a
browser reaching the cluster, the database, or the cloud's credential endpoint. That last one is
worth closing at the node as well, because this policy is off until somebody turns it on: see
`disablePodIMDS` in the EKS cluster config above. A per-Bot egress
proxy is therefore two settings rather than one: the variable that names it, and the rule that lets
the computer reach it.

```yaml
computers:
  extraEnv:
    - name: EGRESS_PROXY_DEFAULT
      value: http://proxy.internal:3128
    - name: EGRESS_PROXY_SALES_BOT
      value: http://sales.proxy.internal:3128
networkPolicy:
  computerExtraEgress:
    - to:
        - ipBlock:
            cidr: 10.4.0.0/16
      ports:
        - port: 3128
          protocol: TCP
```

`EGRESS_PROXY_DEFAULT` covers every Bot and `EGRESS_PROXY_<BOT>` names one, with the Bot's id
upper-cased and anything unusual replaced. Naming a proxy the policy provably blocks is refused at
install rather than found as a browser that fails on every page.

## Getting past bot checks

Sites behind Cloudflare decide per request whether to challenge. Three settings change what a Bot's
browser looks like to them, and the handoff (the Bot asks, a person takes control, solves the check
and hands back) is the designed fallback when they are not enough. The full explanation is in
[docs/configuration.md](../../docs/configuration.md#getting-past-bot-checks).

**Headed Chromium, on by default.** `computers.browserMode: headed` runs full Chromium on the pod's
own Xvfb, in `shared` and `sandbox` mode alike, behind the same live screen. `headless` is still
there and uses less memory; it is the browser bot checks are best at spotting.

**Web Bot Auth, off unless `config.webBotAuth: "on"`.** Every request a Bot's browser sends is
then signed as coming from this deployment, and the key is published at
`<publicUrl>/.well-known/http-message-signatures-directory`. It announces the deployment's URL to
every site a Bot visits, and it needs an https `config.publicUrl` that Cloudflare can reach, so a
private deployment leaves it off. The key is derived from `secrets.keyEncryptionKey`; `secrets.webBotAuthKey`
(an Ed25519 private JWK, key `web-bot-auth-key` in a Secret of your own) replaces it. It earns
nothing until the deployment is registered with Cloudflare, once, by hand:

1. `curl -i https://<publicUrl>/.well-known/http-message-signatures-directory` answers `200` with
   `Signature` and `Signature-Input` headers.
2. In the Cloudflare dashboard: **Manage Account** > **Configurations** > **Bot Submission Form**.
3. **Verification Method**: **Request Signature**. **Validation Instructions**: the directory URL.
   Submit, and follow it under **BotBase** > **Submission history**.

**A residential or ISP proxy, off by default and the operator's choice.** The Bots' traffic then
leaves from an address a consumer ISP owns, so sites see what looks like a person at home rather than
a datacenter. The credentialed URL is a secret:

```yaml
computers:
  egressProxy:
    enabled: true
    # existingSecret: residential-proxy      # else the chart writes secrets.egressProxyUrl
    # existingSecretKey: egress-proxy-url
networkPolicy:
  computerExtraEgress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 8000
          protocol: TCP
```

It reaches every computer as `EGRESS_PROXY_DEFAULT`, behind the egress filter, so the network
policy still decides what a Bot may reach. Turning it on with `networkPolicy.enabled` and no
`computerExtraEgress`, or with no URL where this chart holds the Secret, is refused at install.

## Upgrades

### Coming from a release before 0.0.14: a computer now runs as uid 1001

`computers.podSecurityContext` runs a Bot's computer as `pwuser`, uid 1001, in both `shared` and
`sandbox` mode. It was root before. The volumes an existing release created are root-owned, so
something has to hand them over, and that something is `fsGroup`: the kubelet takes ownership of a
volume's contents on mount.

**It does that only where the volume plugin says it can.** The EBS, PD and Azure Disk CSI drivers
do. `hostPath` does not, and `hostPath` is what rancher/local-path-provisioner hands out, which is
the default StorageClass on k3s. There the computer starts as 1001, finds a directory it cannot
write, and refuses to start rather than coming up healthy with a browser profile Chromium silently
replaced. The message names this. Two ways out:

```sh
# Either hand the existing directories to 1001 on the node, or go back to root:
helm upgrade openbot ./charts/openbot --set computers.podSecurityContext=null
```

**`--reuse-values` will not pick this up.** A new key is not in the old release's values, so an
upgrade run that way keeps running as root and says nothing. Pass the value, or drop the flag.

`fsGroupChangePolicy: OnRootMismatch` is deliberate. Unset means `Always`, which walks every file on
every mount, and a real Chromium profile is tens of thousands of small ones; in `sandbox` mode that
pass would run again on every resume from idle.

### How a rollout is sequenced

Migrations run as a `pre-install,pre-upgrade` Job, so no replica ever serves in front of a schema it
has not seen. An init container would mean every replica racing to migrate the same database.

Roll back a failed upgrade rather than leaving half a rollout: `helm upgrade --install --atomic` on
Helm 3, and `--rollback-on-failure` on Helm 4, which renamed the flag. Helm 4 still accepts
`--atomic` on `upgrade` as a deprecated alias and prints a warning, so the Helm 3 spelling keeps
working on both today; it is `helm install --atomic` that Helm 4 removed outright, which is one more
reason this is written as `upgrade --install`.
