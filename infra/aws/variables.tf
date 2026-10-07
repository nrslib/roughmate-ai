variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "AWS account ID must have 12 digits."
  }
}
variable "region" {
  type = string
}
variable "environment" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,23}$", var.environment))
    error_message = "Environment must be a lowercase name, at most 24 characters."
  }
}
variable "artifact" {
  type = string
}
