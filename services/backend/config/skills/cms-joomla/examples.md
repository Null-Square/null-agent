# Joomla Examples

## Evidence Patterns

- The active manifest identifies a vulnerable extension version and its public component endpoint reproduces a documented, non-destructive authorization failure on a synthetic record.
- A guest evaluator reads an unpublished test article through `com_content`, while a nonexistent article and publisher control distinguish authorization from caching.

## Benign Lookalikes

- `/administrator/` redirects to the normal login screen.
- A template asset contains a Joomla version-like string that conflicts with the active manifest.
- An extension package exists in a backup directory but is not registered in the supplied extensions table.

## Boundary

Return `blocked` when extension activation or content visibility cannot be established. Never upload extensions, create administrators, or modify the live Joomla database.
