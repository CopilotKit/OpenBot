output "control_instance_id" {
  value = module.control.instance_id
}

output "control_public_ip" {
  value = module.control.public_ip
}

output "worker_instance_id" {
  value = module.worker.instance_id
}

output "worker_private_dns_name" {
  value = aws_route53_record.worker.fqdn
}

output "ecr_repository_urls" {
  value = module.registry.repository_urls
}

output "retained_volume_ids" {
  value = {
    control_data  = module.control.data_volume_id
    worker_data   = module.worker.data_volume_id
    provider_auth = module.worker.auth_volume_ids
  }
}

output "log_group_names" {
  value = {
    control = module.control.log_group_name
    worker  = module.worker.log_group_name
  }
}

output "alert_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "backup_vault_name" {
  value = aws_backup_vault.service_data.name
}

output "github_actions_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}
