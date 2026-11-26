#!/usr/bin/env sh
# services/sandbox/test/smoke.sh
#
# Validates every required tool and asset in the Null-AI sandbox image.
# Run inside the container:
#   docker run --rm -v "$(pwd)/services/sandbox/test:/test" \
#     --entrypoint sh <image> /test/smoke.sh

PASS=0
FAIL=0
ERRORS=""

ok() {
  printf "[PASS] %s\n" "$1"
  PASS=$((PASS + 1))
}

fail() {
  printf "[FAIL] %s\n" "$1"
  FAIL=$((FAIL + 1))
  ERRORS="${ERRORS}  - ${1}\n"
}

# check: pass a label and a command. Succeeds if command exits 0.
check() {
  label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    ok "$label"
  else
    fail "$label [$*]"
  fi
}

check_output() {
  label="$1"
  expected="$2"
  shift 2
  out=$("$@" 2>&1 || true)
  if printf "%s" "$out" | grep -qi "$expected"; then
    ok "$label"
  else
    fail "$label [expected '$expected' in output of: $*]"
  fi
}

check_file() {
  label="$1"
  path="$2"
  if [ -f "$path" ]; then
    ok "$label"
  else
    fail "$label [missing: $path]"
  fi
}

check_wc() {
  label="$1"
  min_lines="$2"
  path="$3"
  if [ -f "$path" ] && [ "$(wc -l < "$path")" -ge "$min_lines" ]; then
    ok "$label"
  else
    fail "$label [file $path has fewer than $min_lines lines]"
  fi
}

check_env() {
  label="$1"
  name="$2"
  eval "value=\${$name}"
  if [ -n "$value" ]; then
    ok "$label"
  else
    fail "$label [\$$name is unset]"
  fi
}

printf "\n=== Null-AI Sandbox Smoke Test ===\n\n"

printf "[1/9] Surface discovery\n"
check "subfinder: binary present" command -v subfinder
check_output "subfinder: reports version" "subfinder" subfinder -version
check "assetfinder: binary present" command -v assetfinder
check "assetfinder: invocable" assetfinder --help
check "amass: binary present" command -v amass
check "amass: invocable" amass -version
check "dnsx: binary present" command -v dnsx
check "dnsx: invocable" dnsx -version
check "puredns: binary present" command -v puredns
check "puredns: invocable" puredns --help
check "urlfinder: binary present" command -v urlfinder
check_output "urlfinder: reports version" "Current Version" urlfinder -version
check "gau: binary present" command -v gau
check_output "gau: reports version" "gau" gau --version

printf "\n[2/9] Port and service scanning\n"
check "nmap: binary present" command -v nmap
check_output "nmap: reports version" "Nmap" nmap --version
check "nmap: NSE engine loads" sh -c "nmap -sn --script default 127.0.0.1 >/dev/null 2>&1"
check "ncat: binary present" command -v ncat
check "ncat: invocable" ncat --help
check "nping: binary present" command -v nping
check_output "nping: reports version" "Nping version" nping --version
check "naabu: binary present" command -v naabu
check "naabu: invocable" naabu -version
check "httpx: binary present" command -v httpx
check "httpx: invocable" httpx -version
check "tlsx: binary present" command -v tlsx
check "tlsx: invocable" tlsx -version
check "testssl.sh: binary present" command -v testssl.sh
check_output "testssl.sh: reports version" "testssl.sh" testssl.sh --version

printf "\n[3/9] Crawling and client-side inspection\n"
check "gospider: binary present" command -v gospider
check "gospider: invocable" gospider --help
check "katana: binary present" command -v katana
check "katana: invocable" katana -h
check "linkfinder: binary present" command -v linkfinder
check "linkfinder: invocable" linkfinder -h
check "secretfinder: binary present" command -v secretfinder
check "secretfinder: invocable" secretfinder -h

