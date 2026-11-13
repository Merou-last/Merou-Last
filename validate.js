'use strict';
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TYPES = ['string', 'number', 'media'];
const MAX_FIELDS = 30;        // Discord limit for dynamic fields
const MAX_STRING = 100;       // conservative cap for string values
const MAX_DATA_BYTES = 10000; // Discord limit is 10 KB for the data object

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
// Professional look: strip emoji from every text value.
const stripEmoji = (s) => s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s{2,}/g, ' ').trim();

function absUrl(value, publicUrl) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.startsWith('/')) return publicUrl.replace(/\/+$/, '') + v;
  return v;
}

/** Returns { config, errors } with a safe, normalized configuration. */
function sanitizeConfig(input, publicUrl) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};
  const out = { username: stripEmoji(clean(src.username, 100)) || 'Merou Last', fields: [], presets: [] };

  const seen = new Set();
  for (const f of Array.isArray(src.fields) ? src.fields : []) {
    if (out.fields.length >= MAX_FIELDS) { errors.push(`Maximum ${MAX_FIELDS} fields.`); break; }
    const key = clean(f && f.key, 64).toLowerCase();
    const type = TYPES.includes(f && f.type) ? f.type : 'string';
    if (!KEY_RE.test(key)) { errors.push(`Invalid key "${key}" (use a-z, 0-9, _ ; start with a letter).`); continue; }
    if (seen.has(key)) { errors.push(`Duplicate key "${key}".`); continue; }
    seen.add(key);
    let value;
    if (type === 'number') {
      value = Number(f.value);
      if (!Number.isFinite(value)) { errors.push(`Field "${key}" must be a number.`); continue; }
    } else if (type === 'media') {
      value = clean(f.value, 500);
      const full = absUrl(value, publicUrl);
      if (value && !/^https:\/\//i.test(full)) errors.push(`Field "${key}": image URL must be https (a public link).`);
    } else {
      value = stripEmoji(clean(f.value, MAX_STRING));
    }
    out.fields.push({ key, type, value, enabled: f.enabled !== false });
  }

  for (const p of (Array.isArray(src.presets) ? src.presets : []).slice(0, 10)) {
    const name = stripEmoji(clean(p && p.name, 40));
    if (!name) continue;
    const values = {};
    for (const [k, v] of Object.entries((p && p.values) || {})) {
      if (KEY_RE.test(k)) values[k] = typeof v === 'number' ? v : stripEmoji(clean(v, 500));
    }
    out.presets.push({ name, values });
  }
  return { config: out, errors };
}

/** Builds the exact body for the Application Identity Profile PATCH request. */
function toPayload(config, publicUrl) {
  const dynamic = [];
  for (const f of config.fields) {
    if (!f.enabled) continue;
    if (f.type === 'number') dynamic.push({ type: 2, name: f.key, value: Number(f.value) });
    else if (f.type === 'media') {
      const url = absUrl(f.value, publicUrl);
      if (url) dynamic.push({ type: 3, name: f.key, value: { url } });
    } else if (String(f.value).length >= 1) dynamic.push({ type: 1, name: f.key, value: String(f.value) });
  }
  const payload = { username: config.username, data: { dynamic } };
  const size = Buffer.byteLength(JSON.stringify(payload.data));
  if (size > MAX_DATA_BYTES) throw new Error(`Data is ${size} bytes; Discord allows up to 10 KB.`);
  return payload;
}

function applyPreset(config, presetName) {
  const preset = config.presets.find((p) => p.name === presetName);
  if (!preset) return null;
  const next = JSON.parse(JSON.stringify(config));
  for (const f of next.fields) if (f.key in preset.values) f.value = preset.values[f.key];
  return next;
}

module.exports = { sanitizeConfig, toPayload, applyPreset, absUrl, stripEmoji };
