# Needle helper

[Needle](https://github.com/cactus-compute/needle) by Cactus Compute (Apache-2.0) is a tiny model
that reads a message and picks which tools it needs. OpenBot can run it beside the server on your
computer to choose which of a Bot's skills each message needs, instead of asking the big AI first.
That saves a whole round trip on every message, which matters most with a local AI.

- Turn it on: `bun run ai needle on`, then restart OpenBot. The first start downloads its 35 MB
  model once; after that it works with no internet.
- Turn it off: `bun run ai needle off`, then restart.
- See it: Admin, AI: online or offline, Needle helper.

It only narrows which tools are shown. It grants nothing, does nothing itself, and when it is off,
unsure or not answering, tools are picked exactly as before. A call it was unsure about still counts
as chosen, because showing an extra tool costs nothing and missing one costs the answer.

Needle's anonymous usage counts are switched off (`NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK=1`).
The helper is `needle-helper/` (a small Python server) and the `needle` service in
`docker-compose.yml`. The phone app has its own copy of Needle: see `mobile/modules/needle/`.
