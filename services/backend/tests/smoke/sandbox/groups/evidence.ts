import type { PhaseSmokeGroup } from '../types';

export const evidenceGroup: PhaseSmokeGroup = {
  phase: 'evidence',
  tools: ['gitleaks', 'trufflehog', 'trivy', 'semgrep', 'bandit', 'ast-grep', 'retire'],
  extraChecks: [
    {
      name: 'semgrep scans a local rule and source file',
      command: [
        'cat > /workspace/.artifacts/smoke/semgrep-smoke.yaml <<\'YAML\'',
        'rules:',
        '  - id: nullai-smoke-eval',
        '    message: eval usage',
        '    severity: WARNING',
        '    languages:',
        '      - javascript',
        '    pattern: eval(...)',
        'YAML',
        'printf "eval(userInput);\\n" > /workspace/.artifacts/smoke/smoke.js',
        'semgrep --quiet --config /workspace/.artifacts/smoke/semgrep-smoke.yaml --json /workspace/.artifacts/smoke/smoke.js > /workspace/.artifacts/smoke/semgrep.json',
        'grep -q "nullai-smoke-eval" /workspace/.artifacts/smoke/semgrep.json',
        'echo NULLAI_SEMGREP_LOCAL_OK',
      ].join('\n'),
      expect: 'NULLAI_SEMGREP_LOCAL_OK',
    },
  ],
};
