variable "aws_region" {
  description = "AWS region for all OpenBot resources."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Short resource-name prefix."
  type        = string
  default     = "openbot-personal"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/20"
}

variable "ami_id" {
  description = "Pinned Amazon Linux 2023 x86_64 AMI. Resolve /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 once, then store that AMI ID here."
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]+$", var.ami_id))
    error_message = "ami_id must be one fixed EC2 AMI ID."
  }
}

variable "availability_zones" {
  description = "Optional fixed pair of availability zones. The first two available zones are used when empty."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.availability_zones) == 0 || length(var.availability_zones) >= 2
    error_message = "Set no availability zones or at least two."
  }
}

variable "control_secret_arns" {
  description = "Secrets Manager ARNs that may populate /etc/openbot/control.env at deploy time. Values never enter Terraform."
  type        = list(string)
  default     = []
}

variable "worker_secret_arns" {
  description = "Secrets Manager ARNs that may populate /etc/openbot/worker.env at deploy time. Values never enter Terraform."
  type        = list(string)
  default     = []
}

variable "worker_private_dns_name" {
  description = "Stable private name used by the OpenBot coworker endpoints."
  type        = string
  default     = "worker.openbot.internal"
}

variable "alert_email" {
  description = "Optional email address for health and capacity alarms. The subscription must be confirmed before alerts arrive."
  type        = string
  default     = null
  nullable    = true
}

variable "github_repository" {
  description = "GitHub owner and repository allowed to deploy through the production environment."
  type        = string
  default     = "Tbsheff/OpenBot"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must have owner/repository form."
  }
}

variable "github_oidc_provider_arn" {
  description = "ARN of the account-wide token.actions.githubusercontent.com OIDC provider. Import or create that provider once before this stack."
  type        = string

  validation {
    condition     = can(regex(":oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_oidc_provider_arn))
    error_message = "github_oidc_provider_arn must name the GitHub Actions OIDC provider."
  }
}