printf "\n[4/9] Content and API discovery\n"
check "ffuf: binary present" command -v ffuf
check_output "ffuf: reports version" "ffuf" ffuf -V
check "gobuster: binary present" command -v gobuster
check "gobuster: invocable" gobuster --help
check "dirsearch: binary present" command -v dirsearch
check "dirsearch: invocable" dirsearch -h
check "arjun: binary present" command -v arjun
check_output "arjun: invocable" "usage" arjun --help
check "kiterunner: binary present" command -v kr
check "kiterunner: invocable" kr -h
check "unfurl: binary present" command -v unfurl
check "unfurl: invocable" unfurl --help
check "qsreplace: binary present" command -v qsreplace
check "qsreplace: invocable" qsreplace -h
check "anew: binary present" command -v anew
check "anew: invocable" anew -h
check_output "url pipeline helpers: transform URLs" "q=NULLAI" sh -c "printf 'https://example.com/a?q=1\n' | qsreplace NULLAI"
check_output "unfurl: extracts URL keys" "q" sh -c "printf 'https://example.com/a?q=1\n' | unfurl keys"

printf "\n[5/9] Vulnerability scanning\n"
check "nuclei: binary present" command -v nuclei
check_output "nuclei: reports version" "nuclei" nuclei -version
check "cvemap: binary present" command -v cvemap
check_output "cvemap: reports version" "cvemap" cvemap -version
check "dalfox: binary present" command -v dalfox
check "dalfox: invocable" dalfox version
check "nikto: binary present" command -v nikto
check "nikto: invocable" nikto -Version
check "wafw00f: binary present" command -v wafw00f
check_output "wafw00f: reports version" "wafw00f" wafw00f --version
check "schemathesis: binary present" command -v schemathesis
check_output "schemathesis: reports version" "schemathesis" schemathesis --version
check "grpcurl: binary present" command -v grpcurl
check_output "grpcurl: reports version" "grpcurl" grpcurl -version

TEMPLATE_FOUND=0
for d in \
  "/root/nuclei-templates" \
  "/root/.local/nuclei-templates" \
  "$HOME/nuclei-templates" \
  "$HOME/.local/nuclei-templates" \
  "/home/sandbox/nuclei-templates" \
  "/home/sandbox/.local/nuclei-templates" \
  "/nuclei-templates"; do
  if [ -d "$d" ] && [ "$(ls "$d" | wc -l)" -gt 10 ]; then
    TEMPLATE_FOUND=1
    break
  fi
done
if [ "$TEMPLATE_FOUND" = "1" ]; then
  ok "nuclei: templates directory populated"
else
  fail "nuclei: templates directory missing or empty"
fi

printf "\n[6/9] Injection and auth testing\n"
check "sqlmap: binary present" command -v sqlmap
check "sqlmap: invocable" sqlmap --version
check "jwt-tool: binary present" command -v jwt-tool
check "jwt-tool: invocable" jwt-tool -h

printf "\n[7/9] OOB, secrets, and dependency review\n"
check "interactsh-client: binary present" command -v interactsh-client
check "interactsh-client: invocable" interactsh-client -h
check "trufflehog: binary present" command -v trufflehog
check_output "trufflehog: reports version" "trufflehog" trufflehog --version
check "gitleaks: binary present" command -v gitleaks
check "gitleaks: invocable" gitleaks version
check "retire: binary present" command -v retire
check "retire: invocable" retire --version

