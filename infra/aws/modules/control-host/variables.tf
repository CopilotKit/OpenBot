variable "name" {
  type        = string
  description = "Prefix for control-host resources."
}

variable "ami_id" {
  type        = string
  description = "Pinned or SSM-resolved AMD64 Amazon Linux 2023 AMI ID."
}

variable "subnet_id" {
  type = string
}

variable "security_group_id" {
  type = string
}

variable "availability_zone" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "repository_arns" {
  type = list(string)
}

variable "secret_arns" {
  description = "Secrets Manager references that the host can fetch into a root-only env file."
  type        = list(string)
  default     = []
}

variable "instance_type" {
  type    = string
  default = "t3.medium"
}

variable "data_volume_size_gib" {
  type    = number
  default = 30
}
