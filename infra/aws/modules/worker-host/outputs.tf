output "instance_id" {
  value = aws_instance.this.id
}

output "public_ip" {
  value = aws_instance.this.public_ip
}

output "private_ip" {
  value = aws_instance.this.private_ip
}

output "data_volume_id" {
  value = aws_ebs_volume.data.id
}

output "auth_volume_ids" {
  value = { for provider, volume in aws_ebs_volume.auth : provider => volume.id }
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}
