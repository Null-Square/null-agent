# IDOR / Object-Level Authorization Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Use when a request references a concrete object and two authorized test personas can establish owner versus non-owner behavior. IDOR owns horizontal object references and nested object membership; function/role boundaries belong to `access-control`, and property overposting belongs to `mass-assignment`.

Record persona, tenant, role, object creator/owner, object marker, route, method, and baseline. An enumerable identifier or response-size difference without protected data/state is not proof.

## Hypothesis Before Probe

Write the hypothesis in one line before each probe: `endpoint, technique, expected signal, why it matters`. Example: `GET /api/orders/{orderId}, replay B's session against A's id, expected: A's order body returns 200 to B, why: object has no owner check`. If you cannot state the hypothesis, map more surface first — do not fire blind requests.

## Adversarial Defaults

- A `200 OK` is evidence to interrogate, not "no issue."
- A `403`/`404` means the server saw you and refused, not that the object is unreachable. Before recording a blocker, mutate: HTTP method, content type, an added/stripped trailing slash, path vs. query vs. body placement of the id, one encoding form, and a tenant/role header.
- A content-length or field difference across ids is a **signal**. File a low-confidence candidate and let validation resolve it; recording "no findings" after observing variance is a misuse of this skill.

## Surface Discovery and Prioritization

1. Inventory object ids in paths, query/body fields, headers, GraphQL variables, composite keys, and nested child ids (`query_notes ntype=http.endpoint`, `http.parameters`).
2. Create distinct synthetic objects for persona A and B with unmistakable markers.
3. Prioritize read, update, delete-like reversible test action, export/download, share, and nested collection endpoints, and write paths (`PUT`/`PATCH`) that return the object.
4. Record public/shared/collaborator policy before interpreting cross-user access.

## Safe Test Ladder

1. Verify A→A and B→B owner controls plus a nonexistent-id control.
2. Replay A's exact object reference as B, changing only the identifier.
3. For write paths, use a reversible marker and confirm state from A's clean session.
4. Test one alternate identifier representation only after a canonical result.
5. Stop at the first protected marker disclosure or unauthorized synthetic state change.

Never delete real objects, enumerate identifier ranges, access real users' data, or test outside approved personas.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Enumeration And Reference-Discovery Techniques

Prefer `http_differential` to dispatch one baseline plus N reference variants in a single call and read the labelled anomaly table:

```
http_differential(
  url_template="https://target/api/orders/{orderId}",
  parameter={ name: "orderId", in: "path" },
  baseline="<A's own id>",
  values=[
    { kind: "literal", value: "<B's id>" },
    { kind: "boundary" },
    { kind: "type_confusion" },
  ],
  signal="status",
  headers={ Authorization: "Bearer <B session>" },
)
```

When a differential is not the right shape, discover references by hand:

- Sequential numeric: try `id-1`, `id+1`, `id+100` — small deltas reveal neighbouring objects without a range sweep.
- UUID / opaque: harvest real ids from other endpoints (search results, list views, error bodies, referral links, audit logs), then replay them cross-identity.
- Hashed ids: test whether the id is `md5`/`sha1` of a small integer.
- Encoded ids: base64/base32/hex decode — these often wrap a sequential integer.
- GraphQL: use node/relationship fields and introspection to reach ids the REST surface hides.

## CRUD And Escalation Coverage

- For each object endpoint test every allowed method: `GET` (read another owner's object), `PUT`/`PATCH` (overwrite a reversible marker), `POST` to sub-resources (create under another owner), and a delete-like reversible action only on synthetic state.
- Horizontal: same privilege, another user's object (the common IDOR).
- Vertical: swap `roleId`, `orgId`, `tenantId` in the body or path to reach a higher-privilege object.
- Tenant/role headers: replay with `X-Organization-ID`, `X-Tenant-ID`, `X-Account-ID`, `X-Role` swapped to a peer/privileged value and compare.

## Indirect Reference And Chain Opportunities

- Indirect maps can leak: error bodies may echo the real id, search may return objects before the authorization check, and real-time/websocket channels may broadcast other users' data.
- Chain forward within bounded PoC: an IDOR that returns another synthetic user's record is a prerequisite for a `mass-assignment` overpost (add `isAdmin`, `verified`, `role`, `orgId` on the writable object) or an `access-control` function-level check. Record the pivot; execute only the steps that stay on synthetic, owner-confirmed state.

## Variation Matrix

- Identity: owner A, peer B, tenant peer, documented collaborator, privileged control.
- Reference: integer, UUID, slug, opaque token, composite/nested id.
- Location: path, query, JSON, GraphQL variable, header.
- Action: read, update marker, download/export, link/share; destructive action excluded.
- State: active, archived, shared, revoked, and nonexistent control.
- Representation: canonical, case, percent encoding, or one duplicate-key form.

## Proof Standard

Proof requires identity-separated access to protected synthetic data or a reversible unauthorized state change, with session identity evidence and owner/nonexistent controls. `200` alone, id enumeration, different errors, or intended sharing is not proof.

## False Positives and Benign Lookalikes

1. The object is intentionally public or explicitly shared with the test persona.
2. A correlation id makes error bodies differ while normalized outcomes are equal.
3. A cached owner response is replayed by the client but a fresh server read is denied.
4. The tested id is a collection/filter, not an authorization object reference.
5. A privileged role is correctly allowed by documented policy.

## Missing Prerequisites and Blocked Behavior

Block without a second persona, known object ownership, a safe reversible write, or a clean session identity signal. When public registration exists, provisioning a second synthetic persona is the correct unblock, not a blocker. Do not guess third-party ids to replace missing synthetic fixtures.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use `authz_replay` for identity-stable request matrices, `http_differential` for reference sweeps, HTTP history/replay for raw evidence, browser sessions for state confirmation, and repository reads for object membership checks. Use no bulk fuzzer for identifiers.

## Handoffs and Duplicate Prevention

Function-level or vertical role checks go to `access-control`; property-level read/write goes to `mass-assignment`; GraphQL resolver context may use `graphql`. `validation` owns the final proof decision. One object matrix should be shared across these owners.

## Stop, Cleanup, and Data Minimization

Restore marker changes, revoke test shares, and delete only synthetic objects through authorized owner actions. Retain object ids in redacted form when possible and only the fields needed to show the boundary.

## Sources

- [OWASP API1:2023 Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)
- [OWASP WSTG - Testing for Bypassing Authorization Schema](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/05-Authorization_Testing/02-Testing_for_Bypassing_Authorization_Schema)
