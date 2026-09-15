variable "name" {
  description = "Prefix for network resource names."
  type        = string
}

variable "vpc_cidr" {
  description = "IPv4 range for the private deployment network."
  type        = string
}

variable "availability_zones" {
  description = "Two availability zones used by the public control and worker subnets."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "At least two availability zones are required."
  }
}

variable "private_zone_name" {
  description = "Private Route 53 zone used for worker addressing."
  type        = string
  default     = "openbot.internal"
}
