# Broken Authentication -- Bypass Mutation Algebra

## Dimension 1: Lockout Bypass Variants
When per-username or per-IP lockout is in place:

### Username variations (same account, different string)
- admin -> Admin, ADMIN, "admin " (trailing space), " admin" (leading space)
- Email: admin@target.com -> Admin@target.com, admin+test@target.com
- Unicode normalization: Cyrillic 'a' lookalike -> same account if app normalizes

### IP rotation variants
- X-Forwarded-For: 192.168.1.1 -- increment IP per attempt
- X-Real-IP: 10.0.0.1
- X-Remote-Addr: 172.16.0.1
- Client-IP: 192.0.2.1
- Test which headers the app trusts for rate limiting

### Parameter format confusion
- Array: {"username": ["admin"], "password": "x"} -- some parsers try each
- Nested: {"user": {"name": "admin"}} vs {"username": "admin"}
- URL-encoded body vs JSON body

## Dimension 2: Password Reset Token Attacks

### Sequential token prediction
Token for your account: reset_abc123_00001
Try: reset_abc123_00000, reset_abc123_00002

### Time-based token reconstruction
If token = MD5(username + timestamp):
Iterate through 60 seconds around reset time, try each candidate.

### IDOR in reset link
Reset link for your account: /reset?token=abc123&userId=1043
Try: /reset?token=abc123&userId=1042 (your token, victim userId)

### Host header injection in reset email
POST /forgot-password with Host: attacker.com header.
If app constructs reset link using Host header -> link points to attacker.com.

## Dimension 3: Session Fixation Variants

### Cookie fixation
Set session=ATTACKER_KNOWN_VALUE in cookie before login.
If response keeps same session ID -> session fixation confirmed.

### URL-based fixation (legacy Java)
GET /login;jsessionid=ATTACKER_KNOWN_VALUE

## Dimension 4: JWT Session Bypass
See /workspace/.skills/jwt-attacks/ for full JWT methodology.
Quick relevance to auth:
- alg:none -> forge claims without key
- Weak HS256 secret -> crack and forge admin claims
- Session not tied to server-side record -> no revocation possible

## Dimension 5: Race Condition in Auth Flows
- Concurrent POST /login -> may create multiple valid sessions
- Password reset race: send two reset requests simultaneously -> both tokens may be valid
- MFA validation race: send OTP and skip-to-dashboard request simultaneously
- Account creation race: create two accounts with same email simultaneously

## Dimension 6: OAuth State and CSRF
- Missing state parameter in /oauth/authorize response -> CSRF possible
- State not validated: app accepts any state value on callback
- state = static value: app always uses state=1 -> CSRF

## Decision Tree
Auth endpoint accessible?
  -> Test lockout (3 attempts): locked? -> Dimension 1 (lockout bypass)
  -> Test reset token entropy: predictable? -> Dimension 2 (token attacks)
  -> Test session after logout: valid? -> Session invalidation bug (report directly)
  -> Test MFA step skip: possible? -> MFA bypass (report directly)
  -> JWT session? -> See jwt-attacks skill
  -> OAuth flow? -> Dimension 6 (state/CSRF)
  -> All mitigated? Document controls as REMEDIATED
