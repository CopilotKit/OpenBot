# Operate the personal workers

## Check health

Use SSM to start a session on the worker. Run:

```bash
systemctl status openbot-worker.service openbot-health-metrics.timer
sudo docker compose --env-file /etc/openbot/worker.env \
  -f /opt/openbot/deploy/aws/compose.worker.yml ps
curl --fail --silent http://127.0.0.1:4210/ready
curl --fail --silent http://127.0.0.1:4212/ready
```

`/health` proves the gateway process is live. `/ready` also checks the provider login. A failed readiness check does not mean the host is down.

CloudWatch receives container logs and these `OpenBot/Personal` metrics each minute: `ServiceReady`, `DiskUsedPercent`, `QueueDepth`, and `ActiveRuns`. Alerts cover EC2 status, missing or failed service checks, 85 percent disk use, a queue that stays nonempty for 30 minutes, and three provider failures in five minutes. Keep prompt text, tokens, repository files, patches, and provider errors out of logs and alarm messages.

## Drain and deploy

The host limit is one active provider run and one queued run. Before a planned deploy, wait until `ActiveRuns` is zero and `QueueDepth` is zero. Run the protected AWS deploy workflow. It uses digest references and restores the prior image setting if startup fails. It does not change or copy provider auth volumes.

For a manual rollback, select the prior enabled version of the worker secret in Secrets Manager, restore its `GATEWAY_IMAGE` digest, and run:

```bash
sudo systemctl restart openbot-worker-env.service openbot-worker.service
```

Use the same process with `OPENBOT_IMAGE` and the control services for a control rollback. A schema change can make an image-only control rollback unsafe. Read the migration before deploying it and restore the matching database backup when the schema is not backward-compatible.

## Back up and restore

The control host writes a custom PostgreSQL dump each day at 04:30 UTC and keeps seven days on its encrypted data volume. AWS Backup snapshots both service-data volumes each day at 05:00 UTC and keeps them for 30 days. The backup selection includes only volumes tagged `Backup=included-service-data`. Provider auth volumes use `Backup=excluded-provider-auth` and must stay out of backup plans.

Test restore in a separate volume and temporary database. Stop writes, restore the dump with `pg_restore`, start the matching OpenBot digest, and check the owner, coworker, thread, run, and artifact records. Do not overwrite the active volume during a drill. If a provider auth volume is lost, revoke that provider session and run the device sign-in again. Never restore provider login data from a service backup.

## Recover capacity and disk

On restart, the gateway marks active and queued ledger rows failed and releases their host leases. It does not resume a native agent without the AG-UI client. If `ActiveRuns` stays above zero with no task open, save the safe gateway log lines, restart the affected service, and check that the metric returns to zero.

When disk use reaches 85 percent, first remove expired terminal workspaces through the normal cleanup path. Keep the stored patch and commit metadata. Do not delete SQLite ledgers or provider auth directories. Increase the retained EBS volume only after you know which path is growing.

## Upgrade a provider

Change one pinned CLI version and its policy at a time. Run its fixture suite, build and scan the image, sign in on a staging auth volume, and pass new-run, continuation, cancellation, failure, and replacement checks before release. Recheck the provider's current terms and login guidance. Claude stays disabled unless Anthropic gives a supported route for this exact use.

## Monthly cost check

Review the current AWS bill and the Terraform plan each month. Treat any ALB, NAT Gateway, RDS, EKS, larger EC2 size, added public IPv4 address, longer log retention, or larger backup retention as a budget change. Confirm the plan in the AWS Pricing Calculator for the chosen region before applying it.
