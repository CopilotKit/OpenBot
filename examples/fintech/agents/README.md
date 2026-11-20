# One coworker per file

A file in here declares one coworker, and the loader reads it alongside `../agents.yaml`. Both work,
and a package that keeps everything in `agents.yaml` is unchanged.

The package starts with two coworkers from `../agents.yaml`, General Assistant and Knowledge, so a
fresh deployment opens on a short roster rather than a dozen Bots nobody asked for. Its other two
entries register only when their endpoints are configured. To add one, copy a file in from
[`../catalog`](../catalog), or write your own in the same shape. To remove one, delete its file.
