import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeRawHttpSend,
  RAW_HTTP_HELPER_SCRIPT,
  RAW_HTTP_RESULT_MARKER,
} from '@/domains/agent-brain/adapters/tools/runtime/rawHttpExecutor';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';

const execFileAsync = promisify(execFile);

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

const TEST_TLS_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAs9NKNGxwVU46pozTy6p5Crm5LymrKrjgrut5EDBlkgyqVyuW
dM46QrPYmpUU3KvFOTCknzhGcpjqy/wJKpfrOFCykvjsSSpbOXiU0QI0BRbZQMKb
OVr/xiD0ioGDOwvsoL5gsTszOQL4inqdKYizycBYM6F9R4Lamp5W+m0bp6rZi1aF
36CM/TPwkIQoCubyVqOZch1q56SMjTjDs8zQaPKwxtO7Z6p/wcPwsHJV1d5SFFtc
9a+bTSfsGxzil8LzRtOK0DcfDv3h7ZzoVX4vlOrPiO370iHtWTY84Wm8u/QaF963
iw0XI+GVFXbjLya4ewHWc9VXtuTi0TaxWC8dlQIDAQABAoIBABc2k0GpLecVLiUJ
0N1dqDpmNy2LZ3kgXIC4DOy2EqaD1AlkqwtxA7xQkwmBbSv/UHpNeTLEhPOOIeEr
K9O/wLGIWUT3tSjMuvH0SuGgMy7lAC6H8Jm60YG2B1tJ1LLumyE08i5uwfH+HC9k
HJ2b8/l7RueDVTTCA44qGnhBVWyTPd8hiFV6vGb0ieClHtoRNbGP1MMG2hKLChtC
5c2Ld89DCoe+84R94uzYkS7QDdWLJSNT9VQOY732OJxM86P+XAwsg81Hs4H59LCp
S7RtxuDJzbQ7TzOpsJKm4USZm+m1NjuseUpVoz3NWAY4ZJfhqXsyk1cu4n3prF/U
UY+C0xECgYEA6hVVXBe4m2hVIsuJaMGPBZt4w2uipIq/wcAeZ1F4lCjBph2pXiwL
WOCtPAeX3e0JMcyiXaKcIFFZT9sKsGgAQE4OWtO7z1sXMrul4VqLrDRkb9M0TyC1
EWNd2yBKUKdVjl0BvbdDh7lWaIrKqSl7qNiKxixV41czrz7PXTrDsvsCgYEAxKl2
85Wz1ubJO8JYz4fMX2Sy0JzxuV6N/JmhaNZ9OhxHBEhJ21+mMJnPtvplpSFUIxw8
bVl/8ELMWpH3z6GZTVemFLKphly1OCIrbTUAdCteHPSDtTJtVhRdKlVuUyq8UtBy
jWlN7jUlr+IsFLvD9EDnrNohmQZcCn5pOSDMDK8CgYA2e9ywYL0RPwmB3coP3e2C
KpvDMIxcrAbR+/uXpLjiE1Jvbbv8NVg2yaTIsiPA/ekD9FNeY/je9NBK6/ri8HIO
hZyFu36dVuBhaJfFiiO0Y0V1Wb11JXG/qFcyJ6Pkfe5GApPjKoLHVnYsQxHEqekk
dbJnSe57ydI32fC+DG18fQKBgBvzAabIpdBq6DqH+ls0L4V3KDqhs3Dm0UMPCnN9
2DpD/ovLQkPdKh9KHM0idQOs4upCfwwDZj1dIPHWQOPPUZw+UqoqYhFoZ5DculNA
7xmTeEKhNX6w9fz/0+XKUm2bazxRx5X1W0/5WavPdvhTXxv9hW95aMD4uGf9YzLt
SFKdAoGAT4C4Zj9oUjeUwX8abL1GPIdHaT0axdSoF0v4YQrp+lryIkbE3pzSYHz5
xB0glQQy0mHIrqPHLntwRJizpzH80P4rz1zLaENhsWn2P/x7R4RSyo8hrBFZnVin
np2r/U9LmIGgWMFBS3Sb9IlgQZC+/d9WuprAEBZrvW3GMLk8tmk=
-----END RSA PRIVATE KEY-----
`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIC1DCCAbygAwIBAgIUAU5chIS6K/1zbmByz9+BJcXEJgwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDYxODA3MjM0MFoXDTM2MDYx
NjA3MjM0MFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAs9NKNGxwVU46pozTy6p5Crm5LymrKrjgrut5EDBlkgyq
VyuWdM46QrPYmpUU3KvFOTCknzhGcpjqy/wJKpfrOFCykvjsSSpbOXiU0QI0BRbZ
QMKbOVr/xiD0ioGDOwvsoL5gsTszOQL4inqdKYizycBYM6F9R4Lamp5W+m0bp6rZ
i1aF36CM/TPwkIQoCubyVqOZch1q56SMjTjDs8zQaPKwxtO7Z6p/wcPwsHJV1d5S
FFtc9a+bTSfsGxzil8LzRtOK0DcfDv3h7ZzoVX4vlOrPiO370iHtWTY84Wm8u/Qa
F963iw0XI+GVFXbjLya4ewHWc9VXtuTi0TaxWC8dlQIDAQABox4wHDAaBgNVHREE
EzARgglsb2NhbGhvc3SHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAJu7sOxSBcEU
8gF6U267lVw+sHZyy5obj2F+4f2l+SLws2BJbHoU8O6Kb2HB7LlBv0TuBotjkvk9
Q2xbSIhUBpUQehs3v4JaSmDfjNANiSOTHbpiQs2/0WDGZAillfNUdzEGn6oLahq3
UM+1DGRaQB3dXbyyhD4VUPthFQmRV6T9SG8k6YWTtl8Pck/sVSwi7mZT0zuHksR6
mU+rcKHYiAqieledvpCoyKjbvFqtMAWpYG3fKzquxz0vbp5MdivqqzXhINeurlBM
Xbe3Mv9YDkY+J4ax/URW6U4qO0JFyPwofbU+pdImOfRJF6xfudiiU4GMaHgp029A
kqtbIS9xYV8=
-----END CERTIFICATE-----
`;

