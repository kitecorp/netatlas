import type { LabelSelector, LabelSelectorRequirement, Labels } from './types';

function holds(req: LabelSelectorRequirement, labels: Labels): boolean {
  const value = Object.hasOwn(labels, req.key) ? labels[req.key] : undefined;
  switch (req.operator) {
    case 'In':
      return value !== undefined && (req.values ?? []).includes(value);
    // As Kubernetes defines it, NotIn also matches a pod that has no such label.
    case 'NotIn':
      return value === undefined || !(req.values ?? []).includes(value);
    case 'Exists':
      return value !== undefined;
    case 'DoesNotExist':
      return value === undefined;
  }
}

/** Whether a Kubernetes label selector selects these labels. `{}` selects everything; all of its parts must hold. */
export function matchesSelector(sel: LabelSelector, labels: Labels): boolean {
  return (
    Object.entries(sel.matchLabels ?? {}).every(([k, v]) => Object.hasOwn(labels, k) && labels[k] === v) &&
    (sel.matchExpressions ?? []).every((req) => holds(req, labels))
  );
}
