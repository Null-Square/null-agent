const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isNetworkRequestInScope,
  normalizeScopePolicy,
} = require('../src/browserSessionManager');

const policy = normalizeScopePolicy({
  rulesDigest: 'a'.repeat(64),
  roots: [
    { type: 'domain', value: 'example.com' },
    { type: 'cidr', value: '10.10.0.0/16' },
  ],
  exclusions: [
    { type: 'domain', value: 'billing.example.com' },
    { type: 'cidr', value: '10.10.5.0/24' },
  ],
});

test('remote browser policy includes the verified apex and descendants downward only', () => {
  assert.equal(isNetworkRequestInScope('https://example.com/', policy), true);
  assert.equal(isNetworkRequestInScope('https://api.example.com/v1', policy), true);
  assert.equal(isNetworkRequestInScope('https://example.com.attacker.test/', policy), false);
  assert.equal(isNetworkRequestInScope('https://attacker.test/', policy), false);
});

test('remote browser policy makes domain and CIDR exclusions win', () => {
  assert.equal(isNetworkRequestInScope('https://billing.example.com/', policy), false);
  assert.equal(isNetworkRequestInScope('https://child.billing.example.com/', policy), false);
  assert.equal(isNetworkRequestInScope('http://10.10.4.8/', policy), true);
  assert.equal(isNetworkRequestInScope('http://10.10.5.8/', policy), false);
  assert.equal(isNetworkRequestInScope('http://10.11.0.1/', policy), false);
});

test('remote browser policy permits browser-local URLs but fails closed without a network policy', () => {
  assert.equal(isNetworkRequestInScope('data:text/plain,ok', null), true);
  assert.equal(isNetworkRequestInScope('blob:https://example.com/id', null), true);
  assert.equal(isNetworkRequestInScope('https://example.com/', null), false);
  assert.equal(normalizeScopePolicy({ rulesDigest: 'x', roots: [] }), null);
});
