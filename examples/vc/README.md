# Venture capital tenant package

A tenant package for a venture fund, shaped the same way as [`examples/fintech`](../fintech):
five YAML files that describe the coworkers a deployment ships with, the channels they answer in,
the model behind them, and where authorized knowledge is read from. It is configuration, not code.

Point a deployment at it with `TENANT_PACKAGE_DIR`, resolved from `server/`:

```sh
TENANT_PACKAGE_DIR=../examples/vc bash scripts/start.sh
```

## Coworkers

| Coworker            | Type          | Does                                                                   |
| ------------------- | ------------- | --------------------------------------------------------------------- |
| Deal Scout          | built-in      | Screens inbound decks and intros, briefs them against the thesis.     |
| Diligence Analyst   | remote-ag-ui  | First-pass market and company diligence on a governed computer.       |
| Portfolio Monitor   | built-in      | Tracks portfolio news, updates, and distress signals.                 |
| Fund Knowledge      | built-in      | Answers from thesis, memos, and prior deals, with sources.            |
| LP Relations        | built-in      | Drafts LP updates and answers from authorized fund data.              |

Deal Scout, Portfolio Monitor, Fund Knowledge, and LP Relations are `built-in`: a system prompt and
nothing else. Diligence Analyst is `remote-ag-ui`, so it drives a real browser on its own governed
computer — market sizing, founder and competitor research, red-flag checks — and can hand the wheel
to a person when it reaches a login wall or a check it should not clear alone. Its endpoint is read
from `MANAGED_AGENT_AG_UI_URL`, falling back to the Bot in the box so a clone runs with no
configuration. Swap it for a diligence agent of your own — on any framework, over AG-UI — and
nothing else here changes.

## Channels and groups

`channels.yaml` opens each coworker to a set of groups: `partners`, `investment`, and `platform` in
this example. Deal flow, diligence, and LP relations are scoped tighter than portfolio tracking and
fund knowledge. Map these names to your own directory groups, and remember that access to knowledge,
credentials, and browser actions is still governed at `/admin/boundaries` and `/admin/credentials` —
the channel decides who can talk to a coworker, not what it is allowed to do.

## Before you rely on it

- The knowledge roots (`Deals`, `Portfolio`, `Thesis`, `LP`, `Fund Operations`) are folder names to
  replace with your own. Connect the sources at `/admin/connectors`.
- Keep deal terms, LP identities, and portfolio figures in governed knowledge and credentials, never
  in this YAML. The prompts tell each coworker to cite sources and to refuse to invent figures, but
  the boundary is what enforces it.
- Add a `theme.css` beside these files to reskin the surface; see
  [docs/configuration.md](../../docs/configuration.md).
