terraform {
  required_version = "= 1.14.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.14.1"
    }
  }
}
