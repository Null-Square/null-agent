import { describe, expect, it } from 'vitest';
import { findCloudBlockedNetworkTargetsInCommand } from '@/domains/security-ops/scopes/networkTargetPolicy';

/**
 * D4 — the guard used to run its regexes over every byte of the raw command, so a browser
 * User-Agent containing `Windows NT 10.0` was read as the private network `10.0.0.0/8` and
 * an ordinary enumeration command was rejected in production run r1.
 *
 * The rule now is: unambiguous forms anywhere, ambiguous shorthand only in a host position.
 */
describe('cloud network target detection in a shell command', () => {
  describe('does not block text that merely looks like an address', () => {
    const allowed: Array<[string, string]> = [
      [
        'the User-Agent that was rejected in production',
        `curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" https://app.example.com`,
      ],
      ['a bare version number', 'echo grafana version 10.0 detected'],
      ['a version behind a non-host flag', 'curl --max-time 10.0 https://app.example.com'],
      ['a dotted archive name', 'tar -xzf build-2.0.tar.gz'],
      ['a semantic version triple', 'npm install left-pad@1.3.0'],
      ['an ISO date', 'echo scan started 2026-08-26'],
      ['a quoted JSON payload carrying a version', `curl -d '{"client":"agent","v":"10.0"}' https://app.example.com`],
      ['a large decimal inside prose', 'echo processed 2130706433 bytes of output'],
      ['a hex constant in a script body', 'python -c "MASK = 0x7f000001"'],
    ];

    for (const [name, command] of allowed) {
      it(name, () => {
        expect(findCloudBlockedNetworkTargetsInCommand(command)).toEqual([]);
      });
    }
  });

  describe('still blocks a real private or reserved destination', () => {
    const blocked: Array<[string, string, string]> = [
      ['a private URL', 'curl http://10.0.0.1/admin', '10.0.0.1'],
      ['the link-local metadata address', 'curl http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
      ['loopback shorthand as a positional host', 'nc 127.1 8080', '127.1'],
      ['two-part private shorthand as a positional host', 'ping 10.0', '10.0'],
      ['a hex-encoded loopback as a positional host', 'curl 0x7f000001', '0x7f000001'],
      ['a decimal-encoded loopback as a positional host', 'curl 2130706433', '2130706433'],
      ['a private host behind a host-bearing flag', 'httpx -u 192.168.1', '192.168.1'],
      ['a private host with an explicit port', 'nc 10.0:8080', '10.0'],
      ['a private CIDR range', 'nmap -sV 192.168.0.0/16', '192.168.0.0/16'],
      ['a dotted quad inside a quoted payload', `curl -d '{"cb":"http://127.0.0.1/x"}' https://app.example.com`, '127.0.0.1'],
      ['a curl resolve override to loopback', 'curl --resolve app.example.com:443:127.0.0.1 https://app.example.com', '127.0.0.1'],
    ];

    for (const [name, command, expected] of blocked) {
      it(name, () => {
        expect(findCloudBlockedNetworkTargetsInCommand(command)).toContain(expected);
      });
    }
  });

  it('does not let a pipeline leak a command word into the next command', () => {
    // `10.0` is a positional argument of `awk`, not of the `curl` before the pipe.
    expect(findCloudBlockedNetworkTargetsInCommand(
      'curl https://app.example.com | awk 10.0',
    )).toEqual([]);
  });

  it('reads a host-bearing flag on the command after a pipe', () => {
    expect(findCloudBlockedNetworkTargetsInCommand(
      'cat targets.txt | httpx -u 10.0',
    )).toContain('10.0');
  });

  it('treats an escaped space as part of one token rather than a new argument', () => {
    expect(findCloudBlockedNetworkTargetsInCommand(
      'cat /tmp/report\\ 10.0/notes.txt',
    )).toEqual([]);
  });

  it('reports every distinct blocked target once, sorted', () => {
    const found = findCloudBlockedNetworkTargetsInCommand(
      'curl http://10.0.0.1 && curl http://10.0.0.1 && curl http://127.0.0.1',
    );

    expect(found).toEqual(['10.0.0.1', '127.0.0.1']);
  });
});
