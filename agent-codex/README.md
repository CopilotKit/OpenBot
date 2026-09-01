# Codex coworker spike

This local-only AG-UI adapter lets OpenBot talk to the installed Codex app-server using the
ChatGPT account already authenticated by `codex login`.

The spike is intentionally text-only and read-only. It does not translate Codex shell, file, MCP,
app, or browser actions into OpenBot tools yet. Those actions are declined so they cannot bypass
OpenBot's gateway and audit trail.

Enable it with `CODEX_AGENT_ENABLED=true`. `scripts/start.sh` then runs this adapter on
`CODEX_AGENT_PORT` (default `4202`) and skips the two provider-API-key Bot containers.
