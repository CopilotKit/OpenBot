resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-internet" }
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name}-public-${count.index + 1}"
    Tier = "public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "control" {
  name        = "${var.name}-control"
  description = "Public TLS ingress for the OpenBot control host"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-control" }
}

resource "aws_vpc_security_group_ingress_rule" "control_web" {
  for_each = toset(["80", "443"])

  security_group_id = aws_security_group.control.id
  description       = "Public web ingress"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}

resource "aws_vpc_security_group_egress_rule" "control" {
  security_group_id = aws_security_group.control.id
  description       = "Control host outbound access"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "Private AG-UI ingress from the control host only"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-worker" }
}

resource "aws_vpc_security_group_ingress_rule" "worker_gateway" {
  for_each = toset(["4210", "4211", "4212"])

  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.control.id
  description                  = "AG-UI ${each.value} from control"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.value)
  to_port                      = tonumber(each.value)
}

resource "aws_vpc_security_group_egress_rule" "worker" {
  security_group_id = aws_security_group.worker.id
  description       = "Worker outbound access for provider programs and ECR"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_route53_zone" "private" {
  name = var.private_zone_name

  vpc {
    vpc_id = aws_vpc.this.id
  }

  tags = { Name = "${var.name}-private" }
}
