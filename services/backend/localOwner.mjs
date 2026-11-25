import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { isIP } from "node:net";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";

const derive = promisify(scrypt);
const sessionLifetime = 12 * 60 * 60 * 1000;
const minimumPasswordLength = 8;
const cookieName = 'nullsquare_local_owner';
const cookieAttributes = 'Path=/; HttpOnly; SameSite=Strict';
const hashToken = token => createHash('sha256').update(token).digest('hex');
const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function websiteHost(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  const input = value.trim();
  try {
    const url = new URL(input.includes('://') ? input : 'https://' + input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return isIP(host) || (host.length <= 253 && host.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))) ? host : null;
  } catch {
    return null;
  }
}

export async function jsonBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw Object.assign(new Error('Expected a JSON request.'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) {
      request.resume();
      throw Object.assign(new Error('Request is too large.'), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw Object.assign(new Error('Invalid request.'), { status: 400 });
  }
}

function isLocalAbsolutePath(value) {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) return false;
  if (process.platform === 'win32') return /^[a-z]:[\\/][^:]*$/i.test(value);
  return !value.startsWith('//');
}

export function createLocalOwner(store, { chooseFolder }) {
  const { db } = store;
  db.exec(
    'PRAGMA busy_timeout = 3000;' +
    'CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL, ' +
    'salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, company TEXT, website TEXT, setup_scope_id TEXT);' +
    'CREATE TABLE IF NOT EXISTS owner_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS scope_folders (scope_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, folder_path TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS model_registration (id INTEGER PRIMARY KEY CHECK (id = 1), host_id TEXT NOT NULL, client_id TEXT, subject TEXT);',
  );
  if (!db.prepare('PRAGMA table_info(owner)').all().some(column => column.name === 'website')) {
    db.exec('ALTER TABLE owner ADD COLUMN website TEXT');
  }
  if (!db.prepare('PRAGMA table_info(owner)').all().some(column => column.name === 'setup_scope_id')) {
    db.exec('ALTER TABLE owner ADD COLUMN setup_scope_id TEXT');
  }
  const findOwner = db.prepare('SELECT * FROM owner WHERE id = 1');
  const addOwner = db.prepare('INSERT INTO owner (id, email, salt, password_hash, created_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
  const saveWorkspace = db.prepare('UPDATE owner SET company = ?, website = ?, setup_scope_id = ? WHERE id = 1 AND website IS NULL');
  const scopeExists = db.prepare('SELECT 1 FROM projects WHERE id = ?');
  const sessionExists = db.prepare('SELECT 1 FROM owner_sessions WHERE token_hash = ? AND expires_at > ?');
  const addSession = db.prepare('INSERT INTO owner_sessions (token_hash, expires_at) VALUES (?, ?)');
  const removeSession = db.prepare('DELETE FROM owner_sessions WHERE token_hash = ?');
  const removeExpired = db.prepare('DELETE FROM owner_sessions WHERE expires_at <= ?');
  const listFolders = db.prepare('SELECT scope_id, folder_path FROM scope_folders');
  const saveFolder = db.prepare('INSERT INTO scope_folders (scope_id, folder_path) VALUES (?, ?) ON CONFLICT(scope_id) DO UPDATE SET folder_path = excluded.folder_path');
  const removeFolder = db.prepare('DELETE FROM scope_folders WHERE scope_id = ?');
  const attemptWindow = 60_000;
  let attempts = [];
  let checkingPassword = false;
  let choosingFolder = false;

  function sessionHash(request) {
    const entry = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='));
    const token = entry?.slice(cookieName.length + 1);
    return token && /^[0-9a-f]{64}$/.test(token) ? hashToken(token) : null;
  }

  function state(request) {
    const owner = findOwner.get();
    if (!owner) return { stage: 'signup' };
    const tokenHash = sessionHash(request);
    if (!tokenHash || !sessionExists.get(tokenHash, Date.now())) return { stage: 'signin' };
    return {
      stage: owner.company ? 'ready' : 'onboarding',
      owner: {
        email: owner.email, company: owner.company, website: owner.website, createdAt: owner.created_at,
        setupScopeId: owner.setup_scope_id,
        scopeFolders: Object.fromEntries(listFolders.all().map(row => [row.scope_id, row.folder_path])),
      },
    };
  }

  function startSession(response) {
    const now = Date.now();
    const token = randomBytes(32).toString('hex');
    removeExpired.run(now);
    addSession.run(hashToken(token), now + sessionLifetime);
    response.setHeader('Set-Cookie', cookieName + '=' + token + '; ' + cookieAttributes + '; Max-Age=' + sessionLifetime / 1000);
  }

  const paths = new Set(['state', 'signup', 'signin', 'company', 'signout', 'scope-folder']);
  async function handle(action, request, response, origin, json) {
    if (!paths.has(action)) return json(response, 404, {});
    if (action === 'state' && request.method === 'GET') return json(response, 200, state(request));
    if (action === 'state' || request.method !== 'POST' || request.headers.origin !== origin) {
      return json(response, 403, { error: 'This request must come from the local app.' });
    }
    if (action === 'signout') {
      const token = sessionHash(request);
      if (token) removeSession.run(token);
      response.setHeader('Set-Cookie', cookieName + '=; ' + cookieAttributes + '; Max-Age=0');
      return json(response, 200, {});
    }

    const current = state(request);
    if (action === 'scope-folder') {
      if (current.stage !== 'ready') return json(response, 401, { error: 'Sign in to change a scope folder.' });
      const { scopeId, selection } = await jsonBody(request);
      if (selection !== 'choose' && selection !== 'clear') return json(response, 400, { error: 'Choose or clear the scope folder.' });
      if (typeof scopeId !== 'string' || !scopeExists.get(scopeId)) {
        return json(response, 404, { error: 'This local scope could not be found.' });
      }
      if (choosingFolder) return json(response, 409, { error: 'Finish the open folder picker first.' });
      let directory = null;
      if (selection === 'choose') {
        choosingFolder = true;
        try {
          const selected = await chooseFolder();
          if (selected === null) return json(response, 200, { cancelled: true });
          if (isLocalAbsolutePath(selected)) {
            try {
              const resolved = await realpath(selected);
              if (isLocalAbsolutePath(resolved) && (await stat(resolved)).isDirectory()) directory = resolved;
            } catch {
              // The selected directory may have moved while the dialog was open.
            }
          }
        } finally {
          choosingFolder = false;
        }
        if (!directory) return json(response, 400, { error: 'Choose an existing local folder.' });
      }
      if (state(request).stage !== 'ready') return json(response, 401, { error: 'Sign in to change a scope folder.' });
      if (!scopeExists.get(scopeId)) return json(response, 404, { error: 'This local scope could not be found.' });
      if (directory === null) removeFolder.run(scopeId);
      else saveFolder.run(scopeId, directory);
      return json(response, 200, { folder: directory });
    }
    if (action === 'company') {
      const body = await jsonBody(request);
      const workspace = state(request);
      if (!workspace.owner) return json(response, 403, { error: 'Company setup requires the local owner.' });
      if (workspace.owner.website) return json(response, 409, { error: 'The workspace website is already set.' });
      const name = workspace.owner.company ?? (typeof body.name === 'string' ? body.name.trim() : '');
      const website = websiteHost(body.website);
      if (name.length < 3 || name.length > 120) return json(response, 400, { error: 'Enter a company name of 3 to 120 characters.' });
      if (!website) return json(response, 400, { error: 'Go back and enter a website hostname or HTTP address.' });
      const completed = store.transact(() => {
        if (findOwner.get().website) return false;
        const scope = store.create(name, 'Local workspace');
        saveWorkspace.run(name, website, scope.id);
        return true;
      });
      if (!completed) return json(response, 409, { error: 'Company setup has already finished.' });
      return json(response, 200, {});
    }

    const signingUp = action === 'signup';
    if (current.stage !== action) return json(response, 409, { error: 'The app state changed. Reload this page to continue.' });
    const body = await jsonBody(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!validEmail.test(email) || email.length > 254 || !password.length || password.length > 256) {
      return json(response, 400, { error: 'Enter a valid email address and password.' });
    }
    if (signingUp && password.length < minimumPasswordLength) {
      return json(response, 400, { error: 'Use at least ' + minimumPasswordLength + ' characters for your password.' });
    }

    const now = Date.now();
    attempts = attempts.filter(time => now - time < attemptWindow);
    if (checkingPassword || attempts.length >= 8) return json(response, 429, { error: 'Too many attempts. Try again shortly.' });
    checkingPassword = true;
    try {
      if (signingUp) {
        const salt = randomBytes(32).toString('hex');
        const digest = await derive(password, salt, 64);
        if (!addOwner.run(email, salt, digest.toString('hex'), new Date().toISOString()).changes) {
          return json(response, 409, { error: 'The local owner already exists. Open Sign in to continue.' });
        }
      } else {
        const owner = findOwner.get();
        const digest = await derive(password, owner.salt, 64);
        const passwordMatches = timingSafeEqual(digest, Buffer.from(owner.password_hash, 'hex'));
        if (!passwordMatches || owner.email !== email) {
          attempts.push(now);
          return json(response, 401, { error: 'Email or password is incorrect.' });
        }
      }
      attempts = [];
      startSession(response);
      return json(response, 200, {});
    } finally {
      checkingPassword = false;
    }
  }
  function modelRegistration() {
    let registration = db.prepare('SELECT host_id, client_id, subject FROM model_registration WHERE id=1').get();
    if (!registration) {
      db.prepare('INSERT OR IGNORE INTO model_registration(id, host_id) VALUES(1, ?)').run('urn:uuid:' + randomUUID());
      registration = db.prepare('SELECT host_id, client_id, subject FROM model_registration WHERE id=1').get();
    }
    return registration;
  }
  function saveModelRegistration(clientId, subject) {
    db.prepare('UPDATE model_registration SET client_id=?, subject=? WHERE id=1').run(clientId, subject);
  }
  return {
    handle, state, modelRegistration, saveModelRegistration,
    readySession: request => state(request).stage === 'ready' ? sessionHash(request) : null,
    sessionActive: session => Boolean(session && sessionExists.get(session, Date.now())),
  };
}
