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
{{- else if has .Values.computers.mode (list "sandbox" "vm") }}
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
- name: COPILOTKIT_LICENSE_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" . }}
      key: license-token
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
        "command" (list "/bin/bash" "-lc")
        "args" (list "if [ -x /app/agent-computer/entrypoint.sh ]; then exec /app/agent-computer/entrypoint.sh; fi; exec /usr/local/bin/bun /app/agent-computer/src/index.ts")
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
mounted token is a credential sitting in a pod that has no use for it. Per-Bot `sandbox` and `vm`
modes are the exceptions: there the server asks the API server to create, resume and suspend a
Sandbox per Bot, and without a token it fails on the first browser action with a missing file rather
than anything that names the cause.
*/}}
{{- define "openbot.automountToken" -}}
{{- or .Values.serviceAccount.automountServiceAccountToken (has .Values.computers.mode (list "sandbox" "vm")) -}}
{{- end -}}
