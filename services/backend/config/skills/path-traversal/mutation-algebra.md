# Path Traversal Mutation Algebra

Mutation starts from an allowed evaluator marker and targets only a known adjacent evaluator marker. Let:

- `B` be the intended base directory or object prefix;
- `A` be the allowed marker basename;
- `M` be the adjacent marker basename;
- `d` be the known number of parent transitions, capped at four; and
- `J(x)` be the application’s join/decode/canonicalization sequence.

The proof question is whether `J(parent(d) + M)` resolves outside `B` while remaining inside the dedicated evaluation sandbox.

## Axis 1 — Parent depth

Generate `parent(1)` through `parent(d)` one request at a time. Stop when the marker is reached or at the known boundary depth. Never guess deeper filesystem locations.

## Axis 2 — Decoder count

| Architecture evidence | Allowed representations |
|---|---|
| no URL decoder | literal |
| one decoder | literal, once encoded |
| two documented decoders | literal, once encoded, twice encoded |

Encoding is justified by observed layers, not by evasion volume.

## Axis 3 — Separator semantics

Use the target-native separator first. Test one alternate separator only when framework or OS evidence says it is accepted. Mixed separators are one additional candidate, not a combinatorial list.

## Axis 4 — Prefix and suffix rules

If the route requires a known base prefix or inert extension, preserve that constraint and change only the parent transition. Do not use memory-termination or parser-corruption behavior. The marker should have the expected inert extension.

## Axis 5 — Operation

- Read: compare exact allowed, adjacent, and absent marker values.
- Object lookup: compare canonical object keys under the assigned evaluator prefix.
- Archive extraction: compare directory listings before and after one disposable extraction.

Write testing is limited to the new random archive marker. Existing filenames are excluded.

## Reduction

After proof, reduce to the shortest representation that still returns the marker:

1. remove extra encoding;
2. reduce parent depth;
3. restore the native separator;
4. preserve only the required prefix or suffix.

The minimal reproducer and one absent-marker control are the retained evidence.

## Stop rules

Stop on exact marker proof, at four parent transitions, after two representations per evidenced decoder class, or on any unexpected file creation. Delete evaluator artifacts and never expand to host or application data.
