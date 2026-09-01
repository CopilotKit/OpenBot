# Codex coworker

This local-only AG-UI adapter lets OpenBot talk to the installed Codex app-server using the ChatGPT
account already authenticated by `codex login`.

The adapter records the join between each OpenBot Intelligence thread and its persistent Codex
thread in `.openbot-codex/threads.json`. On every later run—including after the adapter restarts—it
resumes that Codex thread and refreshes its standing instructions. Codex restores the dynamic-tool
catalog persisted with the thread; OpenBot still rechecks the current grant and policy on every call.

Only tools that OpenBot marks as deployment-owned are exposed as Codex dynamic tools. Calls return
to `/api/agent-tools/call` with OpenBot's signed run assertion and agent token, so the deployment
rechecks the Bot's grant and policy and writes the normal audit events. Codex-native shell, file,
MCP, app, web and multi-agent paths are disabled. The adapter interrupts native shell and file
attempts; turns run in the read-only sandbox without network access, so an action that races the
interrupt cannot write or reach the network.

Enable it with `CODEX_AGENT_ENABLED=true`. `scripts/start.sh` then runs this adapter on
`CODEX_AGENT_PORT` (default `4202`) and skips the two provider-API-key Bot containers. The start
script supplies `AGENT_TOOL_TOKEN`, `OPENBOT_TOOL_URL` and `CODEX_AGENT_STATE`; set those explicitly
when starting `agent-codex` by hand.
