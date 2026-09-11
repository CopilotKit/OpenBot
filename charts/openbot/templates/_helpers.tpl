{{/*
Shared shapes, so a component template says what is different about it and nothing else.

Anything defined here is used by more than one component, or is a decision worth making in exactly
one place. A helper used once belongs in the template that uses it.
*/}}

{{- define "openbot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openbot.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openbot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openbot.labels" -}}
helm.sh/chart: {{ include "openbot.chart" . }}
{{ include "openbot.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "openbot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openbot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Labels for one component, so two workloads in one release never select each other's pods. */}}
{{- define "openbot.componentLabels" -}}
{{ include "openbot.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "openbot.componentSelectorLabels" -}}
{{ include "openbot.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "openbot.componentName" -}}
{{- printf "%s-%s" (include "openbot.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
The same name, under the shorter limit Kubernetes puts on a CronJob.

FIFTY-TWO, NOT SIXTY-THREE. A CronJob is the one workload whose name is not the whole budget: the
controller names each Job it creates `<cronjob>-<unix-minute>`, so the API server refuses a CronJob
whose own name leaves no room for that suffix — "must be no more than 52 characters". Sixty-three is
the right limit for every other object this chart writes and the wrong one here, and the failure is
not a truncated name, it is `helm install` rejected outright.

Reached at a 43-character release name, which is an ordinary length for a name that says the
environment and the region. All three of this chart's CronJobs were built on the 63-character helper
and all three were rejected together.

THE RELEASE NAME IS TRUNCATED, NOT THE WHOLE STRING, so the component survives. Cutting the joined
name at 52 would give a long release two CronJobs called the same thing — `...-routines` and
`...-culler` both ending as the first 52 characters of the release name — which is a release that
cannot install for a second, stranger reason. Trimming the prefix instead keeps the suffix that says
which sweep this is, which is the part a person reads.
*/}}
{{- define "openbot.cronJobName" -}}
{{- $room := int (max 1 (sub 51 (len .component))) -}}
{{- $prefix := include "openbot.fullname" .root | trunc $room | trimSuffix "-" -}}
{{- printf "%s-%s" $prefix .component | trunc 52 | trimSuffix "-" -}}
{{- end -}}

{{/*
Whether the staged-attachment sweep runs.

ONE ANSWER FOR TWO TEMPLATES, because the CronJob and the NetworkPolicy that fences it must agree:
a sweep with no policy is the one pod left unfenced on a cluster that enforces them, and a policy
with no sweep is a resource selecting nothing. They were two copies of the same expression, which is
the shape that drifts.

GUARDED AT BOTH LEVELS, AND DEFAULTED TO ON. `attachments` is a key this chart did not have before,
and `helm upgrade --reuse-values` takes the previous release's computed values rather than merging
the new chart's defaults, so on every existing deployment the whole map is absent — and on a release
installed between the two, `culler` is present without `enabled`. `(.Values.attachments).culler.enabled`
parenthesises one level of that and reads the next two bare: with `enabled` missing the sweep and its
policy silently did not render at all, and with `culler` missing the render died on a nil pointer,
which fails the install rather than the feature.

`kindIs "invalid"` rather than `| default true`, for the reason `commonEnv` gives above: sprig's
`default` substitutes on EMPTY, and `false` is empty, so `| default true` would switch the sweep back
on for the deployment that had deliberately switched it off.

IT ANSWERS THE SAME QUESTION ITS SIBLINGS DO, WHICH IT USED NOT TO. This used to hand the value back
untouched for its callers to compare against the string `"true"`, and a string comparison is not what
`if .Values.routines.enabled` next door does. `--set attachments.culler.enabled=1` reaches a template
as the integer 1, and `=yes` reaches it as the string "yes". Go's templating calls both of those
true, so the routines CronJob renders for either — while this returned "1" or "yes", matched neither
caller, and rendered NEITHER the CronJob NOR the NetworkPolicy that fences it. No error, no resource,
and an operator with every reason to believe the sweep was on. Both spellings were driven through
`helm template` before this changed and after. The answer is now the template engine's own notion of
truth, which is the one the rest of the chart was already using.

THE ONE VALUE IT REFUSES RATHER THAN HONOURS, because agreeing with the siblings here would have been
a regression rather than a fix. That same notion of truth calls the non-empty string "false" TRUE, so
`--set-string attachments.culler.enabled=false` would start the sweep for somebody who had just
written the word false. The old string comparison happened to get that one case right, and a fix is
not allowed to take a correct behaviour away. There is no reading of `--set-string ...=false` that
means ON and no safe way to guess, so it fails the render with a message naming `--set` instead. That
is a narrower rule than it looks: only a STRING spelling a falsehood ever reaches it, and `--set`,
which parses `false` into a boolean, cannot produce one.
*/}}
{{- define "openbot.attachmentsCullerEnabled" -}}
{{- $culler := (.Values.attachments | default dict).culler | default dict -}}
{{- $enabled := $culler.enabled -}}
{{- if kindIs "invalid" $enabled -}}
true
{{- else if and (kindIs "string" $enabled) (has (lower $enabled) (list "false" "no" "off" "n" "0")) -}}
{{- fail (printf "attachments.culler.enabled is the string %q, and this chart will not guess which way you meant it. Helm's templating reads every non-empty string as true, so honouring it would turn the staged-attachment sweep ON, which is the opposite of what it spells. Pass a boolean instead: --set attachments.culler.enabled=false, or enabled: false in a values file. --set-string is what made it a string." $enabled) -}}
{{- else if $enabled -}}
true
{{- else -}}
false
{{- end -}}
{{- end -}}

{{/*
The service range the Kubernetes API server answers on, or a refusal to render a policy without it.

ONE ANSWER FOR TWO TEMPLATES, for the same reason as the sweep gate above: the API server's policy
and the computer culler's both need this rule, and both had it wrong in exactly the same way.

WHY THIS REFUSES INSTEAD OF DEFAULTING. Both policies used to write the rule as
`- {{ with .Values.networkPolicy.kubernetesApiCidr }}to: ...{{ end }}` and let the empty default fall
straight through the `with`. What fell out was an egress rule carrying ports and NO PEER AT ALL, and
in Kubernetes that is neither a narrow rule nor an inert one: an empty or absent `to` matches every
destination. So the shipped default granted 443 and 6443 to everything, which cancelled the `10/8`,
`172.16/12`, `192.168/16` and `169.254/16` exceptions the rule one line above it spells out. On the
culler, whose only other egress is DNS and the database, that peerless rule WAS its entire reach: a
pod holding the database credential could open an HTTPS socket to any address in the cluster or on
the internet. Rendered and read back before any of this was believed.

THE TWO ALTERNATIVES, AND WHY NEITHER. Rendering no rule at all when nobody has named a CIDR is safe
and silent, and silent is the whole problem: on a cluster that enforces policy the API server can no
longer ask for a Bot's computer, so every browser action fails and the deployment looks broken rather
than fenced — which is the exact failure the comment two rules above this one warns about. Picking a
default CIDR is worse: the range belongs to the cluster and not to the release, so `172.20.0.0/16` is
right on EKS and an outage on GKE, and a wrong CIDR is that outage with a plausible-looking values
file standing behind it. Refusing is the only one of the three that cannot be wrong quietly, and it
is what this chart does everywhere else a value is unknowable and load-bearing. `helm upgrade`
renders before it applies anything, so a release that hits this keeps running exactly as it was while
its operator runs the single command in the message.

SCOPED TO THE POLICIES THAT NEED IT. Reached only from inside `networkPolicy.enabled` and
`computers.mode: sandbox`, so a deployment with no policies, or with `mode: shared`, never has to
name it. Nothing else in the chart consults it.
*/}}
{{- define "openbot.kubernetesApiCidr" -}}
{{- $cidr := .Values.networkPolicy.kubernetesApiCidr -}}
{{- if not $cidr -}}
{{- fail "networkPolicy.kubernetesApiCidr is required when networkPolicy.enabled is true and computers.mode is sandbox. It is the service range the Kubernetes API server answers on, which is where a per-Bot computer is asked for, and this chart cannot know it: the range belongs to the cluster rather than to this release. Find the address with: kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}' - then name the range it sits in, usually 172.20.0.0/16 on EKS and 10.96.0.0/12 on GKE and kubeadm. It was previously allowed to be empty, which rendered an egress rule with no destination at all: that permitted 443 and 6443 to every address rather than to the API server, so setting this narrows the policy that was already meant to be narrow." -}}
{{- end -}}
{{- $cidr -}}
{{- end -}}

{{- define "openbot.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "openbot.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The image, with the chart's appVersion as the tag unless one is named. */}}
{{- define "openbot.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "openbot.secretName" -}}
{{- default (printf "%s-secrets" (include "openbot.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "openbot.configMapName" -}}
{{- printf "%s-config" (include "openbot.fullname" .) -}}
{{- end -}}

{{/*
Where the database is.

One definition, because the migrations Job and the API must never disagree about it: a Job that
migrated one database while the API talked to another is a failure that looks like a missing table.
*/}}
{{- define "openbot.databaseUrlEnv" -}}
{{- if .Values.postgresql.enabled -}}
{{- /*
  THE PASSWORD IS DECLARED FIRST, AND THAT IS NOT A STYLE CHOICE.

  Kubernetes expands `$(VAR)` in an env value only from variables defined earlier in the same list.
  Declared after, the reference is left as the literal text `$(POSTGRES_PASSWORD)` and handed to the
  server as the password, which fails authentication with `28P01` and reads exactly like a wrong
  password rather than like a template that did not expand.
*/}}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ default (printf "%s-postgresql" .Release.Name) .Values.postgresql.auth.existingSecret }}
      {{- /* The subchart keeps the superuser's password under its own key, not `password`. */}}
      key: {{ eq .Values.postgresql.auth.username "postgres" | ternary "postgres-password" "password" }}
- name: DATABASE_URL
  value: postgres://{{ .Values.postgresql.auth.username }}:$(POSTGRES_PASSWORD)@{{ .Release.Name }}-postgresql:5432/{{ .Values.postgresql.auth.database }}
{{- else if .Values.database.existingSecret -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.existingSecret }}
      key: {{ .Values.database.existingSecretKey }}
{{- else -}}
- name: DATABASE_URL
  value: {{ .Values.database.url | quote }}
{{- end -}}
{{- end -}}

{{/*
Everything the API reads that is not the database.

Secrets are referenced, never rendered: a value that appears here would appear in `helm get values`
and in whatever holds the release, which is not where `KEY_ENCRYPTION_KEY` belongs.
*/}}
{{- define "openbot.commonEnv" -}}
- name: PORT
  value: {{ .Values.server.service.port | quote }}
- name: NODE_ENV
  value: production
- name: EMBEDDED_POSTGRES
  value: "off"
{{- /* The switch that makes a replica a replica: no browser in an API pod. */}}
- name: EMBEDDED_COMPUTER
  value: {{ ternary "on" "off" .Values.server.embeddedComputer | quote }}
- name: TENANT_PACKAGE_DIR
  value: {{ .Values.config.tenantPackageDir | quote }}
{{- if .Values.config.publicUrl }}
- name: OPENBOT_PUBLIC_URL
  value: {{ .Values.config.publicUrl | quote }}
- name: BETTER_AUTH_URL
  value: {{ .Values.config.publicUrl | quote }}
{{- end }}
{{- if .Values.config.initialAdminEmails }}
- name: INITIAL_ADMIN_EMAILS
  value: {{ .Values.config.initialAdminEmails | quote }}
{{- end }}
{{- if .Values.config.singleUser }}
- name: OPENBOT_SINGLE_USER
  value: "true"
{{- end }}
{{- if .Values.config.logLevel }}
- name: LOG_LEVEL
  value: {{ .Values.config.logLevel | quote }}
{{- end }}
{{- /*
  Where this deployment's Bots find a computer, decided by the mode rather than by the operator.

  `shared` addresses the StatefulSet's one pod by its stable name, which is what a headless Service
  gives it. `external` takes the URL as written. `sandbox` sets neither: the provider asks the
  cluster for each Bot's own computer and gets an address back, so a fixed URL would be the one
  thing that could send every Bot to the same browser.
*/}}
{{- if eq .Values.computers.mode "shared" }}
- name: AGENT_COMPUTER_URL
  value: http://{{ include "openbot.componentName" (dict "root" . "component" "computer") }}-0.{{ include "openbot.componentName" (dict "root" . "component" "computer") }}:4100
{{- else if and (eq .Values.computers.mode "external") .Values.computers.url }}
- name: AGENT_COMPUTER_URL
  value: {{ .Values.computers.url | quote }}
{{- else if eq .Values.computers.mode "sandbox" }}
- name: COMPUTER_SANDBOX_NAMESPACE
  value: {{ default .Release.Namespace .Values.computers.sandbox.namespace | quote }}
- name: COMPUTER_SANDBOX_IDLE_AFTER
  value: {{ .Values.computers.sandbox.idleAfter | quote }}
- name: COMPUTER_SANDBOX_TEMPLATE_FILE
  value: /etc/openbot/sandbox-template.json
{{- end }}
{{- /*
  How far one Bot may hand work to another.
  
  Always set, so a deployment that has switched this off says so rather than relying on the image's
  default staying what it is today.

  ABSENT AND ZERO ARE DIFFERENT, which is why this is not `| default`. Sprig's `default` substitutes
  whenever a value is EMPTY, and zero is empty: `--set config.handoff.maxDepth=0` rendered `"1"` and
  silently switched the capability back on for a deployment that had switched it off. A guard that
  defeats the off switch is worse than the nil dereference it was added for. `kindIs "invalid"` asks
  the question actually being asked, which is whether anybody said anything at all.

  PARENTHESISED, because `config.handoff` is a key this chart did not have before.
  `helm upgrade --reuse-values` takes the previous release's computed values instead of merging the
  new chart's defaults, so on every existing deployment this map is simply absent. Reached with a
  bare `.Values.config.handoff.maxDepth` that is a nil dereference, and it fails the WHOLE render:
  this helper is included by the server deployment, so the upgrade does not lose the handoff
  feature, it does not install at all.
*/}}
{{- $handoff := .Values.config.handoff | default dict -}}
{{- $maxDepth := 1 -}}
{{- if not (kindIs "invalid" $handoff.maxDepth) -}}{{- $maxDepth = $handoff.maxDepth -}}{{- end -}}
{{- $maxPerRun := 3 -}}
{{- if not (kindIs "invalid" $handoff.maxPerRun) -}}{{- $maxPerRun = $handoff.maxPerRun -}}{{- end }}
- name: BOT_HANDOFF_MAX_DEPTH
  value: {{ $maxDepth | quote }}
- name: BOT_HANDOFF_MAX_PER_RUN
  value: {{ $maxPerRun | quote }}
- name: INTELLIGENCE_API_URL
  value: {{ .Values.config.intelligence.apiUrl | quote }}
- name: INTELLIGENCE_GATEWAY_WS_URL
  value: {{ .Values.config.intelligence.gatewayWsUrl | quote }}
- name: INTELLIGENCE_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" . }}
      key: intelligence-api-key
{{- if .Values.secrets.licenseToken }}
- name: COPILOTKIT_LICENSE_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" . }}
      key: license-token
{{- end }}
{{- with .Values.config.managedAgent.url }}
- name: MANAGED_AGENT_AG_UI_URL
  value: {{ . | quote }}
- name: MANAGED_AGENT_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" $ }}
      key: managed-agent-token
{{- end }}
{{- with .Values.config.auth.google.clientId }}
- name: GOOGLE_OAUTH_CLIENT_ID
  value: {{ . | quote }}
- name: GOOGLE_OAUTH_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" $ }}
      key: google-client-secret
{{- end }}
{{- with .Values.config.auth.microsoft.clientId }}
- name: MICROSOFT_OAUTH_CLIENT_ID
  value: {{ . | quote }}
- name: MICROSOFT_OAUTH_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" $ }}
      key: microsoft-client-secret
{{- end }}
{{- with .Values.config.auth.microsoft.tenantId }}
- name: MICROSOFT_OAUTH_TENANT_ID
  value: {{ . | quote }}
{{- end }}
{{- with .Values.config.auth.okta.clientId }}
- name: OKTA_OAUTH_CLIENT_ID
  value: {{ . | quote }}
- name: OKTA_OAUTH_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" $ }}
      key: okta-client-secret
{{- end }}
{{- with .Values.config.auth.okta.issuer }}
- name: OKTA_OAUTH_ISSUER
  value: {{ . | quote }}
{{- end }}
- name: KEY_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" . }}
      key: key-encryption-key
{{- /*
  Optional only while it genuinely is.
  
  With no identity provider there is no sign-in and nothing to sign, so an absent key is correct.
  With one configured the server refuses to start without it, and `optional: true` turned that into a
  crash loop rather than a container that says which key is missing. It also hid the whole path from
  the render check, which skips optional keys: a deployment supplying its own Secret without this in
  it rendered clean and then never came up.
*/}}
- name: BETTER_AUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" . }}
      key: better-auth-secret
      optional: {{ not (or .Values.config.auth.google.clientId .Values.config.auth.microsoft.clientId .Values.config.auth.okta.clientId) }}
- name: OPENAI_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" . }}
      key: model-api-key
      optional: true
- name: COMPUTER_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ default (include "openbot.secretName" .) .Values.computers.existingTokenSecret }}
      key: computer-token
      optional: {{ eq .Values.computers.mode "external" }}
{{- /*
  One definition, for the same reason `openbot.databaseUrlEnv` is one (see its comment above): the
  API server needs this value to RECOGNISE the worker, and the routines CronJob needs the same value
  to BE the worker. Two definitions could drift; this can't. Gated on `routines.enabled` so a
  deployment that never turns routines on gets no env var pointing at a key its secret store may not
  hold.

  Above `config.extraEnv`, not below it: Kubernetes takes the last of a duplicate name, and this must
  lose to an operator's own value, not win over it. Below it, this chart's own secretKeyRef would
  override whatever `extraEnv` set, which turns the escape hatch into a trap for the one variable
  someone would need it for.
*/}}
{{- if (.Values.routines).enabled }}
- name: WORKER_SHARED_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" . }}
      key: worker-shared-secret
{{- end }}
{{- with .Values.config.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Keeping replicas apart.

Soft by default, so a one-node cluster still schedules. A deployment that means it sets
`podAntiAffinity: hard` and gets a replica per node, or writes its own `affinity` and gets neither.
*/}}
{{- define "openbot.podAntiAffinity" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- if $root.Values.server.affinity -}}
{{ toYaml $root.Values.server.affinity }}
{{- else if eq (default "soft" $root.Values.server.podAntiAffinity) "hard" -}}
podAntiAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
    - topologyKey: kubernetes.io/hostname
      labelSelector:
        matchLabels:
{{ include "openbot.componentSelectorLabels" (dict "root" $root "component" $component) | indent 10 }}
{{- else if eq (default "soft" $root.Values.server.podAntiAffinity) "soft" -}}
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
{{ include "openbot.componentSelectorLabels" (dict "root" $root "component" $component) | indent 12 }}
{{- end -}}
{{- end -}}

{{/*
The pod and volumes every Bot's computer is cut from, as JSON.

One definition, used by the ConfigMap the server reads and by the SandboxTemplate a warm pool cuts
from, so a pre-warmed computer and one created on demand cannot drift into being different things.

NO CLUSTER CREDENTIAL. Every pod gets a service account token mounted unless it says otherwise, so
the container that opens pages a person named and runs commands a model chose was carrying one. It
could not do much with it, which is not the point: this is the last pod in the deployment that should
be able to address the API server at all, and the default is the wrong way round.
*/}}
{{- define "openbot.sandboxPodTemplate" -}}
{{- $spec := dict
  "podTemplate" (dict
    "metadata" (dict "labels" (dict
      "app.kubernetes.io/name" (include "openbot.name" .)
      "app.kubernetes.io/instance" .Release.Name
      "app.kubernetes.io/component" "computer"))
    "spec" (dict
      "terminationGracePeriodSeconds" 30
      "automountServiceAccountToken" false
      "containers" (list (dict
        "name" "computer"
        "image" (include "openbot.image" .)
        "imagePullPolicy" .Values.image.pullPolicy
        "command" (list "/usr/local/bin/bun" "/app/agent-computer/src/index.ts")
        "ports" (list (dict "name" "http" "containerPort" 4100))
        "env" (concat
          (list
            (dict "name" "PORT" "value" "4100")
            (dict "name" "WORKSPACE_DIR" "value" "/workspace")
            (dict "name" "PROFILES_DIR" "value" "/profiles")
            (dict "name" "COMPUTER_TOKEN" "valueFrom" (dict "secretKeyRef" (dict
              "name" (default (include "openbot.secretName" .) .Values.computers.existingTokenSecret)
              "key" "computer-token"))))
          .Values.computers.extraEnv)
        "volumeMounts" (list
          (dict "name" "profiles" "mountPath" "/profiles")
          (dict "name" "workspace" "mountPath" "/workspace"))
        "readinessProbe" (dict
          "httpGet" (dict "path" "/health" "port" "http")
          "periodSeconds" 10
          "failureThreshold" 6)
        "resources" .Values.computers.resources)))) -}}
{{- $pod := index $spec "podTemplate" -}}
{{- $podSpec := index $pod "spec" -}}
{{- with .Values.computers.runtimeClassName }}{{- $_ := set $podSpec "runtimeClassName" . }}{{- end }}
{{- with .Values.imagePullSecrets }}{{- $_ := set $podSpec "imagePullSecrets" . }}{{- end }}
{{- with .Values.computers.nodeSelector }}{{- $_ := set $podSpec "nodeSelector" . }}{{- end }}
{{- with .Values.computers.tolerations }}{{- $_ := set $podSpec "tolerations" . }}{{- end }}
{{- $claim := dict
  "accessModes" (list "ReadWriteOnce")
  "resources" (dict "requests" (dict "storage" .Values.computers.persistence.profilesSize)) -}}
{{- $work := dict
  "accessModes" (list "ReadWriteOnce")
  "resources" (dict "requests" (dict "storage" .Values.computers.persistence.workspaceSize)) -}}
{{- with .Values.computers.persistence.storageClass }}
{{- $_ := set $claim "storageClassName" . }}{{- $_ := set $work "storageClassName" . }}
{{- end }}
{{- /*
  A Service, which is the whole reason a computer has a stable address.

  Without it the controller creates the pod and reports no `serviceFQDN`, so the sandbox is Ready and
  unreachable: `locate` waits for an address that is never coming and times out. A pod IP would be
  the wrong answer anyway, because it changes on every resume, which is exactly what a suspended
  computer does.
*/}}
{{- $_ := set $spec "service" true -}}
{{- $_ := set $spec "volumeClaimTemplates" (list
  (dict "metadata" (dict "name" "profiles") "spec" $claim)
  (dict "metadata" (dict "name" "workspace") "spec" $work)) -}}
{{ toPrettyJson $spec }}
{{- end -}}

{{/*
Whether the API pod gets a Kubernetes token.

FALSE UNLESS IT ACTUALLY NEEDS ONE. The API talks to a database and to Bots, not to the cluster, so a
mounted token is a credential sitting in a pod that has no use for it. `computers.mode: sandbox` is
the exception and the only one: there the server asks the API server to create, resume and suspend a
Sandbox per Bot, and without a token it fails on the first browser action with a missing file rather
than anything that names the cause.
*/}}
{{- define "openbot.automountToken" -}}
{{- or .Values.serviceAccount.automountServiceAccountToken (eq .Values.computers.mode "sandbox") -}}
{{- end -}}

