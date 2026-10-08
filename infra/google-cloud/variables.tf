variable "project" { type = string }
variable "project_number" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{6,20}$", var.project_number))
    error_message = "project_number must be numeric."
  }
}
variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "region must be a Google Cloud region."
  }
}
variable "environment" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,9}$", var.environment)) && !strcontains(var.environment, "-bot")
    error_message = "environment must be lowercase, at most 10 characters, and not contain the reserved -bot segment."
  }
}
variable "image" {
  type    = string
  default = ""
}
variable "services_enabled" {
  type    = bool
  default = false
}
