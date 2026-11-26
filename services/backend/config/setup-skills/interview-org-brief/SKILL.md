---
slug: interview-org-brief
name: Interview Organization Brief
intent: change
description: Help the operator produce concise organization context for future security analysis.
use_when: The organization brief is missing or the user asks to describe their company, product, customers, sensitive data, or operating model.
requires:
  - selected organization
produces:
  - organization.operationalContext
strong_terms:
  - organization brief
  - company context
  - operational context
  - describe my organization
  - business context
tags:
  - org-brief
  - organization
  - context
---
# Interview Organization Brief

Use this when the user needs help creating or improving organization context.

1. Read setup state first.
2. Ask for only missing high-value facts: product/service, customer type, sensitive data, regulatory concerns, production environments, and critical business workflows.
3. Draft a concise operational context in plain language.
4. Before writing, summarize the exact organization context update.
5. Call `update_organization_context` only after the user approves the proposed wording.

Keep the brief factual. Do not invent compliance obligations, customer segments, or technologies.
