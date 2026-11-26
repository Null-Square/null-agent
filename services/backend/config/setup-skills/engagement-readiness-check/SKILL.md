---
slug: engagement-readiness-check
name: Engagement Readiness Check
intent: audit
description: Explain current setup gaps and the safest next actions without making changes.
use_when: The user asks "what is left", "am I ready", "help me get started", or asks for a setup checklist.
requires:
  - selected scope
produces:
  - setup.gapReport
strong_terms:
  - readiness
  - checklist
  - get started
  - what is missing
  - setup gaps
  - next actions
tags:
  - readiness
  - review_scope
  - setup
---
# Engagement Readiness Check

Use this for audit-intent setup questions.

1. Call `read_setup_state`.
2. Summarize required blockers first: missing targets, unverified targets, missing mission/RoE.
3. Summarize recommended improvements second: repository context, authenticated access, documents, automations, compliance context.
4. Respect the entitlement snapshot. If a feature is unavailable on the current plan, explain it as unavailable rather than suggesting it as a normal next action.
5. Offer to help with one specific next step, but do not call write tools unless the user chooses a change.

Keep the answer short and action-oriented.
