# JavaScript Surface Analysis - Annotated Examples

## Extracting Endpoints from a Bundle
```bash
python3 /opt/linkfinder/linkfinder.py -i https://target.com/static/js/app.4f2a1.js -o cli
```
Sample hit:
```
/api/v1/auth/login
/api/v1/users/{id}
/graphql
```

## Finding Leaked Tokens
```bash
python3 /opt/secretfinder/SecretFinder.py -i https://target.com/static/js/main.js -o cli
```
Sample hit:
```
AWS Access Key candidate: AKIA...
Hardcoded bearer token prefix in auth client
```

## Dependency Risk with retire.js
```bash
retire --js --outputformat json --path /workspace/js
```
Sample finding:
```
jquery 1.9.1 -> known XSS vulnerabilities
```

## Quick Internal Host Grep
```bash
grep -RhoE 'https?://[a-zA-Z0-9._-]+' /workspace/js | sort -u
```
Typical output includes:
```
https://api.target.com
https://staging-api.target.internal
```
