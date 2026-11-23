# Installing Agent Plugins

**Skills → Install a plugin** installs a plugin written in the
[Agent Plugins](https://agent-plugins.org/specification) format, version 1.0.0. A plugin is a folder:

```text
release-notes/
├── plugin.json                    # $schema and name, required
├── skills/
│   └── release-notes/
│       ├── SKILL.md               # an Agent Skill
│       └── references/template.md
└── mcp.json                       # MCP servers
```

Pick the folder and OpenBot lists everything in it before anything is written: what each skill and
server becomes, and why anything is left out. Nothing is installed until you press Install.

## What each part becomes

| In the plugin | In OpenBot |
| --- | --- |
| `skills/<name>/SKILL.md` | One of your skills. Its name is the command, its description the one-liner under it (a description longer than 200 characters also leads the instructions, so none of it is lost), and the rest of SKILL.md the instructions. |
| A skill's other files (`scripts/`, `references/`, `assets/`) | Not kept. A written skill is one set of instructions. The review names them. |
| A `streamable-http` server in `mcp.json` | An app added by its address, exactly as **Connections → Add server** adds one. A server that signs each person in asks them to, and one that needs a key needs an admin to give it. |
| A `stdio` server | Left out. It is a program to run on the computer the plugin is installed on, and OpenBot adds servers by their web address. |
| An `sse` server, or one with `headers` | Left out, with the reason. |
| `commands/`, `agents/`, `hooks/` | Left out. They are not part of Agent Plugins 1.0.0. |

Each skill declares the tools of the servers the same install added, so a Bot holding many tools is
offered the plugin's tools when the plugin's skill matches the message. **That grants nothing.**
A new skill is on no Bot and a new server's tools are given to nobody, as when you write a skill or
add a server by hand. Put them on a Bot from the Bot's Skills and from Connections.

## What is refused

The spec's failure rules are kept:

- A `plugin.json` that is not valid for 1.0.0 (no `$schema`, another version's, a malformed name,
  a field of the wrong type) refuses the whole plugin. An unknown field is named and ignored.
- An `mcp.json` that is not valid for 1.0.0 drops the plugin's servers and keeps its skills.
- A skill or server that is not valid drops only itself.
- A skill whose name you already use is left out. Saving under a skill's command replaces it, and a
  plugin never replaces a skill somebody wrote.

## Older layouts

A plugin laid out for Claude Code (`.claude-plugin/plugin.json`) or Codex
(`.codex-plugin/plugin.json`) is read too, from the same `skills/` folder and from `.mcp.json`,
where a server's `http` type means Streamable HTTP. Only the manifest's name, version and description
are read. A manifest that keeps its skills or servers somewhere else is named in the review rather
than followed. When a folder has both, root `plugin.json` wins.

## Where it runs

The plugin is read in the browser, and installed through the same two requests the Skills and
Connections screens send: saving a skill (`PUT /skills/{slug}`) and adding an app by its address
(`POST /apps`). Ownership, the MCP allowlist, the address rules and the audit trail are the ones
those requests already have.
