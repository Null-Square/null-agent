# RCE Validation Algebra

RCE confirmation is offline or evaluator-instrumented; never use operating-system commands.

| Stage | Allowed marker |
|---|---|
| source trace | attacker-controlled fixture field |
| interpreter boundary | mock/stub invocation record |
| argument effect | inert token `B1_RCE_CANARY` |
| control | fixed implementation or escaped value |
| deployment | active call path evidence without execution |

Stop at interpreter reachability in a disposable harness. Do not spawn processes, access files, establish persistence, or prove host identity.
