import { FIXTURE_PORT } from '../constants';
import type { PhaseSmokeGroup } from '../types';

export const validationGroup: PhaseSmokeGroup = {
  phase: 'validation',
  tools: [
    'nuclei',
    'cvemap',
    'dalfox',
    'sqlmap',
    'jwt-tool',
    'nikto',
    'interactsh-client',
    'schemathesis',
    'grpcurl',
  ],
  extraChecks: [
    {
      name: 'nuclei runs a scoped local template',
      command: [
        'cat > /workspace/.artifacts/smoke/nuclei-smoke.yaml <<\'YAML\'',
        'id: nullai-smoke-local-health',
        'info:',
        '  name: NullAI local smoke health check',
        '  author: nullai',
        '  severity: info',
        'http:',
        '  - method: GET',
        '    path:',
        '      - "{{BaseURL}}/health"',
        '    matchers:',
        '      - type: word',
        '        words:',
        '          - "ok"',
        'YAML',
        `nuclei -u http://127.0.0.1:${FIXTURE_PORT} -t /workspace/.artifacts/smoke/nuclei-smoke.yaml -jsonl -silent -o /workspace/.artifacts/smoke/nuclei.jsonl`,
        'test -s /workspace/.artifacts/smoke/nuclei.jsonl',
        'grep -q "nullai-smoke-local-health" /workspace/.artifacts/smoke/nuclei.jsonl',
        'echo NULLAI_NUCLEI_LOCAL_OK',
      ].join('\n'),
      expect: 'NULLAI_NUCLEI_LOCAL_OK',
    },
    {
      name: 'schemathesis accepts local OpenAPI schema',
      command: [
        'cat > /workspace/.artifacts/smoke/schemathesis-openapi.json <<\'JSON\'',
        `{"openapi":"3.0.3","info":{"title":"smoke","version":"1.0.0"},"servers":[{"url":"http://127.0.0.1:${FIXTURE_PORT}"}],"paths":{"/health":{"get":{"responses":{"200":{"description":"ok","content":{"text/plain":{"schema":{"type":"string"}}}}}}}}}`,
        'JSON',
        'schemathesis run /workspace/.artifacts/smoke/schemathesis-openapi.json --max-examples=1 --checks=not_a_server_error --phases=examples --report-junit-path /workspace/.artifacts/smoke/schemathesis.xml --report-preserve-bytes=false',
        'test -s /workspace/.artifacts/smoke/schemathesis.xml',
        'echo NULLAI_SCHEMATHESIS_SCHEMA_OK',
      ].join('\n'),
      expect: 'NULLAI_SCHEMATHESIS_SCHEMA_OK',
    },
  ],
};
