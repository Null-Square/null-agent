# syntax=docker/dockerfile:1.7
#
# Null-AI Execution Image — unified image for cloud and private runners.
#
# Dual-mode startup:
#   Private runner (default CMD):
#     docker run -d -e TOKEN=... -e API_URL=... null-ai-sandbox:local
#     → starts the Node.js WebSocket bridge, connects to Null-AI cloud
#
#   Cloud runner (backend overrides CMD per-session):
#     docker run --rm --user root <image> sh -c "nmap ..."
#     → runs the tool command directly, container exits when done
#
# To build locally for testing (no GHCR needed):
#   docker build -f services/sandbox/Dockerfile -t null-ai-sandbox:local .
#
# Build context must be the repo root (to access services/shell-server/src).

# ── go-builder ───────────────────────────────────────────────────────────────
FROM golang:1.26.7-alpine3.24@sha256:28d89ee9cc0ff9fec75c82ca201e6bf7fdf9a679d4b7b24dfa04f2bb766bb468 AS go-builder

RUN apk add --no-cache git gcc g++ make libpcap-dev curl tar

ARG SUBFINDER_VERSION=v2.16.0
ARG HTTPX_VERSION=v1.10.0
ARG NAABU_VERSION=v2.6.1
ARG KATANA_VERSION=v1.7.0
ARG INTERACTSH_VERSION=v1.3.1
ARG DNSX_VERSION=v1.3.0
ARG CVEMAP_VERSION=v1.0.0
ARG ASSETFINDER_VERSION=v0.1.1
ARG AMASS_VERSION=v4.2.0
ARG GOSPIDER_VERSION=v1.1.6
ARG FFUF_VERSION=v2.2.1
ARG GOBUSTER_VERSION=v3.8.2
ARG PUREDNS_VERSION=v2.1.1
ARG DALFOX_VERSION=v2.13.0
RUN GOBIN=/out go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@${SUBFINDER_VERSION}
RUN GOBIN=/out go install github.com/projectdiscovery/httpx/cmd/httpx@${HTTPX_VERSION}
RUN GOBIN=/out go install github.com/projectdiscovery/naabu/v2/cmd/naabu@${NAABU_VERSION}
RUN GOBIN=/out go install github.com/projectdiscovery/katana/cmd/katana@${KATANA_VERSION}
RUN GOBIN=/out go install github.com/projectdiscovery/interactsh/cmd/interactsh-client@${INTERACTSH_VERSION}
RUN GOBIN=/out go install github.com/projectdiscovery/dnsx/cmd/dnsx@${DNSX_VERSION}
RUN GOBIN=/out go install github.com/projectdiscovery/cvemap/cmd/cvemap@${CVEMAP_VERSION}
RUN GOBIN=/out go install github.com/tomnomnom/assetfinder@${ASSETFINDER_VERSION}
RUN GOBIN=/out go install github.com/owasp-amass/amass/v4/...@${AMASS_VERSION}
RUN GOBIN=/out go install github.com/jaeles-project/gospider@${GOSPIDER_VERSION}
RUN GOBIN=/out go install github.com/ffuf/ffuf/v2@${FFUF_VERSION}
RUN GOBIN=/out go install github.com/OJ/gobuster/v3@${GOBUSTER_VERSION}
RUN GOBIN=/out go install github.com/d3mondev/puredns/v2@${PUREDNS_VERSION}
ARG URLFINDER_VERSION=v0.0.3
ARG TLSX_VERSION=v1.2.2
ARG GAU_VERSION=v2.2.4
ARG UNFURL_VERSION=v0.4.3
ARG QSREPLACE_VERSION=v0.0.3
ARG ANEW_VERSION=v0.1.1
ARG GRPCURL_VERSION=v1.9.3
RUN GOBIN=/out go install github.com/projectdiscovery/urlfinder/cmd/urlfinder@${URLFINDER_VERSION}
RUN GOBIN=/out go install github.com/projectdiscovery/tlsx/cmd/tlsx@${TLSX_VERSION}
RUN GOBIN=/out go install github.com/lc/gau/v2/cmd/gau@${GAU_VERSION}
RUN GOBIN=/out go install github.com/tomnomnom/unfurl@${UNFURL_VERSION}
RUN GOBIN=/out go install github.com/tomnomnom/qsreplace@${QSREPLACE_VERSION}
RUN GOBIN=/out go install github.com/tomnomnom/anew@${ANEW_VERSION}
RUN GOBIN=/out go install github.com/fullstorydev/grpcurl/cmd/grpcurl@${GRPCURL_VERSION}
# kiterunner: go install doesn't work — download pre-built binary from releases
RUN curl -fsSL "https://github.com/assetnote/kiterunner/releases/download/v1.0.2/kiterunner_1.0.2_linux_amd64.tar.gz" \
  -o /tmp/kr.tar.gz \
  && tar -xzf /tmp/kr.tar.gz -C /out kr \
  && chmod +x /out/kr \
  && rm -f /tmp/kr.tar.gz
