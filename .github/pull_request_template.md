## What this changes

<!-- What it does, and why it is worth doing. -->

## Where it runs

OpenBot is deployed as several server processes behind a load balancer, serving a whole company.
Consecutive requests from the same person reach different processes, and the process that answered a
WebSocket upgrade is rarely the one that answers the next call on that conversation.

State that outlives a single request therefore has to be shared, or the change works on one machine
and stops working the moment there are two, without saying so. That failure is worse than not
shipping the feature: it passes review, passes CI, passes a local demo, and only surfaces as a Bot
that forgets, a question nobody can answer, or a boundary that never fires.

Answer these even when the answer is "none":

- [ ] **New state that outlives a request?** Where does it live? A `Map` or `Set` held in a module or
      a factory closure does not count as somewhere.
- [ ] **What happens on the second replica?** Name the concrete outcome, not "should be fine".
- [ ] **Anything serialised?** Say what stops two processes doing it at once. A unique index, a
      conditional update, or an advisory lock are answers. A check-then-write is not.
- [ ] **Anything fanned out to a browser?** Say how it reaches a socket held by another process.
- [ ] **New listener, port, or schedule?** Say how it is reached through the same ingress as the API,
      and what a hundred copies of it do.

Postgres is already there and is the default answer to all of the above: a table, a unique index, a
conditional update, `LISTEN`/`NOTIFY` for fan-out.

## Boundary and audit

- [ ] Every acting call still goes through the gateway: resolve, decide, audit, then act.
- [ ] New refusals and new failures each write a row.
- [ ] Nothing new is trusted from the client that the server can resolve itself.

## Proof

<!-- What you ran, and what you saw. Screenshots or a recording for anything with a surface. -->
