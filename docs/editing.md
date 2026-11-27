# Editing and Apply

The editor changes one NetworkPolicy as a draft in your browser, then shows the change as a line difference before anything is saved. The draft ends in Copy YAML, for the policy's file in git, or in Apply, which writes it to the cluster with your own token.

## The draft

Every edit changes the draft in your browser tab; nothing reaches netatlas or the cluster until you press Copy YAML or Apply with my token. The editor shows the policy as two sides around the pods it covers: who may call in on the left, what they may call on the right.

- **Locks.** Each side has a lock. Restricted means only the side's rules may pass; open means anything may. Opening a side keeps its rules on screen, and they apply again once you restrict it.
- **Add rule.** Each side has three boxes: outside the cluster, the policy's own namespace, and across the cluster. A box's Add rule offers what fits there: any address or an address range, every pod or pods with labels, pods in chosen namespaces, and on the out side Kubernetes DNS. A form asks for the labels, the address range and the ports, and says how to write a field that does not parse.
- **Kept as written.** A part the editor cannot draw, such as `matchExpressions`, `except`, a named port or `endPort`, is one row "Kept as written" with its YAML. It goes into the draft unchanged; it can be removed, not edited. Fields netatlas does not know are kept as well.
- **Removing.** Each row can be removed. Removing the last peer of a rule removes the whole rule, because a rule left with no peers would let every caller in.
- **Review and save** shows the draft as a line difference from what the cluster has, with the number of lines changed.
- **Copy YAML** copies the draft's YAML, without the fields the cluster keeps for itself, to paste over the policy's file in git. Use it for a cluster that Argo CD or Flux runs from git, where a change made in the cluster would be put back. When the browser blocks the copy, for example on a page without HTTPS, the editor shows the YAML on its own, selected, to copy by hand.
- **A change in the cluster.** The editor follows the cluster's version while your draft has no changes. When the policy changes in the cluster after you changed the draft, the editor says `This policy changed in the cluster since you started. Your draft is based on the older version.` and offers `Start again from the cluster's version`. Until then the review shows the line difference from the cluster's newer version, so it shows what a copy of your draft would undo there. Discard changes also starts again from the cluster's version.

## Apply

Apply asks for a token for the policy's cluster and writes the draft with it, so Kubernetes decides whether you may change the policy. The token is sent in that one request and is not stored, logged or shown again. Apply is offered only on a page the browser counts as secure: HTTPS, or `localhost` and `127.0.0.1` through port-forward. Elsewhere the editor says `Apply needs netatlas to be opened over HTTPS or through kubectl port-forward, so the token is not sent in plain text. Copy YAML still works.`

To get a token:

- On EKS: `aws eks get-token --cluster-name <cluster> --region <region> --query status.token --output text`. The editor fills in the cluster's name and region.
- Elsewhere: `kubectl create token <account> --duration 15m`, for a ServiceAccount that may change the policy.

A token may apply when its Role allows get and update on `networkpolicies` in the policy's namespace. [e2e/manifests/apply-access.yaml](../e2e/manifests/apply-access.yaml) has an example, `policy-writer`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: policy-writer
  namespace: shop
rules:
  - apiGroups: [networking.k8s.io]
    resources: [networkpolicies]
    verbs: [get, update]
```

## What Apply refuses

Apply writes nothing, keeps your draft and says why when:

- The policy changed in the cluster after you opened it: `The policy changed in the cluster after you opened it, so nothing was written. Copy your YAML, then reload to start from the cluster's version.` netatlas never overwrites a newer version.
- Kubernetes does not accept the token: `Kubernetes did not accept this token. Check that it is for <cluster> and has not expired.`
- Kubernetes refuses the change, for example because the token may not update the policy: `Kubernetes refused the change:` followed by Kubernetes' own message.
- netatlas cannot reach the cluster: `netatlas cannot reach this cluster now, so it cannot apply. Copy YAML still works.` Apply is not offered until the cluster answers again.

When no answer comes back at all, for example because a port-forward broke during the request, the editor says `netatlas did not answer, so it cannot tell whether the change was applied. Reload to see the cluster's version.`

## What the editor does not do

When both sides are open, the policy blocks nothing. The editor then says `Both sides are open, so this policy blocks nothing. netatlas does not delete policies: remove it with kubectl or from git.` and offers neither Copy YAML nor Apply.

Istio AuthorizationPolicies are shown as their YAML, not edited here. netatlas does not create or delete policies.
