# XSS Examples

## Reflected proof

Raw HTML places the marker in an executable attribute context. A clean browser sets only a page-local flag; an entity-encoded control stays literal. Expected disposition: proof.

## Stored proof

Persona A stores a harmless marker and persona B's authorized review view executes it. Reload reproduces it and cleanup removes it. Expected disposition: proof.

## Encoded reflection

Raw response encodes all delimiters, final DOM has one text node, and no flag is set. Expected disposition: reject.

## JSON response

The marker exists inside valid JSON and the application inserts it with `textContent`. Expected disposition: reject.

## Browser unavailable

An unusual context cannot be validated without the approved browser. Expected disposition: blocked, never a finding from reflection alone.
