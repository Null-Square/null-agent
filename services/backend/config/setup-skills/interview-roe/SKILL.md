---
slug: interview-roe
name: Interview Rules of Engagement
intent: change
description: Help the operator define scope mission, allowed activity, impact tolerance, rate limits, and operator notes.
use_when: The scope has no mission or rules of engagement, or the user asks what rules, limits, or testing posture should be used.
requires:
  - selected scope
produces:
  - scope.mission
  - scope.roeDocument
  - scope.impactTolerance
  - scope.stealthPosture
strong_terms:
  - rules of engagement
  - roe
  - testing limits
  - impact tolerance
  - allowed activity
  - rate limit
tags:
  - rules_of_engagement
  - roe
  - scope-brief
---
# Interview Rules of Engagement

Use this when the scope needs explicit rules before testing.

1. Read setup state first.
2. If no readable setup document is already attached, first ask whether the user has an existing policy, RoE, contract, prior report, access list, or scope document they want to upload. Tell them they can attach it in the normal chat input. Do not create a separate upload workflow.
3. If the user attaches a document, use `read_setup_state` to find the document id, load `draft-roe-from-document`, and continue with that document-grounded playbook.
4. If the user has no document or wants to continue manually, ask for the minimum missing details: objective, allowed targets, disallowed actions, testing windows, rate limits, data-handling limits, and escalation contact if relevant.
5. Recommend safe defaults when the user is unsure: coordinated posture, non-destructive impact, conservative rate limits, and explicit approval before risky tests.
6. Draft `mission`, `roeDocument`, and optional structured fields.
7. Summarize the exact change and call `update_scope_brief` only after approval.

Do not suggest destructive testing unless the user explicitly authorizes it and the scope impact tolerance supports it.
