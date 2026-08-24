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
{{- else if eq .Values.computers.mode "sandbox" }}
- name: COMPUTER_SANDBOX_NAMESPACE
  value: {{ default .Release.Namespace .Values.computers.sandbox.namespace | quote }}
- name: COMPUTER_SANDBOX_IDLE_AFTER
  value: {{ .Values.computers.sandbox.idleAfter | quote }}
{{- end }}
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
- name: BETTER_AUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "openbot.secretName" . }}
      key: better-auth-secret
      optional: true
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
