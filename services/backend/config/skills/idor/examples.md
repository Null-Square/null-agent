# IDOR Examples

## Horizontal read

Persona B requests persona A's synthetic object and receives A's unique marker; B's own and nonexistent controls behave distinctly. Session evidence remains B. Expected disposition: proof.

## Reversible write

B updates A's synthetic label, and A observes the new marker in a clean session. Cleanup restores it. Expected disposition: proof.

## Public object

A published article returns identically to A, B, and unauthenticated clients; draft controls remain owner-only. Expected disposition: reject.

## Collaborator

A explicitly shares a project with B, B's editor access matches policy, and revocation removes it. Expected disposition: reject.

## Missing persona

Only one account exists. Visible UUIDs do not authorize guessing other users' data. Expected disposition: blocked.