printf "\n[8/9] Wordlists and environment\n"
check_file "raft-medium-directories.txt present" "/usr/share/wordlists/nullai/raft-medium-directories.txt"
check_wc "raft-medium-directories.txt has >=1000 lines" 1000 "/usr/share/wordlists/nullai/raft-medium-directories.txt"
check_file "subdomains-top5000.txt present" "/usr/share/wordlists/nullai/subdomains-top5000.txt"
check_wc "subdomains-top5000.txt has >=1000 lines" 1000 "/usr/share/wordlists/nullai/subdomains-top5000.txt"
check_file "common.txt present" "/usr/share/wordlists/nullai/common.txt"
check_wc "common.txt has >=100 lines" 100 "/usr/share/wordlists/nullai/common.txt"
check_file "parameters.txt present" "/usr/share/wordlists/nullai/parameters.txt"
check_wc "parameters.txt has >=100 lines" 100 "/usr/share/wordlists/nullai/parameters.txt"
check_file "api-endpoints.txt present" "/usr/share/wordlists/nullai/api-endpoints.txt"
check_wc "api-endpoints.txt has >=100 lines" 100 "/usr/share/wordlists/nullai/api-endpoints.txt"
check_file "upload-extensions.txt present" "/usr/share/wordlists/nullai/upload-extensions.txt"
check_wc "upload-extensions.txt has >=10 lines" 10 "/usr/share/wordlists/nullai/upload-extensions.txt"
check_file "swagger-paths.txt present" "/usr/share/wordlists/nullai/swagger-paths.txt"
check_wc "swagger-paths.txt has >=10 lines" 10 "/usr/share/wordlists/nullai/swagger-paths.txt"
check_file "routes-small.kite present" "/usr/share/wordlists/nullai/routes-small.kite"
check_wc "routes-small.kite has >=100 lines" 100 "/usr/share/wordlists/nullai/routes-small.kite"
check_file "xss-payloads.txt present" "/usr/share/wordlists/nullai/xss-payloads.txt"
check_wc "xss-payloads.txt has >=100 lines" 100 "/usr/share/wordlists/nullai/xss-payloads.txt"
check_file "sqli-payloads.txt present" "/usr/share/wordlists/nullai/sqli-payloads.txt"
check_wc "sqli-payloads.txt has >=20 lines" 20 "/usr/share/wordlists/nullai/sqli-payloads.txt"
check_file "lfi-payloads.txt present" "/usr/share/wordlists/nullai/lfi-payloads.txt"
check_wc "lfi-payloads.txt has >=100 lines" 100 "/usr/share/wordlists/nullai/lfi-payloads.txt"
check_file "ssti-payloads.txt present" "/usr/share/wordlists/nullai/ssti-payloads.txt"
check_wc "ssti-payloads.txt has >=20 lines" 20 "/usr/share/wordlists/nullai/ssti-payloads.txt"
check_file "ssrf-payloads.txt present" "/usr/share/wordlists/nullai/ssrf-payloads.txt"
check_wc "ssrf-payloads.txt has >=10 lines" 10 "/usr/share/wordlists/nullai/ssrf-payloads.txt"
check_env "INTERACTSH_SERVER is set" INTERACTSH_SERVER
check "curl: binary present" command -v curl
check "jq: binary present" command -v jq
check "python3: binary present" command -v python3
check "rg: binary present" command -v rg
check_output "rg: reports version" "ripgrep" rg --version
check "fd: binary present" command -v fd
check_output "fd: reports version" "fd" fd --version
check "yq: binary present" command -v yq
check_output "yq: reports version" "yq" yq --version
check "dig: binary present" command -v dig
check_output "dig: reports version" "DiG" dig -v
check "whois: binary present" command -v whois
check_output "whois: reports version" "Version" whois --version
check "openssl: binary present" command -v openssl
check_output "openssl: reports version" "OpenSSL" openssl version
check "ip: binary present" command -v ip
check_output "ip: reports version" "iproute2" ip -Version
check "socat: binary present" command -v socat
check_output "socat: reports version" "socat" socat -V

printf "\n[9/9] Private runner bridge\n"
check "node: binary present" command -v node
check_output "node: reports version" "v" node --version
check "chromium: binary present" command -v chromium
check "chromium: reports version" chromium --version
check_file "shell-server entrypoint present" "/app/src/index.js"
check "ws module installed" node -e "require('ws')"

printf "\n=== Results ===\n"
printf "Passed: %d\n" "$PASS"
printf "Failed: %d\n" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  printf "\nFailed checks:\n"
  printf "$ERRORS"
  printf "\nImage is incomplete. Fix Dockerfile before deploy.\n\n"
  exit 1
fi

printf "\nAll checks passed. Image is ready.\n\n"
exit 0
