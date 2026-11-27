# EKS

netatlas reads an EKS cluster as the AWS role its pod runs as. It signs the same token `aws eks get-token` makes with that role, so it needs no Kubernetes token for EKS clusters. This page sets up the role, the access in each cluster, and the cluster's entry.

## The pod's AWS role

Give the pod an IAM role in one of two ways:

- IAM roles for service accounts: annotate the chart's ServiceAccount with the role.

  ```yaml
  serviceAccount:
    annotations:
      eks.amazonaws.com/role-arn: arn:aws:iam::111122223333:role/netatlas
  ```

- EKS Pod Identity: create a Pod Identity association for the ServiceAccount `netatlas` in the namespace netatlas runs in.

The role needs no AWS permission of its own: EKS trusts the token because the role signed it, and each cluster's access entry decides what the role may read. netatlas signs a new token every 10 minutes and uses it until then, as EKS accepts one for 15 minutes.

## Access in each cluster

Each cluster gives the role an access entry of type `STANDARD` that maps it to the Kubernetes group `netatlas-readers`, with no access policy, and binds that group to netatlas's own read-only ClusterRole.

No EKS access policy fits: `AmazonEKSViewPolicy` cannot read Istio's AuthorizationPolicies, and `AmazonEKSAdminViewPolicy` can read Secrets, which netatlas must not read. The ClusterRole reads exactly the kinds netatlas watches and nothing else.

## The Terraform example

[examples/terraform/eks-access](../examples/terraform/eks-access) creates the access entry, the ClusterRole and its binding in one cluster. It takes two inputs:

- `cluster_name`: the EKS cluster netatlas reads, for example `prod-eu-1`.
- `netatlas_role_arn`: the IAM role netatlas's pod runs as, for example `arn:aws:iam::111122223333:role/netatlas`.

The AWS provider takes its region and credentials from the environment, as the AWS CLI does. Apply it once per cluster, with an identity that may create access entries and ClusterRoles there. Access entries work across accounts, so netatlas can read clusters in other accounts than its own.

## The cluster's entry

An EKS cluster's entry in `clusters` ([Clusters](clusters.md) lists every field) names its API server and CA, which `aws eks describe-cluster` prints:

```sh
aws eks describe-cluster --name <cluster> --region <region> --query cluster.endpoint --output text
aws eks describe-cluster --name <cluster> --region <region> --query cluster.certificateAuthority.data --output text
```

The first is the entry's `server`, and the second its `caData`:

```yaml
clusters:
  - name: prod-eu-1
    server: https://ABCDEF0123456789.gr7.eu-west-1.eks.amazonaws.com
    caData: LS0tLS1CRUdJTi...
    login:
      type: eks
      clusterName: prod-eu-1
      region: eu-west-1
```
