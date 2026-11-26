# Prototype Pollution Methodology

Use this method to prove that attacker-controlled keys modify an object prototype and, separately, whether a benign application behavior consumes the polluted property. It avoids process options, command sinks, service restarts, and availability-impacting probes.

## Preconditions and Fast Applicability

Require at least one of:

- a client-side URL, fragment, message, or JSON source that reaches object merge code;
- a server-side JSON or query parser followed by a merge, clone, defaults, or configuration operation; or
- white-box evidence of recursive assignment without reserved-key rejection.

Use a unique property name such as `b1pp_<run-id>` and a short value of equal uniqueness. For client-side tests, use an isolated browser profile. For server-side tests, require an evaluator-owned account and a route whose state can be reset.

Default limits: six source mutations, one property at a time, and no availability or runtime-configuration probes.

## Surface Discovery and Prioritization

Trace:

`attacker-controlled key syntax -> parser -> merge/assignment -> prototype -> consumer`

Inventory query parsers, JSON bodies, deep-merge libraries, default-option builders, configuration overlays, web messages, and URL fragment parsing. Record whether reserved keys are dropped at every nesting depth.

Prioritize sources where a newly created empty object can be observed after input processing. Separate source proof from gadget proof; a source can be vulnerable even when no material consumer has been established.

## Safe Test Ladder

### 1. Clean-state control

In a fresh browser realm or isolated server-side evaluator state, verify the random property is absent from a newly created empty object.

### 2. Direct reserved-key source

Submit one random marker through the syntax expected by the parser using a reserved prototype key. Create a new empty object after processing and observe whether it inherits the marker.

### 3. Constructor path

If the direct key is blocked, test one constructor/prototype nesting form. Do not iterate obfuscation lists.

### 4. Recursive sanitization

Use one nested object to determine whether filtering applies at every depth. The marker remains a string and does not name a real application option.

### 5. Cleanup control

Reload the isolated browser realm or reset the evaluator state and verify the marker is absent. If it persists server-side, stop and ask the owner to recycle the disposable test process.

### 6. Benign consumer

Only after source proof, test a documented evaluator canary property whose effect is a harmless response label, DOM data attribute, or test-harness log marker. Never guess operational configuration names. Compare explicit-own-property and inherited-property cases.

## Variation Matrix

| Axis | Bounded variants |
|---|---|
| source | query, fragment, JSON body, web message |
| key syntax | direct reserved key, constructor/prototype |
| depth | root, one nested object |
| context | fresh browser realm, isolated evaluator server state |
| observation | inherited random property, owner-provided benign consumer |
| control | absent marker, own property, post-reset absence |

Test only the sources actually present in the application.

## Proof Standard

Source proof requires:

1. the marker is absent before the request;
2. attacker-controlled input is processed;
3. a newly created unrelated object inherits the exact random marker;
4. an own-property check shows the marker is inherited rather than directly assigned; and
5. reset removes the marker.

A material gadget finding additionally requires an owner-provided benign consumer to behave differently for the inherited property, with an explicit own-property control. Do not infer code execution from source pollution alone.

## False Positives and Benign Lookalikes

- Developer tools or browser extensions can add properties in the inspected realm.
- The parser may assign the marker directly to the returned object.
- A test library can modify global prototypes before the application runs.
- A response field can echo the key without server-side prototype modification.
- An application default can coincidentally match the marker shape.
- A stale process can retain a marker from an earlier test.

Use a fresh random property and clean realm for each replay.

## Missing Prerequisites and Blocked Behavior

Return `blocked` when a fresh realm or disposable server state is unavailable, the marker cannot be safely observed, or no benign consumer has been supplied for impact validation. Preserve source proof as a lead when gadget impact remains blocked.

Never convert blocked or ambiguous work into a finding.

## Tool Selection and Fallback

Use browser tooling for client-side realm isolation and property inspection. Use `http_payload` for server-side source requests and white-box inspection for parser/merge traces. Use `report_note` to separate source evidence from consumer evidence.

If the server-side marker cannot be observed without restarting a shared service, stop and use source review in an isolated test instead.

## Handoffs and Duplicate Prevention

- Hand DOM execution sinks to `dom-xss` only after a benign consumer establishes the relevant property flow.
- Hand unsafe merge-library inventory to `software-supply-chain`.
- Hand source-code remediation confirmation to `source-aware-whitebox`.
- Hand availability behavior to `resource-consumption`; it is excluded here.

This skill owns prototype source and inherited-property evidence. A downstream sink should reference this proof rather than duplicate it.

## Stop, Cleanup, and Data Minimization

Stop after one source is independently reproduced, after the benign consumer control, at six mutations, or if shared state is affected. Close the browser profile or reset the disposable process and verify the property is gone.

Never perform destructive actions, mutate operational configuration, restart shared services, or test command and process options.

Research date: 2026-07-23

## Sources

- PortSwigger Web Security Academy, Prototype Pollution: https://portswigger.net/web-security/prototype-pollution
- PortSwigger Web Security Academy, Client-side Prototype Pollution: https://portswigger.net/web-security/prototype-pollution/client-side
- CWE-1321, Improperly Controlled Modification of Object Prototype Attributes: https://cwe.mitre.org/data/definitions/1321.html
