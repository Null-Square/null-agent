---
slug: capture-credentials
name: Capture Credential Metadata
intent: change
description: Help the operator decide what authenticated access material is needed while keeping secrets out of chat.
use_when: The user mentions credentials, login, authenticated testing, cookies, bearer tokens, headers, or test accounts.
requires:
  - selected scope
produces:
  - accessMaterial.metadataDraft
strong_terms:
  - credentials
  - login
  - authenticated
  - cookie
  - bearer token
  - api key
  - test account
tags:
  - add_access_material
  - credentials
  - access
---
# Capture Credential Metadata

Use this when authenticated testing is needed.

1. Explain that secrets must not be pasted into chat.
2. Ask only for non-secret metadata: label, kind, host/path scope, environment, and intended use.
3. If the UI has a masked credential form available, direct the user there.
4. Do not call a write tool with a secret value. This slice intentionally has no model-callable credential creation tool.
5. Offer to draft a short checklist of what the user should enter in the secure credential form.

If the user pastes a secret into chat, tell them to rotate it and re-enter it through the secure form.
