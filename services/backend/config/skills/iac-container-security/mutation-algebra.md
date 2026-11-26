# IaC and Container Mutation Algebra

| Dimension | Bounded comparison | Evidence floor |
|---|---|---|
| Variable | default versus active environment value | provenance chain |
| Module | declared versus instantiated | call/reference path |
| Plan/render | source versus retained plan/manifest | exact revision hash |
| Image | build stage versus final digest/SBOM | layer membership |
| Privilege | one security-context field at a time | deployed workload link |
| Network | source range, listener, and upstream control | resolved effective path |
| Secret | placeholder pattern versus active literal reference | redact value; never validate |

Do not mutate or apply infrastructure. The matrix compares already available source, render, plan, and artifact states.
