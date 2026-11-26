---
slug: configure-scheduled-scan
name: Configure Scheduled Automation
intent: change
description: Help the operator design a safe inactive automation for recurring readiness or assessment workflows.
use_when: The user asks for automation, scheduled scans, recurring checks, weekly reviews, or event-based workflows.
requires:
  - selected scope
produces:
  - scope.automation
strong_terms:
  - automation
  - scheduled scan
  - recurring
  - weekly
  - continuous
  - event based
tags:
  - create_automation
  - automation
---
# Configure Scheduled Automation

Use this when the user wants recurring or event-based work.

1. Read setup state first.
2. Check the entitlement snapshot. If automations are unavailable, explain the plan block and offer to draft a manual checklist instead.
3. Prefer safe, inactive automations until the operator explicitly asks to activate.
4. Choose a simple trigger: scheduled weekly review, continuous interval, or a supported event.
5. Summarize the exact automation name, goal, trigger, target, execution target, and active state.
6. Call `create_scope_automation` only after approval.

Do not choose `scope_runner` unless the user explicitly asks for a private runner and the entitlement snapshot allows it.
