# Platform Domain

The `platform` domain owns the services around the SecurityOps execution path for the one person
using Null AI on their own computer.

## Subdomains

| Subdomain | Purpose |
|-----------|---------|
| `models/` | Model catalog, rate cards and provider keys |
| `notifications/` | The in-app notification feed and its writer |
| `profiles/` | The local owner's profile and preferences |
| `sandbox/` | Runtime sandbox image registry |
| `sessions/` | Session metadata resolution for product views |
| `settings/` | DB-backed runtime settings |
| `subscriptions/` | The local plan (one constant) and usage recording |

Platform seeding is app-level infrastructure. See `src/app/seeding/`.
