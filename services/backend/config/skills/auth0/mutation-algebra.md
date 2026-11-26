# Auth0 Mutation Algebra

| Auth0 binding | Safe variants |
|---|---|
| application | one supplied evaluator client; compare client type only from config |
| redirect/logout | registered URI → exact owner-controlled unregistered URI |
| organization | evaluator membership A → membership B → omitted org |
| connection | configured evaluator connection → omitted selector |
| token context | expected audience/issuer → one mismatched supplied audience |
| assurance | normal evaluator login → documented evaluator MFA flow |

Change no tenant settings. Stop after eight login flows, revoke evaluator grants, and hand generic OAuth/JWT semantics to their protocol packages.
