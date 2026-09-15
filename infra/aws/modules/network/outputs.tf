output "vpc_id" {
  value = aws_vpc.this.id
}

output "control_subnet_id" {
  value = aws_subnet.public[0].id
}

output "worker_subnet_id" {
  value = aws_subnet.public[1].id
}

output "control_security_group_id" {
  value = aws_security_group.control.id
}

output "worker_security_group_id" {
  value = aws_security_group.worker.id
}

output "private_zone_id" {
  value = aws_route53_zone.private.zone_id
}

output "private_zone_name" {
  value = aws_route53_zone.private.name
}
