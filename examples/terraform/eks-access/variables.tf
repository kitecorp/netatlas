variable "cluster_name" {
  description = "The EKS cluster netatlas reads, for example prod-eu-1."
  type        = string
}

variable "netatlas_role_arn" {
  description = "The IAM role netatlas's pod runs as (its ServiceAccount's eks.amazonaws.com/role-arn), for example arn:aws:iam::111122223333:role/netatlas."
  type        = string
}
