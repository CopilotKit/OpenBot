# Personal AWS deployment files

This directory holds the two-host AWS runtime:

```text
Internet -> Caddy -> OpenBot + PostgreSQL     control EC2
                         |
                         v private VPC
               Codex and Grok gateways        worker EC2
               Claude disabled by default
```

Terraform creates the network, hosts, retained encrypted volumes, ECR repositories, alerts, and backups. The protected GitHub Actions workflow builds signed images, scans them, sends this directory to the hosts through SSM, and starts the systemd services. No host needs a GitHub key.

Store one JSON object for each host in AWS Secrets Manager. Use `control-secret.example.json` and `worker-secret.example.json` as key lists. The deploy workflow changes only `OPENBOT_IMAGE` or `GATEWAY_IMAGE`. Provider login state stays on the retained volumes under `/srv/openbot-auth` and is not in Secrets Manager, a backup, an image, or OpenBot.

Use digest-qualified image values. Do not use `latest`. Terraform tags the control and worker data volumes with `Backup=included-service-data`. It tags each provider auth volume with `Backup=excluded-provider-auth`.

See [AWS deployment](../../docs/runbooks/aws-deployment.md), [provider sign-in](../../docs/runbooks/provider-sign-in.md), and [worker operations](../../docs/runbooks/worker-operations.md).
