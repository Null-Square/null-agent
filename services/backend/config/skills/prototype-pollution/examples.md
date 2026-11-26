# Prototype Pollution Examples

## Client-side source proof

Start a fresh isolated browser profile and choose:

```text
property: b1pp_7f3a
value: marker_21c9
```

Before navigation:

```javascript
Object.hasOwn(Object.prototype, "b1pp_7f3a") === false
({}).b1pp_7f3a === undefined
```

Navigate through the application’s observed query parser using the reserved-key syntax it supports. After processing:

```javascript
const probe = {};
probe.b1pp_7f3a === "marker_21c9"
Object.hasOwn(probe, "b1pp_7f3a") === false
```

Close the profile and repeat the absence control. This proves a client-side source without invoking a sink.

## Server-side source proof

An evaluator-only integration route accepts configuration JSON and returns a diagnostic list of inherited test properties. Send a random string marker through one reserved key. Proof requires:

- clean-state diagnostic reports absence;
- candidate request is accepted;
- a later newly created diagnostic object inherits the marker;
- an ordinary key does not cause inheritance; and
- resetting the disposable worker removes it.

If the only observation requires a shared worker restart, mark dynamic confirmation blocked.

## Benign consumer proof

The owner supplies a test-only `responseLabel` consumer. Compare:

1. no property: no label;
2. explicit own property: `X-Eval-Label: marker_21c9`;
3. inherited property from the proven source: same test label;
4. reset: no label.

The finding states exactly that the inherited property reaches this canary. It does not infer a different sink.

## Negative: recursive filter

The parser rejects reserved keys at root and nested depth. A new object never inherits the marker, while normal nested configuration still works. Record the filter as effective for the tested parser.

## Negative: direct assignment

The response object contains `b1pp_7f3a`, but:

```javascript
Object.hasOwn(responseObject, "b1pp_7f3a") === true
({}).b1pp_7f3a === undefined
```

This is ordinary property assignment, not prototype pollution.

## Ambiguous: stale state

The marker appears before the candidate request or remains after reset. The run cannot attribute it to the input. Use a new random property in a clean disposable state; otherwise record a blocker.

## Blocked: no benign consumer

Source pollution is independently proven, but impact requires guessing application option names. Retain the source proof and request an owner-provided canary property. Do not probe operational properties.

## Routing controls

- Positive: “Check whether the JSON deep merge lets a reserved key place a random inherited property on new objects.” Expected: `prototype-pollution`.
- Negative: “Check whether a user can update another user’s role field through the profile API.” Expected: `mass-assignment` or `idor`, not this skill.
