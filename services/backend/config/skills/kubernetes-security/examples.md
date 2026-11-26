# Kubernetes Security Examples

## Active privileged workload

Rendered production YAML shows the public converter workload runs privileged, mounts the host root read-write, and lacks a compensating sandbox. Deployment inventory ties the public route to that workload. Expected disposition: source/config proof of dangerous deployment posture; do not exec into it.

## Default chart overridden

The chart default sets `automountServiceAccountToken: true`, but the rendered environment object sets false and uses a restricted named service account. Expected disposition: reject the default-only lead.

## Public dashboard behind identity proxy

The dashboard hostname is reachable, redirects to the approved identity provider, and anonymous/API controls cannot access dashboard content. Expected disposition: reject public-host fingerprint alone.

## Kubeconfig in repository

Record a redacted fingerprint and source history, do not use the kubeconfig. Hand to secret response; permissions and cluster reachability are blocked.
