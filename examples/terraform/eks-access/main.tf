# Read access for netatlas to one EKS cluster, given to the IAM role netatlas runs as.
#
# EKS's access policies do not fit: AmazonEKSViewPolicy cannot read Istio's AuthorizationPolicies,
# and AmazonEKSAdminViewPolicy can read Secrets. So the access entry maps netatlas's role to the
# Kubernetes group netatlas-readers with no access policy, and that group is bound to netatlas's own
# read-only ClusterRole, whose rules are the chart's reader-rules.yaml.
#
# The AWS provider takes its region and credentials from the environment, as the AWS CLI does. The
# identity that applies this needs to create access entries and ClusterRoles in the cluster.

provider "aws" {}

data "aws_eks_cluster" "this" {
  name = var.cluster_name
}

provider "kubernetes" {
  host                   = data.aws_eks_cluster.this.endpoint
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", var.cluster_name]
  }
}

locals {
  group = "netatlas-readers"
  # The same rules the chart grants. Copying this example elsewhere means copying that file with it.
  reader_rules = yamldecode(file("${path.module}/../../../charts/netatlas/files/reader-rules.yaml"))
}

resource "aws_eks_access_entry" "netatlas" {
  cluster_name      = var.cluster_name
  principal_arn     = var.netatlas_role_arn
  type              = "STANDARD"
  kubernetes_groups = [local.group]
}

resource "kubernetes_cluster_role_v1" "netatlas_reader" {
  metadata {
    name = "netatlas-reader"
  }

  dynamic "rule" {
    for_each = local.reader_rules
    content {
      api_groups = rule.value.apiGroups
      resources  = rule.value.resources
      verbs      = rule.value.verbs
    }
  }
}

resource "kubernetes_cluster_role_binding_v1" "netatlas_readers" {
  metadata {
    name = "netatlas-readers"
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role_v1.netatlas_reader.metadata[0].name
  }

  subject {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Group"
    name      = local.group
  }
}
