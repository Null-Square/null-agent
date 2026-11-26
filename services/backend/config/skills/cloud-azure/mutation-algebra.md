# Azure Mutation Algebra

| Axis | Variation | Locked limit |
|---|---|---|
| User boundary | anonymous, owner test user, peer test user | application identities only |
| Blob | exact synthetic name and nonexistent name | never container listing |
| Gateway | Front Door/APIM public URL and documented backend control | no host enumeration |
| Function | normal method with/without application auth | no key guessing |
| Template | active Bicep/ARM parameters versus defaults | deployment correlation required |
| Token config | issuer/audience/redirect observation | hand off; never acquire provider tokens |

Keep the synthetic resource and application route constant while changing one access or configuration dimension.
