# Access-Control Decision Examples

## Confirmed

- Evaluator `member-a` receives `200` for its own invoice and `member-b`'s synthetic invoice after only the object id changes; the body contains `member-b`'s canary. Classify as `proof`.
- A read-only evaluator role invokes a supplied administrative export route and a matched administrator control shows the same completed export state. Classify as `proof`.

## Rejected or Deferred

- Both peer-object and nonexistent-object requests return the same generic `404` and no canary or state difference. Classify as `reject`.
- The peer request redirects to login because its session expired. Refresh the session before drawing any authorization conclusion.
- No second role or tenant identity was supplied. Classify vertical or cross-tenant work as `blocked`.

## Routing

- “Compare member, manager, and tenant-admin permissions on invoice and export routes” belongs here.
- “Inspect whether a JWT accepts an unexpected algorithm” belongs to `jwt-attacks`.
