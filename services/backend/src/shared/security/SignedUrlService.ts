import crypto from 'crypto';

type SignedPayload = {
  p: string;
  exp: number;
};

export class SignedUrlService {
  constructor(
    private readonly secret: string,
    private readonly defaultTtlMs: number = 5 * 60 * 1000,
  ) {}

  sign(path: string, ttlMs?: number): string {
    const exp = Date.now() + (ttlMs ?? this.defaultTtlMs);
    const payload: SignedPayload = { p: path, exp };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${encoded}.${sig}`;
  }

  verify(path: string, token?: string | null): boolean {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [encoded, sig] = parts;
    const expected = crypto.createHmac('sha256', this.secret).update(encoded).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return false;
    }
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedPayload;
      if (payload.p !== path) return false;
      if (Date.now() > payload.exp) return false;
      return true;
    } catch {
      return false;
    }
  }
}