const candidatePythonCommands = (): string[] => [
  ...(process.env.PYTHON ? [process.env.PYTHON] : []),
  'python3',
  'python',
];

const resolvePython = async (): Promise<string> => {
  for (const command of candidatePythonCommands()) {
    try {
      await execFileAsync(command, ['--version'], { timeout: 5_000, windowsHide: true });
      return command;
    } catch {
      continue;
    }
  }
  throw new Error('python3/python is required for raw HTTP helper tests');
};

const parseHelperResult = (stdout: string): Record<string, unknown> => {
  const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith(RAW_HTTP_RESULT_MARKER));
  if (!line) {
    throw new Error(`raw helper result marker missing from stdout: ${stdout}`);
  }
  return JSON.parse(line.slice(RAW_HTTP_RESULT_MARKER.length)) as Record<string, unknown>;
};

const writeHelperInput = async (
  tempDir: string,
  payload: Record<string, unknown>,
): Promise<{ scriptPath: string; inputPath: string }> => {
  const scriptPath = path.join(tempDir, 'raw_http_send.py');
  const inputPath = path.join(tempDir, 'input.json');
  await fs.writeFile(scriptPath, RAW_HTTP_HELPER_SCRIPT, 'utf8');
  await fs.writeFile(inputPath, JSON.stringify(payload, null, 2), 'utf8');
  return { scriptPath, inputPath };
};

type RawServer = {
  port: number;
  close: () => Promise<void>;
  received: () => Buffer;
  connections: () => number;
};