# gitleaks: build from source (pre-built binary download has redirect issues in Docker)
RUN git clone --depth 1 --branch v8.21.2 https://github.com/gitleaks/gitleaks.git /tmp/gitleaks \
  && cd /tmp/gitleaks \
  && go build -o /out/gitleaks . \
  && rm -rf /tmp/gitleaks
RUN GOBIN=/out go install github.com/hahwul/dalfox/v2@${DALFOX_VERSION}
ARG TRUFFLEHOG_VERSION=3.93.4
RUN curl -fsSL "https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_linux_amd64.tar.gz" \
  -o /tmp/trufflehog.tar.gz \
  && tar -xzf /tmp/trufflehog.tar.gz -C /out trufflehog \
  && chmod +x /out/trufflehog \
  && rm -f /tmp/trufflehog.tar.gz
ARG TRIVY_VERSION=0.70.0
RUN curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" \
  -o /tmp/trivy.tar.gz \
  && tar -xzf /tmp/trivy.tar.gz -C /out trivy \
  && chmod +x /out/trivy \
  && rm -f /tmp/trivy.tar.gz

# ── runtime ──────────────────────────────────────────────────────────────────
FROM projectdiscovery/nuclei:v3.11.1@sha256:582d5546902e67052097cb2d07296c642d50a1afc5e44623cb038845df9a32eb

LABEL org.opencontainers.image.title="Null-AI Execution Image"
LABEL org.opencontainers.image.description="Unified cloud + private runner image with full pentest toolchain"
LABEL org.opencontainers.image.source="https://github.com/null-square/null-ai"

USER root

ARG BANDIT_VERSION=1.9.4
ARG SEMGREP_VERSION=1.161.0
ARG SCHEMATHESIS_VERSION=4.21.8
ARG RETIRE_VERSION=5.4.2
ARG TESTSSL_VERSION=3.2.3

ENV DEBIAN_FRONTEND=noninteractive \
  KATANA_SYSTEM_CHROME_PATH=/usr/bin/chromium \
  INTERACTSH_SERVER=oast.fun \
  PATH="/opt/nullai/pytools/bin:${PATH}"

# ── pentest tools ─────────────────────────────────────────────────────────────
COPY --from=go-builder /out/ /usr/local/bin/

RUN apk add --no-cache \
  nmap \
  nmap-ncat \
  nmap-nping \
  nmap-scripts \
  nmap-nselibs \
  ast-grep \
  mitmproxy \
  nikto \
  perl-json \
  perl-xml-writer \
  ripgrep \
  fd \
  yq-go \
  bind-tools \
  whois \
  openssl \
  iproute2 \
  socat \
  coreutils \
  procps \
  python3 \
  py3-pip \
  git \
  curl \
  wget \
  jq \
  unzip \
  bash \
  nodejs \
  npm \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont

RUN ln -sf /usr/bin/nikto.pl /usr/local/bin/nikto && \
  chmod +x /usr/bin/nikto.pl /usr/local/bin/nikto

