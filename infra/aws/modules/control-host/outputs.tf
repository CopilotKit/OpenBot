output "instance_id" {
  value = aws_instance.this.id
}

output "public_ip" {
  value = aws_eip.control.public_ip
}

output "private_ip" {
  value = aws_instance.this.private_ip
}

output "data_volume_id" {
  value = aws_ebs_volume.data.id
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}
