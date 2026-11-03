# Product requirements

NexQN AI is a private, self-hosted AI agent platform built on CopilotKit OpenBot. This document
states what the product must do and, for each requirement, whether it is inherited from OpenBot or
is NexQN work. Status is maintained against the code; see
[repository-analysis.md](repository-analysis.md) for evidence.

## Users

| Persona | Needs |
| --- | --- |
| Member | Chat with Bots, use their own AI subscriptions, upload documents to their knowledge bases, approve sensitive actions. |
| Administrator | Configure model providers, MCP tools, policy, identity providers; see the audit trail; manage people. |
| Operator (NexQN) | Deploy and upgrade an installation per customer with Docker Compose; back up and restore. |

## Roles

OpenBot has two roles (`admin`, `user`). The NexQN role list maps onto them for release 1:

| NexQN role | Release 1 | Later |
| --- | --- | --- |
| Super Admin | `admin` listed in `INITIAL_ADMIN_EMAILS` (cannot be demoted) | Cross-organisation operator role |
| Organization Owner / Admin | `admin` | Per-organisation roles |
| Member | `user` | — |
| Read-only User | Not available | New role; needs read-only checks on every write route |

## Functional requirements

| ID | Requirement | Source | Phase |
| --- | --- | --- | --- |
| BR-1 | Product name, logo, favicon, colours, typography, metadata from one config | Extend OpenBot `brand.yaml` | 3 |
| BR-2 | No hard-coded product name in UI copy | NexQN | 3 |
| BR-3 | Light and dark theme | OpenBot | 3 |
| AU-1 | SSO sign-in (Google, Microsoft, Okta, SAML, OIDC) | OpenBot | — |
| AU-2 | Email/password sign-up and reset | NexQN, if decided | 4 |
| AU-3 | Invitations | NexQN | 4 |
| MG-1 | Admin registry of providers: OpenAI, Anthropic, Gemini, OpenAI-compatible, Ollama, vLLM | NexQN on OpenBot provider spec | 5 |
| MG-2 | Test connection, list models, capabilities, default model | NexQN | 5 |
| MG-3 | Keys only in the vault, never in responses | OpenBot vault | 5 |
| SC-1 | Connect a ChatGPT plan through the official Codex CLI login | NexQN | 6 |
| SC-2 | Connect a Claude plan through the official Claude Code login | NexQN (replaces env-only token) | 6 |
| SC-3 | Several accounts per person; owner-only use; no rotation | NexQN | 6 |
| SC-4 | Show status, last login, last run, errors; no invented quota | NexQN | 6 |
| AG-1 | Create, edit, duplicate, delete Bots in the UI | OpenBot (partial) | 7 |
| AG-2 | Per-Bot model, account, temperature, tools, knowledge | NexQN | 7 |
| AG-3 | Versions, publish/unpublish, playground with execution inspector | NexQN | 7 |
| AG-4 | Templates (General, Knowledge, Research, Coding, Marketing, Data Analyst) | Tenant package `agents/` + `catalog/` | 7 |
| KB-1 | Upload PDF, DOCX, TXT, MD, HTML, CSV, XLSX | NexQN | 8 |
| KB-2 | Chunk, embed (local or API), hybrid search, citations | NexQN | 8 |
| KB-3 | Server-side permission on every retrieval | NexQN | 8 |
| TL-1 | Register MCP servers, discover tools, grant per Bot | OpenBot | — |
| TL-2 | Allow / deny / require approval per tool | OpenBot | — |
| CP-1 | Isolated browser and workspace per person or Bot, egress policy | OpenBot | — |
| SK-1 | Skills with tools; personal and deployment scope | OpenBot | — |
| SK-2 | Skill versioning | NexQN | 11 |
| WF-1 | Scheduled, triggered, webhook runs with history | OpenBot Routines/Responsibilities | 11 |
| OB-1 | Audit trail with export | OpenBot | — |
| OB-2 | Usage separated by API / subscription / local / tool / job | NexQN | 5–6 |
| DP-1 | Docker Compose deployment on an Ubuntu VPS behind Nginx or Cloudflare | OpenBot + NexQN docs | 2, 12 |
| DP-2 | Backup and restore | NexQN docs | 12 |

## Non-functional requirements

- Every acting tool call is decided by the policy gateway and audited.
- No credential reaches the browser, the logs, or the audit payload.
- Browser automation and CLI runs never run as root and never on the API host.
- The product runs without a GPU and never downloads a model unless configured to.
- Upstream OpenBot changes can be merged at least monthly without rewriting NexQN modules.

## Out of scope for release 1

Multi-tenant SaaS in one deployment, a visual workflow canvas, billing.
