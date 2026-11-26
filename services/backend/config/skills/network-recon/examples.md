# Network Reconnaissance - Annotated Examples

## Broad Port Discovery
```bash
naabu -host 203.0.113.10 -p - -rate 1000
```
Typical output:
```
203.0.113.10:22
203.0.113.10:80
203.0.113.10:443
```

## Version Fingerprint
```bash
nmap -sV -sC -p 22,80,443 203.0.113.10
```
Typical output:
```
22/tcp open  ssh   OpenSSH 7.2p2
80/tcp open  http  nginx 1.14.0
443/tcp open ssl/http nginx 1.14.0
```

## Detect HTTP Services on Non-Standard Ports
```bash
echo -e "https://target.com:8443\nhttp://target.com:8080" | httpx -title -status-code
```
Signal:
```
https://target.com:8443 [200] [Admin Portal]
http://target.com:8080 [401] [API Gateway]
```

## TLS SAN Extraction
```bash
openssl s_client -connect target.com:443 </dev/null 2>/dev/null | grep -i "DNS:"
```
Signal:
```
DNS:target.com, DNS:api.target.com, DNS:staging.target.com
```
