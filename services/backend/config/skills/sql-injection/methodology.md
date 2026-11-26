# SQL Injection Methodology

Research date: 2026-07-23

## Preconditions and Fast Applicability

Apply to a specific user-controlled query, form, path, header, or JSON value that plausibly influences a relational query. Retain the exact baseline request, identity, parameter type, response normalization rules, and database family only when observed.

An error, `sqlmap` label, SQL-looking source string, or database fingerprint is a lead. Stop as not applicable when the parameter never reaches query construction, uses a safely bound parameter with no structural interpolation, or the route is inactive.

## Surface Discovery and Prioritization

1. Prioritize search, filter, sort, report, login, lookup, export, and identifier parameters.
2. Separate string, numeric, list/array, identifier/order-by, JSON operator, and stored/procedure contexts.
3. In source mode, trace input through canonicalization, query builders/ORM escape hatches, raw fragments, and execution.
4. Establish stable body fields, row counts, status, errors, or latency before mutation.

## Safe Test Ladder

1. Capture three interleaved baselines and an equal-length inert control.
2. Use one quote/delimiter probe appropriate to the parameter type; treat errors only as leads.
3. Test a quote-balanced true/false predicate pair with identical nonsemantic structure.
4. Use a bounded two-second timing predicate only when body/status signals are unavailable; collect at least five interleaved candidate/control pairs.
5. Attempt union shape only in an isolated synthetic dataset and only when needed to prove an already stable lead. Do not enumerate schema or extract unrelated data.

Use concurrency 1, a five-second timeout, and no more than 12 candidates per parameter. Stop on rate limiting, baseline variance, or proof.

Never perform destructive actions, availability-impact testing, persistence, lateral movement, uncontrolled exfiltration, or full-impact exploitation.

## Detection Payload Reference

Use these to confirm injection, not to extract data. Pick the family by the stable signal available (body differential → boolean; visible DB error → error-based; neither → bounded timing). Only use dialect-specific syntax after a fingerprint; do not spray dialects.

- **Quote/structure probe (any DB):** a bare `'` — a DB syntax error or 500 is a lead, not proof.
- **Boolean pair (the workhorse):**
  - numeric: `1 AND 1=1` (baseline) vs `1 AND 1=2` (divergent → confirmed)
  - string: `x' AND '1'='1` vs `x' AND '1'='2`
- **Error-based version surfacing (fingerprint only, stop at the version string):**
  - MySQL: `' AND EXTRACTVALUE(1,CONCAT(0x7e,VERSION()))-- ` → `~8.0.x` in the error
  - PostgreSQL: `' AND 1=CAST(version() AS int)-- `
  - MSSQL: `' AND 1=CONVERT(int,@@version)-- `
- **Time-based (only when body/status give nothing), bounded to ~2s, matched controls:**
  - MySQL `1 AND SLEEP(2)-- `; PostgreSQL `1; SELECT pg_sleep(2)-- `; MSSQL `1; WAITFOR DELAY '0:0:2'-- `
- **UNION shape:** `1 ORDER BY N--` to find the column count as a *structure* proof, only in an isolated synthetic dataset. Stop at column count — do not `UNION SELECT` real tables, schema, or credentials.

The next step — reading `information_schema`, dumping rows, or extracting credentials — is outside bounded PoC. Record it as a blocked impact hypothesis and stop.

## Variation Matrix

- Parameter type: numeric, quoted string, list, JSON scalar, sort/identifier.
- Database family: use syntax only after PostgreSQL/MySQL/MSSQL/SQLite evidence; do not spray dialects.
- Predicate: matched true and false expressions with the same length/shape when practical.
- Comment/whitespace: canonical first, then one dialect-valid alternate.
- Transport: query, form, JSON, or one observed duplicate-parameter behavior.
- Execution mode: direct response versus known async report job with a correlated job id.

## Proof Standard

Proof is one of: a database-specific error reproducibly tied to the parameter and contradicted by inert controls; a stable normalized true/false result differential; or a statistically clear bounded timing predicate with matched controls and healthy service telemetry. Scanner output or a single delay is never proof.

## False Positives and Benign Lookalikes

1. Application validation or decoder errors occur equally for SQL and non-SQL punctuation.
2. Search-language `AND`/`OR` semantics change expected result counts.
3. Dynamic tokens, pagination, cache state, or dataset changes create body-length differences.
4. Rate limiting, queueing, or upstream saturation creates candidate and control latency.
5. ORM/raw-query code is unreachable or the value is bound as data.

## Missing Prerequisites and Blocked Behavior

Block when no stable comparison signal exists, the endpoint is rate limited, the dataset is changing, or only data extraction could distinguish behavior. Record the exact predicate/control pair and environment stability needed.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Prefer `http_differential` for paired bodies/timings, HTTP replay for exact predicates, and repository reads for source-to-query tracing. `tooling-sqlmap` may confirm a strong lead with bounded options, but its label alone cannot create a finding. Use `python_session` only for offline normalization/statistics.

## Handoffs and Duplicate Prevention

Hand NoSQL operators to `nosql-injection`, ORM/framework context to its platform skill, source reachability to `source-aware-whitebox`, and final disposition to `validation`. Reuse the same parameter baseline rather than repeating scanner and manual branches.

## Stop, Cleanup, and Data Minimization

Stop at the first deterministic predicate, after two dialect hypotheses fail, or at a quantitative cap. Cancel report jobs and retain only sanitized request/control pairs, normalized hashes, timings, and minimal synthetic row evidence.

## Sources

- [OWASP WSTG - Testing for SQL Injection](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/05-Testing_for_SQL_Injection)
- [PortSwigger Web Security Academy - SQL injection](https://portswigger.net/web-security/sql-injection)
