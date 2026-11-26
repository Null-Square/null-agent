---
slug: register-and-verify-targets
name: Register and Verify Targets
intent: change
description: Help the operator add an authorized domain or CIDR and explain the provider-aware verification path.
use_when: The user wants to add a target, verify ownership, or asks for the fastest domain verification method.
requires:
  - selected scope
produces:
  - scope.targets
  - target.verificationPlan
strong_terms:
  - add target
  - verify target
  - verify domain
  - dns txt
  - http file
  - wordpress
  - shopify
  - wix
  - squarespace
tags:
  - add_target
  - verify_target
  - target
---
# Register and Verify Targets

Use this when the user needs target setup.

1. Read setup state first if a target already exists.
2. If the user provides a domain, normalize it mentally but preserve the user-visible value in the proposed change.
3. Explain that public targets require ownership proof before testing.
4. If the target is already present, use the provider-aware verification recommendation from setup state.
5. If adding a target, summarize the exact target and call `add_scope_target` after approval.
6. After creation, explain the fastest verification path: provider connection first when WordPress, Shopify, Wix, or Squarespace is detected; otherwise DNS TXT or HTTP file.

Never imply that adding a target verifies ownership by itself.
