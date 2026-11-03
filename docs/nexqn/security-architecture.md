# Security architecture

What NexQN inherits from OpenBot, what it adds, and the rules every NexQN module must follow.
Threats and residual risks are in [security-threat-model.md](security-threat-model.md).

## Inherited controls (OpenBot, verified in code)

| Control | Where |
| --- | --- |
| Server-side auth and admin checks on every route | `server/src/auth/guards.ts`, `server/src/admin/gate.ts` |
| Refuses to start with no IdP unless `OPENBOT_SINGLE_USER=true`, and refuses that flag on a public address | `docs/architecture.md` "Security boundaries" |
| Credential vault, AES-GCM, `KEY_ENCRYPTION_KEY` (example key refused in production) | `server/src/credentials.ts` |
| SSO client secrets and SAML material encrypted at rest | `server/src/auth/encrypt-sso-config.ts` |
| Action policy in CEL, deny before allow, fail closed | `action_policy`, policy engine in `server/src/computer/` |
| Approvals (allow / deny / require approval), per person and team | `server/src/approvals/` |
| Append-only audit with initiator, CSV export, retention | `server/src/audit.ts`, migration `0012` |
| MCP: admin-governed, URL checks, unknown tools treated as writes, per-user OAuth | `server/src/plugins/` |
| Per-person / per-Bot computer containers, token-gated, loopback-bound | `agent-computer/`, `supervisor/` |
| Egress filter per Bot, cloud metadata always refused | `agent-computer` filter proxy |
| Database on a separate Docker network from computers | `docker-compose.yml` `data` network |
| Optional gVisor (`COMPUTER_RUNTIME=runsc`) | supervisor |
| Untrusted content marking for model input | `server/src/untrusted-content.ts` |

## NexQN rules

1. **No path around the gateway.** A new tool (knowledge search, CLI run) is registered so that its
   call goes through grant → policy → audit. A route that acts for a Bot without that sequence is a
   defect.
2. **No self-granting.** Grants, policy and approvals are written only by authenticated people
   through admin or owner routes. No tool offered to a model can write them.
3. **Vault only.** Provider keys, subscription tokens and Codex `auth.json` contents are `credentials`
   rows. They are decrypted only at the point of use, in the process that uses them, and never
   serialised into an API response, a log line, an audit payload or an AG-UI event.
4. **Execution off the API host.** CLI runs and untrusted document parsing run inside a computer
   container as the non-root user, with the Bot's egress policy, CPU/memory limits and a timeout.
5. **Owner-bound subscriptions.** A subscription account is usable only by its owner's runs and only
   by Bots the owner granted it to. No automatic fallback or rotation between accounts.
6. **No private vendor APIs.** Subscription access uses the vendors' documented CLIs. OpenBot's
   `_ChatOpenAICodex` path to `chatgpt.com/backend-api/codex` is not used by NexQN; NexQN deployments
   leave `CHATGPT_AUTH_FILE` unset.
7. **Retrieval is permission-checked on the server** against both the asking person and the Bot's
   grant, every time.

## Secrets in configuration

| Secret | Requirement |
| --- | --- |
| `KEY_ENCRYPTION_KEY` | `openssl rand -base64 32`; back it up separately from the database — a restored database without it cannot decrypt credentials |
| `BETTER_AUTH_SECRET` | Long random value |
| `COMPUTER_TOKEN`, supervisor token, `MANAGED_AGENT_TOKEN` | Long random values outside local development |
| Intelligence key | Server-side env only |

## Known gaps to close

- Roles are `admin`/`user`; there is no read-only role.
- No organisation isolation inside one deployment (deployment-per-customer instead).
- `channels.allowed_groups` is stored and enforces nothing (documented upstream).
- Conversation content is held by CopilotKit Intelligence; with the managed service it leaves the
  deployment.
