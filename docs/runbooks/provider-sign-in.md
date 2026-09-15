# Provider sign-in

Provider sign-in changes only the provider-owned auth volume on the worker host. Do not put provider credentials in AWS Secrets Manager, the OpenBot database, an image, or this repository.

## Before you start

Deploy the worker host and start `openbot-worker.service`. Get its instance ID from Terraform:

```bash
terraform -chdir=infra/aws/environments/personal output -raw worker_instance_id
```

Start an AWS Systems Manager session. Replace the instance ID with the value from the prior command:

```bash
aws ssm start-session --target i-0123456789abcdef0
```

On the worker host, change to the deployment directory:

```bash
cd /opt/openbot/deploy/aws
```

## Sign in to Codex

Start the official device-code flow inside the Codex gateway container:

```bash
sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml exec codex-gateway codex login --device-auth
```

Open the shown link in your own browser. Sign in to the intended ChatGPT account and enter the one-time code. Do not paste the code or any token into OpenBot, logs, chat, or source control.

Check the login through the CLI. This command reports the auth method without reading or printing `auth.json`:

```bash
sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml exec codex-gateway codex login status
```

Then check gateway readiness from the worker host:

```bash
curl --fail --silent http://127.0.0.1:4210/ready
```

The response must show `"provider":"codex"` and `"authReady":true`. Exit the SSM session when the check passes.

Codex owns `/home/gateway/.codex` in the container. Compose mounts it from the retained encrypted volume at `/srv/openbot-auth/codex`, so the login survives a container or image replacement. The Codex service cannot mount the Claude or Grok auth volumes.

If readiness later reports `authReady:false`, repeat the device-code flow. Do not copy the auth cache into an image or secret store.

## Claude release gate

Do not enable or sign in to the Claude gateway until the owner records a current authentication-use review for this exact owner-only deployment. Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says subscription OAuth is for ordinary use of Claude Code and other native Anthropic applications. It directs developers who build products or services to API-key authentication and bars routing Free, Pro, or Max credentials on behalf of users. This private, self-hosted, single-owner use is not an on-behalf-of-users service, but the page does not state that this wrapper is allowed.

Treat that gap as a stop condition. Get written guidance from Anthropic or use a supported API, Team, or Enterprise authentication route before the first live run. Repeat this check before each Claude CLI upgrade. Do not treat a working login as proof that the use is allowed.

Anthropic also states that, from June 15, 2026, `claude -p` use on subscription plans draws from a separate monthly Agent SDK credit. Check the current plan allowance before enabling this worker.

## Sign in to Claude after the release gate passes

Start the official Claude.ai login inside the Claude gateway container:

```bash
sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml --profile claude-subscription up -d claude-gateway

sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml --profile claude-subscription exec claude-gateway claude auth login
```

Select the Claude.ai subscription route, not the Console route. On an SSM or container session, the browser callback will usually not reach the remote CLI. Copy the shown URL into your own browser. After sign-in, paste the shown one-time login code back into the terminal when Claude asks for it.

Do not run `claude setup-token`. Do not set `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN`. Those paths would turn the login into an application credential or select API billing. The gateway starts the unmodified CLI and never reads its credential file.

Check the selected login method without opening or copying the credential file:

```bash
sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml --profile claude-subscription exec claude-gateway claude auth status --text
```

The status must show a Claude.ai subscription login. Then check the pinned version, managed policy, and gateway readiness:

```bash
sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml --profile claude-subscription exec claude-gateway claude --version

sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml --profile claude-subscription exec claude-gateway claude doctor

curl --fail --silent http://127.0.0.1:4211/ready
```

The version must match the pinned image version. `claude doctor` must report that the Linux managed settings loaded from `/etc/claude-code/managed-settings.json`. The readiness response must show `"provider":"claude"` and `"authReady":true`.

Claude owns `CLAUDE_CONFIG_DIR=/home/gateway/.claude`. Compose mounts that directory from `/srv/openbot-auth/claude` on its retained encrypted volume. The Claude service cannot mount Codex or Grok login data. The managed policy blocks native tool access to the Claude login directory and gateway state. It uses Claude's documented weaker nested sandbox mode because the outer non-root container drops all capabilities, has a read-only root, has no Docker socket, and cannot create a privileged namespace. Do not run the Claude gateway with a wider container profile. Exit the SSM session after all checks pass.

If readiness later reports `authReady:false`, run `claude auth login` again. Never print, copy, back up, or move the Claude credential file.

## Sign in to Grok

Start xAI's device-code flow inside the Grok gateway container:

```bash
sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml exec grok-gateway grok login --device-auth
```

Open the shown link in your own browser. Sign in to the intended Grok account and enter the one-time code. Do not paste the code or any token into OpenBot, logs, chat, or source control.

Check the installed version and the enforced policy without reading Grok's auth files:

```bash
sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml exec grok-gateway grok --version

sudo docker compose --env-file /etc/openbot/worker.env \
  -f compose.worker.yml exec grok-gateway grok inspect --json >/dev/null

curl --fail --silent http://127.0.0.1:4212/ready
```

The version must match the pinned image version. The readiness response must show `"provider":"grok"` and `"authReady":true`. The root-owned requirements file pins the strict Linux sandbox, removes child-process secrets, blocks reads of Grok login data and common repository secret files, disables provider subagents, and blocks direct publish tools.

Grok owns `GROK_HOME=/home/gateway/.grok`. Compose mounts that directory from `/srv/openbot-auth/grok`, so the login survives a container or image replacement. The Grok service cannot mount Codex or Claude login data. If readiness later reports `authReady:false`, repeat the device-code flow. Never print, copy, back up, or move the Grok credential files.
