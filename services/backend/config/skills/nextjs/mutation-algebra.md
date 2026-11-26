# Next.js Mutation Algebra

| Next.js surface | Bounded variation |
|---|---|
| router | Pages route ↔ App route identified in build/source |
| rendering | server component/data request ↔ normal navigation |
| API | route handler/method pair actually exported |
| cache | fresh route segment ↔ cached response with unique canary key |
| identity | anonymous → evaluator owner → evaluator peer |
| configuration | active runtime env exposure ↔ build-time public variable |

Do not invoke revalidation/admin hooks or alter deployment caches broadly. Correlate build id/source revision before claiming active behavior.
