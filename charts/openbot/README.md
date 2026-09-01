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
docker manifest inspect ghcr.io/copilotkit/openbot:v0.0.5 | grep architecture
```

**Intelligence credentials.** OpenBot requires CopilotKit Intelligence and the chart refuses to
install without `secrets.intelligenceApiKey` and `secrets.licenseToken`. Both come from the CLI, on
any machine with a browser:

```sh
npx --yes copilotkit@latest login           # browser sign-in
npx --yes copilotkit@latest project select  # prints the cpk-... runtime key
npx --yes copilotkit@latest license --print # prints the licence token
```

`--print` rather than `--write` here: `--write` puts the token in a local `.env`, which is what a
laptop wants and not what you are about to paste into a Secret. The free plan is enough to install.

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
```

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

**The migrating role has to be able to create and drop the `vector` extension.** The first migration
creates it and a later one drops it again. On a managed database, create it once as the
administrative role; `CREATE EXTENSION IF NOT EXISTS` then passes for an ordinary user.

## The five targets

`ci/` holds a values file per target, and each is the shortest thing that expresses what is different
about that cluster:

| File | What it shows |
| --- | --- |
| `self-hosted-values.yaml` | Nothing turned on. If this file needs to grow, a default is wrong. |
| `eks-values.yaml` | IRSA, Secrets Manager, ALB, zone spread, autoscaling. |
| `eks-sandbox-values.yaml` | The same, with a computer each rather than one shared browser. `shared` and `sandbox` render a different Deployment, different RBAC and a different pod template, so a target that renders only one checks half the chart. |
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

The API tier holds nothing on disk. Per-Bot computers do, and the ordinary block volume on all three
clouds is **zonal**: once provisioned, every pod referencing it is scheduled into that zone, so a
Bot's computer is pinned to a zone for as long as its profile exists. That is
acceptable and worth stating rather than discovering. `storageClass` stays empty by default, meaning
the cluster's default class, because naming `gp3` or `pd-balanced` here is how a chart stops
installing on somebody's bare-metal cluster.

## Refused at install, not in a crash loop

The chart fails the install, naming the value to change, when: there is no database or two of them;
nobody would be an administrator; `singleUser` is combined with a public URL; both an Ingress and an
HTTPRoute are enabled; both `externalSecrets` and an existing Secret are named; a Bot endpoint is
named with no token to call it with; a browser is asked for inside more than one API replica; or
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

Left empty, this deployment has the Bots its tenant package declares as built-in and no others. A
package entry pointing at an endpoint that resolves to nothing is dropped rather than registered as a
coworker nobody can talk to.

## Upgrading the server without the computers

`computers.mode: shared` runs one browser for every Bot, and on that shape the transcript's kept
screenshots need the computer image to be as new as the server's. A screenshot only says which page
it is of on a computer built after that field was added, and on a shared browser a picture that
cannot be told apart from another Bot's is refused rather than filed under the wrong turn. The
conversation still names the page it opened; it just does not show it, and the server log says why
each time.

With `computers.mode: sandbox`, `vm`, or `external`, each Bot has a computer of its own, there is nobody to
race with, and this does not arise.

## A computer for each Bot

`computers.mode` decides how a Bot gets a browser:

| Mode | What it does | Needs |
| --- | --- | --- |
| `shared` | One browser for every Bot, run by this chart. | Nothing. |
| `sandbox` | A computer each, suspended when idle and resumed with its logins intact. | The `agent-sandbox` controller in the cluster. |
| `vm` | A full graphical computer for each Bot inside its own lightweight VM, suspended when idle and resumed with its logins intact. | The `agent-sandbox` controller and a VM-backed RuntimeClass such as Kata Containers. |
| `external` | Neither; `computers.url` points at one somebody else runs. | Nothing. |

`shared` is what a first install should use. Sessions, files and logins are shared between Bots in
that mode, which is stated on the fleet page rather than hidden.

`sandbox` uses `kubernetes-sigs/agent-sandbox`, whose `Sandbox` CRD is built for exactly this
workload: an isolated, stateful, singleton pod with a stable identity and persistent storage.
Suspending is `operatingMode: Suspended`, which terminates the pod and keeps the volumes.

`vm` uses that same lifecycle but refuses to render without `computers.runtimeClassName`. Point it at
a VM-backed runtime such as `kata-qemu`: each Bot's browser, desktop, shell, profile and workspace
then live behind their own guest kernel rather than sharing the node kernel. The chart can require a
RuntimeClass name but cannot inspect what an operator mapped that name to, so verifying the class is
Kata or another microVM runtime remains a cluster installation step.

```yaml
computers:
  mode: vm
  runtimeClassName: kata-qemu
```

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

A Bot's computer is allowed 80 and 443 to public addresses and nothing else, which is what stops a
browser reaching the cluster, the database, or the cloud's credential endpoint. A per-Bot egress
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

## Upgrades

Migrations run as a `pre-install,pre-upgrade` Job, so no replica ever serves in front of a schema it
has not seen. An init container would mean every replica racing to migrate the same database.

Roll back a failed upgrade rather than leaving half a rollout: `helm upgrade --install --atomic` on
Helm 3, and `--rollback-on-failure` on Helm 4, which renamed the flag. Helm 4 still accepts
`--atomic` on `upgrade` as a deprecated alias and prints a warning, so the Helm 3 spelling keeps
working on both today; it is `helm install --atomic` that Helm 4 removed outright, which is one more
reason this is written as `upgrade --install`.
