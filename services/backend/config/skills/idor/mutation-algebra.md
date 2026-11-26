# IDOR Mutation Algebra

| Axis | Bounded pair | Invariant |
|---|---|---|
| Persona | owner A versus peer B | same object/request |
| Object | A's synthetic id, B's id, nonexistent id | known ownership |
| Nesting | parent+child correct versus foreign child | one child id changes |
| Representation | canonical UUID versus one encoded/case form | requester stays B |
| State | shared versus revoked | policy event recorded |
| Action | read versus reversible marker update | no destructive operation |

Never mutate multiple ids and identity simultaneously. Every result needs an owner and nonexistent control.
