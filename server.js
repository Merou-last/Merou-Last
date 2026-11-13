'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const log = require('./log');
const store = require('./store');
const auth = require('./auth');
const discord = require('./discord');
const { sanitizeConfig, toPayload, applyPreset } = require('./validate');

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const IDENTITY_ID = process.env.IDENTITY_ID || 'merou-last';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SECURE = PUBLIC_URL.startsWith('https://');
const SECRET = process.env.SESSION_SECRET || (ADMIN_PASSWORD ? crypto.createHash('sha256').update(`merou:${ADMIN_PASSWORD}`).digest('hex') : '');

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  log.error('ADMIN_PASSWORD is missing or shorter than 8 characters. Refusing to start without protection.');
  process.exit(1);
}
['DISCORD_APP_ID', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_SECRET'].forEach((k) => { if (!process.env[k]) log.warn(`${k} is not set: pushing to Discord will not work until you add it.`); });

const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
let state = { config: null, link: null, lastPush: null };

// ------------------------------------------------------------------ helpers
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const cookie = (name, value, maxAgeSec) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE ? '; Secure' : ''}`;

const fails = new Map(); // ip -> { n, until }
function tooMany(ip) { const f = fails.get(ip); return f && f.n >= 5 && f.until > Date.now(); }
function recordFail(ip) { const f = fails.get(ip) || { n: 0, until: 0 }; f.n += 1; f.until = Date.now() + 15 * 60 * 1000; fails.set(ip, f); }

function isAuthed(req) {
  const p = auth.verify(auth.parseCookies(req).sid, SECRET);
  return Boolean(p && p.role === 'admin');
}
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'bad request' });
  next();
}

async function persist() { try { await store.save(state); } catch (e) { log.error(`Could not save state: ${e.message}`); } }

async function push() {
  const userId = state.link && state.link.userId;
  if (!APP_ID || !BOT_TOKEN) return { ok: false, error: 'DISCORD_APP_ID / DISCORD_BOT_TOKEN are not configured.' };
  if (!userId) return { ok: false, error: 'Account not linked yet. Press "Link Discord account" first.' };
  let payload;
  try { payload = toPayload(state.config, PUBLIC_URL); } catch (e) { return { ok: false, error: e.message }; }
  try {
    const result = await discord.pushProfile({ appId: APP_ID, botToken: BOT_TOKEN, userId, identityId: IDENTITY_ID, payload });
    state.lastPush = result;
    await persist();
    if (!result.ok) log.warn(`Push failed (${result.status}): ${result.error}`);
    else log.info(`Push OK (${result.status}).`);
    return result;
  } catch (e) {
    const result = { ok: false, error: `Network error: ${e.message}`, at: new Date().toISOString() };
    state.lastPush = result; await persist();
    return result;
  }
}

// ------------------------------------------------------------------ app
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => res.json({ ok: true, storage: store.mode }));
const IMG_RE = /^[\w.-]+\.(png|jpe?g|gif|webp)$/i;
app.get('/assets/:name', (req, res) => {
  const name = String(req.params.name);
  if (!IMG_RE.test(name) || !fs.existsSync(path.join(__dirname, name))) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(__dirname, name));
});
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!auth.safeEqual(req.body && req.body.password, ADMIN_PASSWORD)) { recordFail(ip); return res.status(401).json({ error: 'Wrong password.' }); }
  fails.delete(ip);
  res.set('Set-Cookie', cookie('sid', auth.sign({ role: 'admin', exp: Date.now() + SESSION_MS }, SECRET), SESSION_MS / 1000));
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.set('Set-Cookie', cookie('sid', '', 0)); res.json({ ok: true }); });

app.get('/api/state', requireAuth, (req, res) => {
  res.json({
    config: state.config, linked: Boolean(state.link && state.link.userId), userId: state.link && state.link.userId,
    lastPush: state.lastPush, storage: store.mode, publicUrl: PUBLIC_URL, identityId: IDENTITY_ID,
    ready: Boolean(APP_ID && BOT_TOKEN && CLIENT_SECRET),
  });
});

app.get('/api/assets', requireAuth, (req, res) => {
  const files = fs.readdirSync(__dirname).filter((f) => IMG_RE.test(f));
  res.json({ assets: files.map((f) => ({ name: f, path: `/assets/${f}` })) });
});

app.put('/api/config', requireAuth, async (req, res) => {
  const { config, errors } = sanitizeConfig(req.body && req.body.config, PUBLIC_URL);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  state.config = config;
  await persist();
  if (req.body && req.body.push === false) return res.json({ ok: true, config });
  res.json({ ok: true, config, push: await push() });
});

app.post('/api/preset', requireAuth, async (req, res) => {
  const next = applyPreset(state.config, String(req.body && req.body.name));
  if (!next) return res.status(404).json({ error: 'Preset not found.' });
  state.config = next;
  await persist();
  res.json({ ok: true, config: next, push: await push() });
});

app.post('/api/push', requireAuth, async (req, res) => res.json(await push()));

// ---- OAuth account linking (one time) ----
app.get('/auth', (req, res) => {
  if (!isAuthed(req)) return res.redirect('/admin');
  if (!APP_ID || !CLIENT_SECRET) return res.status(500).send('DISCORD_APP_ID / DISCORD_CLIENT_SECRET are not configured.');
  const nonce = crypto.randomBytes(16).toString('hex');
  res.set('Set-Cookie', cookie('oauth_state', nonce, 600));
  res.redirect(discord.authorizeUrl({ appId: APP_ID, redirectUri: `${PUBLIC_URL}/callback`, state: nonce }));
});

app.get('/callback', async (req, res) => {
  try {
    const saved = auth.parseCookies(req).oauth_state;
    if (!isAuthed(req) || !saved || !auth.safeEqual(saved, req.query.state || '')) return res.status(400).send('Invalid or expired link request. Go back to /admin and try again.');
    if (!req.query.code) return res.status(400).send('Authorization was cancelled.');
    const token = await discord.exchangeCode({ appId: APP_ID, secret: CLIENT_SECRET, code: String(req.query.code), redirectUri: `${PUBLIC_URL}/callback` });
    const me = await discord.fetchMe(token.access_token);
    state.link = { userId: me.id, username: me.username, at: new Date().toISOString() };
    await persist();
    log.info(`Account linked for user ${me.id}.`);
    res.set('Set-Cookie', cookie('oauth_state', '', 0));
    res.redirect('/admin?linked=1');
  } catch (e) {
    log.error(`OAuth callback failed: ${e.message}`);
    res.status(500).send(`Linking failed: ${e.message}`);
  }
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  log.error(`Request error: ${err && err.message}`);
  res.status(500).json({ error: 'Server error.' });
});

process.on('unhandledRejection', (r) => log.error(`Unhandled rejection: ${r && r.stack ? r.stack : r}`));
process.on('uncaughtException', (e) => log.error(`Uncaught exception: ${e && e.stack ? e.stack : e}`));

(async () => {
  await store.init();
  const saved = await store.load();
  const first = sanitizeConfig(saved.config || defaults, PUBLIC_URL);
  state.config = first.config;
  state.link = saved.link || (process.env.DISCORD_USER_ID ? { userId: process.env.DISCORD_USER_ID } : null);
  state.lastPush = saved.lastPush || null;
  app.listen(PORT, () => log.info(`Widget Studio running on port ${PORT} (${PUBLIC_URL}).`));
})();
