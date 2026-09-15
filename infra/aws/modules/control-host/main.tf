data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/openbot/${var.name}/control"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

resource "aws_iam_role" "this" {
  name               = "${var.name}-control"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "runtime" {
  name = "${var.name}-control-runtime"
  role = aws_iam_role.this.id
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
        Sid    = "EcrPull"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = var.repository_arns
      },
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.this.arn}:*"
      },
      {
        Sid      = "HealthMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = { "cloudwatch:namespace" = "OpenBot/Personal" }
        }
      }
      ], length(var.secret_arns) == 0 ? [] : [
      {
        Sid      = "DeploymentSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.secret_arns
      }
    ])
  })
}

resource "aws_iam_instance_profile" "this" {
  name = "${var.name}-control"
  role = aws_iam_role.this.name
}

resource "aws_ebs_volume" "data" {
  availability_zone = var.availability_zone
  size              = var.data_volume_size_gib
  type              = "gp3"
  encrypted         = true
  kms_key_id        = var.kms_key_arn

  tags = {
    Name   = "${var.name}-control-data"
    Backup = "included-service-data"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "this" {
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [var.security_group_id]
  iam_instance_profile        = aws_iam_instance_profile.this.name
  associate_public_ip_address = true
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/bootstrap.sh.tftpl", {
    data_volume_id = aws_ebs_volume.data.id
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    encrypted             = true
    kms_key_id            = var.kms_key_arn
    volume_type           = "gp3"
    volume_size           = 30
    delete_on_termination = true
  }

  tags = { Name = "${var.name}-control" }
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  instance_id                    = aws_instance.this.id
  volume_id                      = aws_ebs_volume.data.id
  stop_instance_before_detaching = true
  skip_destroy                   = true
  # A separately attached EBS volume has delete_on_termination = false.
}

resource "aws_eip" "control" {
  domain   = "vpc"
  instance = aws_instance.this.id

  tags = { Name = "${var.name}-control" }
}
