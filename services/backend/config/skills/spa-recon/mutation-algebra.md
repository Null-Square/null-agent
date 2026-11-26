# SPA Recon Mutation Algebra

| Provenance | Expansion |
|---|---|
| router | known route → lazy chunk referenced by it |
| network | observed request → normalized API template |
| source map | generated location → original call site |
| configuration | runtime public config → named base URL |
| feature | enabled runtime flag → reachable route |

Do not brute-force chunks or routes. Deduplicate assets by content hash and endpoints by method/template/auth state; stop when a full navigation yields no new artifacts.
