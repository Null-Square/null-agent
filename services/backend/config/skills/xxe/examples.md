# XML External Entity Examples

## Baseline

```xml
<?xml version="1.0" encoding="UTF-8"?>
<stock-check>
  <product>sku-7f3a</product>
</stock-check>
```

Record the normal response and confirm the route actually parses XML.

## Internal entity control

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE stock-check [
  <!ENTITY marker "b1-internal-7f3a">
]>
<stock-check>
  <product>&marker;</product>
</stock-check>
```

This shows whether entity substitution is visible, but it does not prove external resolution.

## Positive: nonce-only external callback

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE stock-check [
  <!ENTITY marker SYSTEM "https://eval-callback.example/b1-xxe/7f3a">
]>
<stock-check>
  <product>&marker;</product>
</stock-check>
```

The evaluator endpoint returns `b1-external-7f3a`. Proof requires the callback nonce to correlate to this request and the application to process the returned marker. The URI contains no local data.

Negative control:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE stock-check [
  <!ENTITY marker SYSTEM "https://invalid.eval.example/b1-xxe/7f3a">
]>
<stock-check>
  <product>&marker;</product>
</stock-check>
```

## Positive: owner-provided local fixture

The owner creates:

```text
/opt/b1-fixtures/xxe-marker-7f3a.txt
```

It contains only `b1-local-7f3a`. The candidate entity references that exact fixture URI. The finding retains the fixture hash and exact marker response. No other local URI is tested.

## Positive: XInclude

When declarations are disabled but the parser supports XInclude:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<stock-check xmlns:xi="http://www.w3.org/2001/XInclude">
  <product><xi:include href="https://eval-callback.example/b1-xxe/xi-7f3a" parse="text"/></product>
</stock-check>
```

Use the same callback and negative controls.

## Negative: raw reflection

The response includes `&marker;` literally and no callback occurs. The route stores or echoes XML but did not resolve the external reference.

## Negative: declaration rejected

The valid baseline succeeds; both internal and external declaration documents receive the parser’s documented prohibited-declaration error. Record effective enforcement for this entrypoint.

## Ambiguous: callback without attribution

A request reaches the callback before the application job starts or without the nonce. It is not proof. Repeat with a fresh nonce and correlate the job; otherwise retain no finding.

## Blocked: signed XML

The parser accepts only signed test messages and evaluator signing material is unavailable. Record the entrypoint, valid baseline failure, and required test identity. Do not tamper with a production signed assertion.

## Routing controls

- Positive: “Test whether the SOAP parser resolves a nonce-only external entity from the evaluator callback.” Expected: `xxe`.
- Negative: “Review authorization on SOAP operation `GetInvoice`.” Expected: `soap-security` or `idor`, not XXE.
