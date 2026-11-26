import { FIXTURE_PORT } from '../constants';
import type { PhaseSmokeGroup } from '../types';

export const reconGroup: PhaseSmokeGroup = {
  phase: 'recon',
  tools: [
    'subfinder',
    'assetfinder',
    'amass',
    'dnsx',
    'puredns',
    'naabu',
    'nmap',
    'httpx',
    'wafw00f',
    'urlfinder',
    'gau',
    'tlsx',
    'testssl.sh',
    'dig',
    'whois',
  ],
  extraChecks: [
    {
      name: 'nmap sees local fixture port',
      command: [
        `nmap -sT -p ${FIXTURE_PORT} 127.0.0.1 -oX /workspace/.artifacts/smoke/nmap.xml >/dev/null`,
        `grep -q 'portid="${FIXTURE_PORT}"' /workspace/.artifacts/smoke/nmap.xml`,
        'echo NULLAI_NMAP_LOCAL_OK',
      ].join(' && '),
      expect: 'NULLAI_NMAP_LOCAL_OK',
    },
    {
      name: 'dns and tls helpers run locally',
      command: [
        'mkdir -p /workspace/.artifacts/smoke/recon',
        'dig +time=1 +tries=1 localhost > /workspace/.artifacts/smoke/recon/dig-localhost.txt 2>&1',
        'grep -qi "HEADER" /workspace/.artifacts/smoke/recon/dig-localhost.txt',
        'openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=localhost -keyout /workspace/.artifacts/smoke/recon/key.pem -out /workspace/.artifacts/smoke/recon/cert.pem -days 1 >/dev/null 2>&1',
        '(timeout 20s openssl s_server -quiet -accept 9443 -cert /workspace/.artifacts/smoke/recon/cert.pem -key /workspace/.artifacts/smoke/recon/key.pem -www > /workspace/.artifacts/smoke/recon/s_server.log 2>&1 & echo $! > /workspace/.artifacts/smoke/recon/s_server.pid)',
        'sleep 1',
        'echo Q | timeout 10s openssl s_client -connect 127.0.0.1:9443 -servername localhost > /workspace/.artifacts/smoke/recon/s_client.txt 2>/dev/null',
        'grep -q "BEGIN CERTIFICATE" /workspace/.artifacts/smoke/recon/s_client.txt',
        'kill "$(cat /workspace/.artifacts/smoke/recon/s_server.pid)" 2>/dev/null || true',
        'echo NULLAI_DNS_TLS_LOCAL_OK',
      ].join(' && '),
      expect: 'NULLAI_DNS_TLS_LOCAL_OK',
    },
  ],
};