const startRawServer = async (
  onData: (socket: net.Socket, received: Buffer) => void,
): Promise<RawServer> => {
  const chunks: Buffer[] = [];
  let connectionCount = 0;
  const server = net.createServer((socket) => {
    connectionCount += 1;
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      onData(socket, Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port');
  }
  return {
    port: address.port,
    received: () => Buffer.concat(chunks),
    connections: () => connectionCount,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const startTlsRawServer = async (
  onData: (socket: tls.TLSSocket, received: Buffer) => void,
): Promise<RawServer> => {
  const chunks: Buffer[] = [];
  let connectionCount = 0;
  const server = tls.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (socket) => {
    connectionCount += 1;
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      onData(socket, Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test TLS server did not bind to a TCP port');
  }
  return {
    port: address.port,
    received: () => Buffer.concat(chunks),
    connections: () => connectionCount,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

describe('raw HTTP helper', () => {
  let cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.map((target) => fs.rm(target, { recursive: true, force: true })),
    );
    cleanupPaths = [];
  });

  it('preserves duplicate headers, header order, conflicting length semantics, and omitted Host', async () => {
    const python = await resolvePython();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-raw-http-'));
    cleanupPaths.push(tempDir);

    const rawRequest = [
      'POST /smuggle HTTP/1.1',
      'X-First: one',
      'X-First: two',
      'Transfer-Encoding: chunked',
      'Content-Length: 4',
      'X-Order: last',
      '',
      '4',
      'test',
      '0',
      '',
      '',
    ].join('\r\n');
    const requestBytes = Buffer.from(rawRequest, 'utf8');

    const server = await startRawServer((socket, received) => {
      if (received.includes(Buffer.from('0\r\n\r\n', 'utf8'))) {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
      }
    });

    try {
      const artifactDir = path.join(tempDir, 'artifacts');
      const { scriptPath, inputPath } = await writeHelperInput(tempDir, {
        id: 'raw-preserve',
        target: {
          url: `http://127.0.0.1:${server.port}/`,
          host: '127.0.0.1',
          port: server.port,
          tls: false,
          server_name: '127.0.0.1',
          insecure: false,
        },
        artifact_dir: artifactDir,
        requests: [{ base64: requestBytes.toString('base64') }],
        read_strategy: 'after_each',
        timeout_sec: 5,
        read_idle_timeout_ms: 100,
        max_response_bytes: 20_000,
      });

      const { stdout } = await execFileAsync(python, [scriptPath, inputPath], {
        timeout: 10_000,
        windowsHide: true,
      });
      const result = parseHelperResult(String(stdout));

      expect(result.ok).toBe(true);
      expect(result.status_code).toBe(200);
      expect(server.received()).toEqual(requestBytes);
      expect(server.received().toString('utf8')).not.toMatch(/^Host:/im);
      expect(server.received().toString('utf8').indexOf('X-First: one')).toBeLessThan(
        server.received().toString('utf8').indexOf('X-First: two'),
      );
      expect(server.received().toString('utf8')).toContain('Transfer-Encoding: chunked\r\nContent-Length: 4');

      const requestArtifact = path.join(artifactDir, 'request-1.bin');
      const storedRequest = await fs.readFile(requestArtifact);
      expect(storedRequest).toEqual(requestBytes);
      expect(result.request_artifacts).toEqual([
        expect.objectContaining({
          sha256: sha256(requestBytes),
          size: requestBytes.length,
        }),
      ]);
    } finally {
      await server.close();
    }
  });

  it('can send a two-request sequence on the same socket before reading', async () => {
    const python = await resolvePython();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-raw-http-seq-'));
    cleanupPaths.push(tempDir);

    const first = Buffer.from('GET /one HTTP/1.1\r\nHost: example.test\r\n\r\n', 'utf8');
    const second = Buffer.from('GET /two HTTP/1.1\r\nHost: example.test\r\n\r\n', 'utf8');
    const expected = Buffer.concat([first, second]);
    let responded = false;

    const server = await startRawServer((socket, received) => {
      if (!responded && received.includes(Buffer.from('GET /two HTTP/1.1', 'utf8'))) {
        responded = true;
        socket.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n');
      }
    });

    try {
      const artifactDir = path.join(tempDir, 'artifacts');
      const { scriptPath, inputPath } = await writeHelperInput(tempDir, {
        id: 'raw-sequence',
        target: {
          url: `http://127.0.0.1:${server.port}/`,
          host: '127.0.0.1',
          port: server.port,
          tls: false,
          server_name: '127.0.0.1',
          insecure: false,
        },
        artifact_dir: artifactDir,
        requests: [
          { base64: first.toString('base64') },
          { base64: second.toString('base64') },
        ],
        read_strategy: 'after_all',
        timeout_sec: 5,
        read_idle_timeout_ms: 100,
        max_response_bytes: 20_000,
      });

      const { stdout } = await execFileAsync(python, [scriptPath, inputPath], {
        timeout: 10_000,
        windowsHide: true,
      });
      const result = parseHelperResult(String(stdout));

      expect(result.ok).toBe(true);
      expect(result.status_code).toBe(204);
      expect(server.connections()).toBe(1);
      expect(server.received()).toEqual(expected);
    } finally {
      await server.close();
    }
  });

  it('sends exact request bytes over TLS without normalization', async () => {
    const python = await resolvePython();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-raw-http-tls-'));
    cleanupPaths.push(tempDir);

    const requestBytes = Buffer.from(
      'GET /tls HTTP/1.1\r\nX-Dupe: first\r\nX-Dupe: second\r\n\r\n',
      'utf8',
    );

    const server = await startTlsRawServer((socket, received) => {
      if (received.includes(Buffer.from('\r\n\r\n', 'utf8'))) {
        socket.end('HTTP/1.1 201 Created\r\nContent-Length: 3\r\n\r\nTLS');
      }
    });

    try {
      const artifactDir = path.join(tempDir, 'artifacts');
      const { scriptPath, inputPath } = await writeHelperInput(tempDir, {
        id: 'raw-tls',
        target: {
          url: `https://127.0.0.1:${server.port}/`,
          host: '127.0.0.1',
          port: server.port,
          tls: true,
          server_name: 'localhost',
          insecure: true,
        },
        artifact_dir: artifactDir,
        requests: [{ base64: requestBytes.toString('base64') }],
        read_strategy: 'after_each',
        timeout_sec: 5,
        read_idle_timeout_ms: 100,
        max_response_bytes: 20_000,
      });

      const { stdout } = await execFileAsync(python, [scriptPath, inputPath], {
        timeout: 10_000,
        windowsHide: true,
      });
      const result = parseHelperResult(String(stdout));

      expect(result.ok).toBe(true);
      expect(result.status_code).toBe(201);
      expect(server.connections()).toBe(1);
      expect(server.received()).toEqual(requestBytes);
      expect(server.received().toString('utf8')).not.toMatch(/^Host:/im);
    } finally {
      await server.close();
    }
  });
});

describe('executeRawHttpSend', () => {
  it('blocks private targets in cloud sessions before writing helper artifacts', async () => {
    const writeFile = vi.fn();
    const exec = vi.fn();
    const session = {
      id: 'session-raw-cloud',
      workspaceDir: 'C:/tmp/nullai-test',
      flags: {
        securityops: {
          executionTarget: 'cloud',
        },
      },
    };
    const ctx = {
      sessionId: session.id,
      workspaceDir: session.workspaceDir,
      sessionStore: { get: () => session },
      sandbox: { writeFile, exec },
      abortSignal: new AbortController().signal,
    } as unknown as ToolContext;

    const result = await executeRawHttpSend(
      {
        url: 'http://127.0.0.1/admin',
        raw_request: 'GET /admin HTTP/1.1\r\n\r\n',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.data).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('Cloud execution cannot target private or reserved network addresses'),
      }),
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
