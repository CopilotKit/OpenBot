provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application = "OpenBot"
      Environment = "personal"
      ManagedBy   = "Terraform"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "selected" {
  most_recent = false
  owners      = ["amazon"]

  filter {
    name   = "image-id"
    values = [var.ami_id]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

locals {
  availability_zones = length(var.availability_zones) >= 2 ? slice(var.availability_zones, 0, 2) : slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_kms_key" "ebs" {
  description             = "OpenBot personal EBS and log encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "ebs" {
  name          = "alias/${var.name}-storage"
  target_key_id = aws_kms_key.ebs.key_id
}

resource "aws_ebs_encryption_by_default" "this" {
  enabled = true
}

resource "aws_ebs_default_kms_key" "this" {
  key_arn = aws_kms_key.ebs.arn
}

module "network" {
  source = "../../modules/network"

  name               = var.name
  vpc_cidr           = var.vpc_cidr
  availability_zones = local.availability_zones
  private_zone_name  = "openbot.internal"
}

module "registry" {
  source = "../../modules/registry"
  name   = var.name
}

module "control" {
  source = "../../modules/control-host"

  name              = var.name
  ami_id            = data.aws_ami.selected.id
  instance_type     = "t3.medium"
  subnet_id         = module.network.control_subnet_id
  security_group_id = module.network.control_security_group_id
  availability_zone = local.availability_zones[0]
  kms_key_arn       = aws_kms_key.ebs.arn
  repository_arns   = module.registry.repository_arns
  secret_arns       = var.control_secret_arns
}

module "worker" {
  source = "../../modules/worker-host"

  name              = var.name
  ami_id            = data.aws_ami.selected.id
  instance_type     = "t3.xlarge"
  subnet_id         = module.network.worker_subnet_id
  security_group_id = module.network.worker_security_group_id
  availability_zone = local.availability_zones[1]
  kms_key_arn       = aws_kms_key.ebs.arn
  repository_arns   = module.registry.repository_arns
  secret_arns       = var.worker_secret_arns
}

resource "aws_route53_record" "worker" {
  zone_id = module.network.private_zone_id
  name    = var.worker_private_dns_name
  type    = "A"
  ttl     = 30
  records = [module.worker.private_ip]
}