RUN mv /usr/local/bin/katana /usr/local/bin/katana.real && \
  { \
    printf '%s\n' '#!/bin/sh'; \
    printf '%s\n' 'case " $* " in'; \
    printf '%s\n' '  *" -headless "*|*" -hl "*|*" -hybrid "*|*" -hh "*)'; \
    printf '%s\n' '    case " $* " in'; \
    printf '%s\n' '      *" -system-chrome-path "*|*" -scp "*|*" -chrome-ws-url "*|*" -cwu "*)'; \
    printf '%s\n' '        exec /usr/local/bin/katana.real "$@"'; \
    printf '%s\n' '        ;;'; \
    printf '%s\n' '      *)'; \
    printf '%s\n' '        exec /usr/local/bin/katana.real -system-chrome-path "${KATANA_SYSTEM_CHROME_PATH:-/usr/bin/chromium}" -no-sandbox "$@"'; \
    printf '%s\n' '        ;;'; \
    printf '%s\n' '    esac'; \
    printf '%s\n' '    ;;'; \
    printf '%s\n' '  *)'; \
    printf '%s\n' '    exec /usr/local/bin/katana.real "$@"'; \
    printf '%s\n' '    ;;'; \
    printf '%s\n' 'esac'; \
  } > /usr/local/bin/katana && \
  chmod +x /usr/local/bin/katana

RUN python3 -m venv /opt/nullai/pytools && \
  /opt/nullai/pytools/bin/pip install --no-cache-dir --upgrade pip && \
  /opt/nullai/pytools/bin/pip install --no-cache-dir \
  arjun \
  bandit==${BANDIT_VERSION} \
  semgrep==${SEMGREP_VERSION} \
  schemathesis==${SCHEMATHESIS_VERSION} \
  sqlmap \
  wafw00f \
  jsbeautifier \
  requests

RUN for tool in arjun bandit semgrep schemathesis sqlmap wafw00f js-beautify; do \
    ln -sf "/opt/nullai/pytools/bin/${tool}" "/usr/local/bin/${tool}"; \
  done

RUN npm install -g retire@${RETIRE_VERSION}

RUN curl -fsSL "https://github.com/testssl/testssl.sh/archive/refs/tags/v${TESTSSL_VERSION}.tar.gz" \
  -o /tmp/testssl.tar.gz && \
  mkdir -p /opt/testssl && \
  tar -xzf /tmp/testssl.tar.gz -C /opt/testssl --strip-components=1 && \
  ln -sf /opt/testssl/testssl.sh /usr/local/bin/testssl.sh && \
  chmod +x /opt/testssl/testssl.sh && \
  rm -f /tmp/testssl.tar.gz

RUN git clone --depth 1 https://github.com/GerbenJavado/LinkFinder.git /opt/linkfinder && \
  /opt/nullai/pytools/bin/pip install --no-cache-dir \
  -r /opt/linkfinder/requirements.txt && \
  printf '#!/bin/sh\nexec /opt/nullai/pytools/bin/python /opt/linkfinder/linkfinder.py "$@"\n' > /usr/local/bin/linkfinder && \
  chmod +x /opt/linkfinder/linkfinder.py
RUN chmod +x /usr/local/bin/linkfinder

RUN git clone --depth 1 https://github.com/maurosoria/dirsearch.git /opt/dirsearch && \
  /opt/nullai/pytools/bin/pip install --no-cache-dir \
  -r /opt/dirsearch/requirements.txt && \
  printf '#!/bin/sh\nexec /opt/nullai/pytools/bin/python /opt/dirsearch/dirsearch.py "$@"\n' > /usr/local/bin/dirsearch && \
  chmod +x /opt/dirsearch/dirsearch.py
RUN chmod +x /usr/local/bin/dirsearch

RUN git clone --depth 1 https://github.com/m4ll0k/SecretFinder.git /opt/secretfinder && \
  /opt/nullai/pytools/bin/pip install --no-cache-dir \
  -r /opt/secretfinder/requirements.txt && \
  printf '#!/bin/sh\nexec /opt/nullai/pytools/bin/python /opt/secretfinder/SecretFinder.py "$@"\n' > /usr/local/bin/secretfinder && \
  chmod +x /opt/secretfinder/SecretFinder.py
RUN chmod +x /usr/local/bin/secretfinder

RUN git clone --depth 1 https://github.com/ticarpi/jwt_tool.git /opt/jwt-tool && \
  /opt/nullai/pytools/bin/pip install --no-cache-dir \
  pyjwt requests pycryptodome pycryptodomex termcolor cprint && \
  printf '#!/bin/sh\nexec /opt/nullai/pytools/bin/python /opt/jwt-tool/jwt_tool.py "$@"\n' > /usr/local/bin/jwt-tool && \
  chmod +x /opt/jwt-tool/jwt_tool.py /usr/local/bin/jwt-tool

