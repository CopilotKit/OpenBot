# Deploy the private AWS stack

This runbook deploys one owner-only OpenBot control host and one cloud worker host. It does not support shared use of personal provider accounts.

## 1. Set the AWS prerequisites

Use an AWS account where you can run Terraform. Choose one region. Create these items before the stack:

- two Secrets Manager secrets, one from `deploy/aws/control-secret.example.json` and one from `deploy/aws/worker-secret.example.json`;
- the account-wide GitHub Actions OIDC provider for `https://token.actions.githubusercontent.com`, with audience `sts.amazonaws.com`;
- a public DNS `A` record you can later point to the control Elastic IP;
- Google, Microsoft, or Okta OAuth values for that public domain;
- CopilotKit Intelligence values required by OpenBot.

Generate all secret values on your own machine. Use a distinct random value for each provider gateway token. The matching control and worker token values must be equal for that provider. Do not put any provider login token in either AWS secret.

Resolve and store digest-qualified PostgreSQL and Caddy image references in the control secret. Leave the OpenBot and gateway image fields as valid digest placeholders until the first deploy workflow replaces them.

## 2. Create the AWS stack

Copy the example variables and set the fixed AMI, secret ARNs, GitHub repository, OIDC provider ARN, and alert email:

```bash
cp infra/aws/environments/personal/terraform.tfvars.example \
  infra/aws/environments/personal/terraform.tfvars

terraform -chdir=infra/aws/environments/personal init
terraform -chdir=infra/aws/environments/personal fmt -check
terraform -chdir=infra/aws/environments/personal validate
terraform -chdir=infra/aws/environments/personal plan -out=openbot.tfplan
terraform -chdir=infra/aws/environments/personal apply openbot.tfplan
```

Confirm the SNS email subscription. Point the public DNS record at `control_public_ip`. Wait for DNS to resolve before the first control deploy so Caddy can get a TLS certificate.

The worker has a public address only for outbound provider and repository access. Its security group has no public inbound rule and no SSH rule. Use SSM for host access.

## 3. Configure the protected GitHub environment

Create a GitHub environment named `production` in `Tbsheff/OpenBot`. Require your approval. Add these environment variables from Terraform outputs and AWS:

| Variable | Value |
| --- | --- |
| `AWS_ROLE_ARN` | `github_actions_deploy_role_arn` output |
| `AWS_REGION` | Terraform region |
| `AWS_CONTROL_INSTANCE_ID` | `control_instance_id` output |
| `AWS_WORKER_INSTANCE_ID` | `worker_instance_id` output |
| `AWS_CONTROL_SECRET_ARN` | control secret ARN |
| `AWS_WORKER_SECRET_ARN` | worker secret ARN |
| `AWS_OPENBOT_ECR_REPOSITORY_URL` | `ecr_repository_urls["openbot-control"]` |
| `AWS_GATEWAY_ECR_REPOSITORY_URL` | `ecr_repository_urls["subscription-gateway"]` |

Do not add long-lived AWS access keys. The role trust accepts only the repository's `production` environment OIDC subject.

## 4. Deploy

Run `Deploy personal AWS stack` from the GitHub Actions page. Select `all`. The workflow does this in order:

1. Build the OpenBot and gateway images for `linux/amd64`.
2. Push them to immutable ECR repositories.
3. Sign each digest with the workflow OIDC identity and scan for unfixed critical findings.
4. Update only the image field in each existing Secrets Manager JSON object.
5. Send the small host bundle through SSM.
6. Deploy the worker before the control host.
7. Restore the prior image field if a host service fails to start.

The control service starts PostgreSQL, runs migrations once, and then starts OpenBot and Caddy. The worker starts Codex and Grok. Claude stays off until its legal release gate passes.

## 5. Sign in and accept the release

Follow [provider sign-in](provider-sign-in.md). Then sign in to the private OpenBot URL with the exact email in `OPENBOT_OWNER_EMAIL`.

Run one new Codex task and one new Grok task from OpenBot. For each task, confirm streamed text, retained patch data, continuation on the same thread, cancellation, and no automatic push. Replace the worker container and confirm the provider is still signed in. Do not enable Claude as part of this gate.

## Limits of a local test

Terraform validation, Compose rendering, fake provider protocol tests, and local signed-in provider tests do not prove the AWS path. The release is end-to-end only after the protected workflow, DNS and TLS, owner IdP sign-in, provider device sign-ins, OpenBot runs, container replacement, one alert test, and one restore test pass in the target AWS account.
