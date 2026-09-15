resource "aws_sns_topic" "alerts" {
  name              = "${var.name}-alerts"
  kms_master_key_id = "alias/aws/sns"
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:production"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${var.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_deploy_assume.json
}

resource "aws_iam_role_policy" "github_deploy" {
  name = "${var.name}-github-deploy"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "PublishImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:ListImages",
          "ecr:PutImage",
          "ecr:UploadLayerPart"
        ]
        Resource = module.registry.repository_arns
      },
      {
        Sid    = "RunDeploymentCommands"
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${module.control.instance_id}",
          "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${module.worker.instance_id}",
          "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}::document/AWS-RunShellScript"
        ]
      },
      {
        Sid      = "ReadDeploymentCommands"
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation"]
        Resource = "*"
      }
      ], length(concat(var.control_secret_arns, var.worker_secret_arns)) == 0 ? [] : [
      {
        Sid    = "UpdateImageReferences"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue"
        ]
        Resource = concat(var.control_secret_arns, var.worker_secret_arns)
      }
    ])
  })
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alert_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "instance_status" {
  for_each = {
    control = module.control.instance_id
    worker  = module.worker.instance_id
  }

  alarm_name          = "${var.name}-${each.key}-instance-status"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "breaching"
  dimensions          = { InstanceId = each.value }
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "service_unready" {
  for_each = toset(["control", "worker"])

  alarm_name          = "${var.name}-${each.key}-service-unready"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ServiceReady"
  namespace           = "OpenBot/Personal"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"
  dimensions          = { HostRole = each.key }
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "disk_pressure" {
  for_each = toset(["control", "worker"])

  alarm_name          = "${var.name}-${each.key}-disk-pressure"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 3
  metric_name         = "DiskUsedPercent"
  namespace           = "OpenBot/Personal"
  period              = 60
  statistic           = "Maximum"
  threshold           = 85
  treat_missing_data  = "breaching"
  dimensions          = { HostRole = each.key }
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "queue_stuck" {
  alarm_name          = "${var.name}-worker-queue-stuck"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 30
  metric_name         = "QueueDepth"
  namespace           = "OpenBot/Personal"
  period              = 60
  statistic           = "Minimum"
  threshold           = 0
  treat_missing_data  = "breaching"
  dimensions          = { HostRole = "worker" }
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_log_metric_filter" "provider_failures" {
  name           = "${var.name}-provider-terminal-failures"
  pattern        = "{ $.event = \"provider_run_terminal\" && $.outcome = \"failed\" }"
  log_group_name = module.worker.log_group_name

  metric_transformation {
    name          = "ProviderTerminalFailures"
    namespace     = "OpenBot/Personal"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "provider_failures" {
  alarm_name          = "${var.name}-provider-terminal-failures"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.provider_failures.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.provider_failures.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_vault" "service_data" {
  name        = "${var.name}-service-data"
  kms_key_arn = aws_kms_key.ebs.arn
}

resource "aws_backup_plan" "daily" {
  name = "${var.name}-daily"

  rule {
    rule_name         = "daily-retained-service-data"
    target_vault_name = aws_backup_vault.service_data.name
    schedule          = "cron(0 5 * * ? *)"
    start_window      = 60
    completion_window = 180

    lifecycle {
      delete_after = 30
    }
  }
}

resource "aws_backup_selection" "service_data" {
  name         = "${var.name}-service-data-only"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.daily.id
  resources    = ["*"]

  selection_tag {
    type  = "STRINGEQUALS"
    key   = "Backup"
    value = "included-service-data"
  }
}
