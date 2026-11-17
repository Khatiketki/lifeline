variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "lifeline"
}

variable "image_tag" {
  description = "Tag of the images pushed to ECR (scripts/deploy-aws.sh uses the git SHA)."
  type        = string
  default     = "latest"
}

variable "acm_certificate_arn" {
  description = "ACM certificate for HTTPS on the ALB. Leave empty for HTTP only."
  type        = string
  default     = ""
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_deletion_protection" {
  type    = bool
  default = false
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "api_max_count" {
  type    = number
  default = 6
}

variable "routing_desired_count" {
  type    = number
  default = 2
}

variable "enable_simulator" {
  description = "Generate synthetic vitals from the API tasks (demo only)."
  type        = bool
  default     = true
}
