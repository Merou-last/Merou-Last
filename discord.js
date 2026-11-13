'use strict';
const API = 'https://discord.com/api/v10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, opts, retries = 2) {
  const res = await fetch(url, opts);
  if (res.status === 429 && retries > 0) {
    const j = await res.json().catch(() => ({}));
    await sleep(Math.min(10, Number(j.retry_after) || 1) * 1000 + 100);
    return request(url, opts, retries - 1);
  }
  return res;
}

function hint(status, text) {
  if (status === 403) return 'Application not authorized for game stats: make sure the Widget section is enabled for this application in the Developer Portal, and that you linked your account.';
  if (status === 401) return 'Bot token rejected: check DISCORD_BOT_TOKEN.';
  if (/does not match existing identity/i.test(text)) return 'IDENTITY_ID differs from the identity already stored for your account. Use the original value.';
  if (/already exists for another user/i.test(text)) return 'This IDENTITY_ID is linked to another Discord user. Change IDENTITY_ID.';
  return '';
}

async function pushProfile({ appId, botToken, userId, identityId, payload }) {
  const url = `${API}/applications/${appId}/users/${userId}/identities/${encodeURIComponent(identityId)}/profile`;
  const res = await request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
    body: JSON.stringify(payload),
  });
  if (res.status === 201 || res.status === 204) return { ok: true, status: res.status, at: new Date().toISOString() };
  const text = (await res.text()).slice(0, 600);
  return { ok: false, status: res.status, error: text, hint: hint(res.status, text), at: new Date().toISOString() };
}

function authorizeUrl({ appId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: appId, response_type: 'code', redirect_uri: redirectUri,
    scope: 'identify application_identities.write', state, prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${q}`;
}

async function exchangeCode({ appId, secret, code, redirectUri }) {
  const res = await request(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: appId, client_secret: secret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function fetchMe(accessToken) {
  const res = await request(`${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Could not read your Discord user (${res.status}).`);
  return res.json();
}

module.exports = { pushProfile, authorizeUrl, exchangeCode, fetchMe };