RUN mkdir -p /usr/share/wordlists/nullai && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/raft-medium-directories.txt" \
  -o /usr/share/wordlists/nullai/raft-medium-directories.txt && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/DNS/subdomains-top1million-5000.txt" \
  -o /usr/share/wordlists/nullai/subdomains-top5000.txt && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/common.txt" \
  -o /usr/share/wordlists/nullai/common.txt && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/burp-parameter-names.txt" \
  -o /usr/share/wordlists/nullai/parameters.txt && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/api/api-endpoints.txt" \
  -o /usr/share/wordlists/nullai/api-endpoints.txt && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Fuzzing/extensions-most-common.fuzz.txt" \
  -o /usr/share/wordlists/nullai/upload-extensions.txt && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/Service-Specific/Swagger.txt" \
  -o /usr/share/wordlists/nullai/swagger-paths.txt && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Fuzzing/XSS/robot-friendly/XSS-Jhaddix.txt" \
  -o /usr/share/wordlists/nullai/xss-payloads.txt && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Fuzzing/Databases/SQLi/Generic-SQLi.txt" \
  -o /usr/share/wordlists/nullai/sqli-payloads.txt && \
  curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Fuzzing/LFI/LFI-Jhaddix.txt" \
  -o /usr/share/wordlists/nullai/lfi-payloads.txt && \
  curl -fsSL "https://raw.githubusercontent.com/swisskyrepo/PayloadsAllTheThings/master/Server%20Side%20Template%20Injection/Intruder/ssti.fuzz" \
  -o /usr/share/wordlists/nullai/ssti-payloads.txt && \
  curl -fsSL "https://wordlists-cdn.assetnote.io/data/kiterunner/routes-small.kite.tar.gz" \
  -o /tmp/routes-small.kite.tar.gz && \
  tar -xzf /tmp/routes-small.kite.tar.gz -C /usr/share/wordlists/nullai routes-small.kite && \
  rm -f /tmp/routes-small.kite.tar.gz && \
  { \
    printf '%s\n' 'http://127.0.0.1:80/'; \
    printf '%s\n' 'http://127.1/'; \
    printf '%s\n' 'http://0.0.0.0/'; \
    printf '%s\n' 'http://[::1]/'; \
    printf '%s\n' 'http://169.254.169.254/latest/meta-data/'; \
    printf '%s\n' 'http://metadata.google.internal/computeMetadata/v1/'; \
    printf '%s\n' 'file:///etc/passwd'; \
    printf '%s\n' 'gopher://127.0.0.1:6379/_INFO'; \
    printf '%s\n' 'dict://127.0.0.1:11211/stat'; \
    printf '%s\n' 'http://localhost/admin'; \
  } > /usr/share/wordlists/nullai/ssrf-payloads.txt

# Pre-download nuclei templates as root.
RUN set -eu; \
  for attempt in 1 2 3; do \
    if nuclei -update-templates -silent; then \
      break; \
    fi; \
    if [ "$attempt" = "3" ]; then \
      exit 1; \
    fi; \
    sleep 5; \
  done; \
  test -d /root/nuclei-templates; \
  test "$(find /root/nuclei-templates -mindepth 1 -maxdepth 1 | wc -l)" -gt 10

COPY services/sandbox/proxy/mitm_capture.py /opt/nullai/mitm_capture.py
COPY services/sandbox/tools-manifest.json /opt/nullai/tools-manifest.json
COPY services/sandbox/tool-versions.lock.json /opt/nullai/tool-versions.lock.json
COPY services/sandbox/test /opt/nullai/test

# ── WebSocket bridge (private runner mode) ────────────────────────────────────
WORKDIR /app

COPY services/shell-server/package.json /app/package.json
RUN npm install --omit=dev

COPY services/shell-server/src /app/src

# ── workspace ─────────────────────────────────────────────────────────────────
RUN mkdir -p /workspace
ENV WORKSPACE_ROOT=/workspace

# Clear the entrypoint inherited from projectdiscovery/nuclei:latest.
# Without this, CMD arguments are passed to nuclei instead of being run directly.
ENTRYPOINT []

# Default: start the WebSocket bridge (private runner mode).
# Cloud runner: backend overrides CMD and ENTRYPOINT per-session.
CMD ["node", "/app/src/index.js"]
