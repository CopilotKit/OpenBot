# Security threat model

Scope: a NexQN AI deployment per customer (Docker Compose on one VPS), with the NexQN modules
described in [architecture.md](architecture.md). Controls named as "OpenBot" exist today; controls
named as "NexQN" are planned and must ship with the module they protect.

| Threat | Attack | Mitigations | Residual risk |
| --- | --- | --- | --- |
| Prompt injection | A web page, email, document or tool result tells the Bot to exfiltrate data or act | OpenBot: untrusted-content marking, action policy, approvals for writes, egress allowlists, audit. NexQN: retrieved chunks marked untrusted; CLI runs inherit the Bot's egress policy | Models can still be persuaded to misuse an allowed tool. Keep write tools on "require approval". |
| Malicious documents | Parser exploits, zip bombs, macro content, huge files | NexQN: size and type limits, parsing in a computer container, page/row caps, no macro execution | Parser vulnerabilities in third-party libraries. Keep them patched (Renovate is configured). |
| Malicious MCP server | Tool lies about being read-only, returns injected content, harvests tokens | OpenBot: admin-only registration, URL checks, unknown tools treated as writes, per-tool grants, per-user OAuth, audit | A trusted server that turns hostile. Review servers before granting. |
| Credential theft | Read keys/tokens from DB, logs, browser, or a container | OpenBot vault + redaction; NexQN: tokens decrypted only for a run, written to tmpfs, removed after; never in API/AG-UI payloads | Compromise of the host or `KEY_ENCRYPTION_KEY` exposes everything. Restrict host access; store the key apart from backups. |
| Subscription account misuse | One person's Bot uses another person's ChatGPT/Claude plan | NexQN: owner-bound accounts, explicit grants, no fallback/rotation, audit of each run | An administrator with host access can read the vault. |
| Cross-tenant access | Customer A sees customer B | Deployment per customer: separate database, volumes, key | Shared host for several customers would share the Docker daemon; use separate VPSs for unrelated customers. |
| Unauthorized file access | Bot reads host files or another person's workspace | OpenBot: per-person/per-Bot containers, no host mounts beyond named volumes, file paths in policy | Volume misconfiguration by an operator. |
| Arbitrary shell execution | Bot runs destructive or exfiltrating commands | OpenBot: shell only inside the computer container, non-root, egress filter, policy on `command`, approvals, gVisor option | Raw sockets bypass the proxy (documented upstream); a host firewall or gVisor narrows this. |
| Browser access to internal networks | SSRF to router, database, metadata service | OpenBot: metadata always refused, private hosts refused in production, DB on a separate network | Services on the `default` network reachable from computers; keep that network minimal. |
| Excessive resource use | Runaway loops, fan-out, huge CLI runs | OpenBot: handoff depth/per-run caps, idle computer culling, container limits. NexQN: CLI timeouts, per-person run concurrency | A determined user on their own plan can exhaust their vendor quota. |
| Permission escalation by an agent | Bot grants itself tools or edits policy | OpenBot: grants/policy written only by people via guarded routes; skill-creator writes through the person's own session after a confirmation card | A person approving a card without reading it. |
| Vendor terms | Subscription use outside what the vendor permits | NexQN: documented CLIs only, one person per account, no proxying a plan to other people | Vendor terms change; review at each release. |
