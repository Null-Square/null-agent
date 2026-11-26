# Business Logic Mutation Algebra

| Axis | Bounded variation | Invariant |
|---|---|---|
| Transition | normal versus one skipped/reordered step | same synthetic record |
| Value authority | catalog value versus one client value | non-billable SKU |
| Replay | first versus one sequential replay | operation/coupon id |
| Approval | initiator versus documented approver control | same workflow state |
| Method | documented method versus one alternate | body and identity |
| State | active versus revoked/expired synthetic item | rule evidence |

Do not combine identity, value, order, and concurrency. Confirm every mutation from a clean server read and reverse test state.
