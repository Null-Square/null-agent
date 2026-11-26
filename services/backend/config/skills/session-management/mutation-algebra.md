# Session Lifecycle Algebra

| Transition | Control pair |
|---|---|
| anonymous → login | identifier before/after authentication |
| login → privilege change | old session versus freshly issued session |
| active → logout | copied evaluator session before/after logout |
| active → password change | pre-change versus post-change session |
| idle/absolute expiry | just-inside versus just-outside documented window |
| parallel sessions | evaluator device A versus device B |

Use no more than six transitions and two evaluator devices. Revoke every session and distinguish application tokens from load-balancer cookies.
