# SSTI Mutation Algebra

Begin with one confirmed or strongly indicated engine.

| Axis | Examples of bounded variation | Required control |
|---|---|---|
| Delimiter | the canonical expression delimiter and one engine trim form | escaped delimiters remain literal |
| Context | unquoted value versus quoted template string | same arithmetic operands |
| Delivery | form, JSON, or saved-template field actually used by the feature | same render job type |
| Encoding | raw versus one channel-appropriate encoding | decoded input captured |
| Lifecycle | preview versus saved render | fresh marker per render |
| Whitespace | canonical spaces versus engine-supported trim marker | no object traversal tokens |

Never mutate toward object graphs, class loaders, file functions, environment access, or process APIs. The invariant is harmless arithmetic evaluation with a matched literal control.
