variable "name" {
  description = "Prefix for registry resources."
  type        = string
}

variable "repository_names" {
  description = "Private image repositories used by the deployment."
  type        = set(string)
  default     = ["openbot-control", "subscription-gateway"]
}
