import { FIXTURE_PORT } from '../constants';
import type { PhaseSmokeGroup } from '../types';

export const enumerationGroup: PhaseSmokeGroup = {
  phase: 'enumeration',
  tools: [
    'katana',
    'gospider',
    'ffuf',
    'gobuster',
    'dirsearch',
    'arjun',
    'kr',
    'linkfinder',
    'secretfinder',
    'unfurl',
    'qsreplace',
    'anew',
  ],
  extraChecks: [
    {
      name: 'katana crawls local fixture',
      command: [
        `katana -u http://127.0.0.1:${FIXTURE_PORT} -d 1 -silent -jsonl -o /workspace/.artifacts/smoke/katana.jsonl`,
        'test -s /workspace/.artifacts/smoke/katana.jsonl',
        'grep -q "127.0.0.1" /workspace/.artifacts/smoke/katana.jsonl',
        'echo NULLAI_KATANA_LOCAL_OK',
      ].join(' && '),
      expect: 'NULLAI_KATANA_LOCAL_OK',
    },
    {
      name: 'katana headless uses packaged system chrome',
      command: [
        'rm -rf /tmp/nullai-katana-system-chrome-smoke',
        'mkdir -p /tmp/nullai-katana-system-chrome-smoke /workspace/.artifacts/smoke',
        `HOME=/tmp/nullai-katana-system-chrome-smoke timeout 45s katana -u http://127.0.0.1:${FIXTURE_PORT} -d 1 -headless -system-chrome-path /usr/bin/chromium -no-sandbox -silent -jsonl -o /workspace/.artifacts/smoke/katana-headless.jsonl 2> /workspace/.artifacts/smoke/katana-headless.stderr`,
        'test -s /workspace/.artifacts/smoke/katana-headless.jsonl',
        '! grep -RiqE "storage.googleapis.com|download.*chrom|chrom.*download" /tmp/nullai-katana-system-chrome-smoke /workspace/.artifacts/smoke/katana-headless.stderr',
        'echo NULLAI_KATANA_SYSTEM_CHROME_OK',
      ].join(' && '),
      expect: 'NULLAI_KATANA_SYSTEM_CHROME_OK',
    },
    {
      name: 'ffuf consumes a local wordlist and writes JSON output',
      command: [
        "printf 'health\\napi/openapi.json\\nmissing\\n' > /workspace/.artifacts/smoke/ffuf-paths.txt",
        `timeout 20s ffuf -u http://127.0.0.1:${FIXTURE_PORT}/FUZZ -w /workspace/.artifacts/smoke/ffuf-paths.txt -mc all -of json -o /workspace/.artifacts/smoke/ffuf.json -s -noninteractive -t 1 -timeout 5`,
        'test -s /workspace/.artifacts/smoke/ffuf.json',
        'grep -q "commandline" /workspace/.artifacts/smoke/ffuf.json',
        'echo NULLAI_FFUF_JSON_OK',
      ].join(' && '),
      expect: 'NULLAI_FFUF_JSON_OK',
    },
    {
      name: 'url pipeline helpers normalize and deduplicate urls',
      command: [
        'mkdir -p /workspace/.artifacts/smoke/url-pipeline',
        "printf 'https://example.com/a?q=1\\nhttps://example.com/a?q=2\\nhttps://example.com/b?debug=true\\n' > /workspace/.artifacts/smoke/url-pipeline/urls.txt",
        'cat /workspace/.artifacts/smoke/url-pipeline/urls.txt | unfurl keys | sort -u > /workspace/.artifacts/smoke/url-pipeline/keys.txt',
        'grep -qx q /workspace/.artifacts/smoke/url-pipeline/keys.txt',
        'grep -qx debug /workspace/.artifacts/smoke/url-pipeline/keys.txt',
        'cat /workspace/.artifacts/smoke/url-pipeline/urls.txt | qsreplace NULLAI > /workspace/.artifacts/smoke/url-pipeline/fuzzed.txt',
        'grep -q "q=NULLAI" /workspace/.artifacts/smoke/url-pipeline/fuzzed.txt',
        'cat /workspace/.artifacts/smoke/url-pipeline/urls.txt | anew /workspace/.artifacts/smoke/url-pipeline/unique.txt >/dev/null',
        'cat /workspace/.artifacts/smoke/url-pipeline/urls.txt | anew /workspace/.artifacts/smoke/url-pipeline/unique.txt >/dev/null',
        'test "$(wc -l < /workspace/.artifacts/smoke/url-pipeline/unique.txt)" -eq 3',
        'echo NULLAI_URL_PIPELINE_OK',
      ].join(' && '),
      expect: 'NULLAI_URL_PIPELINE_OK',
    },
  ],
};
