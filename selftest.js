'use strict';
// Offline checks for the pure logic (no network, no dependencies).
const assert = require('assert');
const { sanitizeConfig, toPayload, applyPreset, stripEmoji } = require('./validate');
const auth = require('./auth');
const defaults = require('./config.default.json');

const URL = 'https://x.onrender.com';
const { config, errors } = sanitizeConfig(defaults, URL);
assert.deepStrictEqual(errors, []);
const payload = toPayload(config, URL);
assert.strictEqual(payload.data.dynamic.find((f) => f.name === 'icon_image').value.url, `${URL}/assets/mark-last.png`);
assert.strictEqual(payload.data.dynamic.find((f) => f.name === 'progress_current').type, 2);
assert.strictEqual(stripEmoji('Hello \u{1F525} world'), 'Hello world');
const bad = sanitizeConfig({ fields: [{ key: 'Bad Key', type: 'string', value: 'x' }, { key: 'a', type: 'number', value: 'zz' }] }, URL);
assert.ok(bad.errors.length >= 2);
assert.strictEqual(applyPreset(config, 'Away').fields.find((f) => f.key === 'status').value, 'Away');
const t = auth.sign({ role: 'admin', exp: Date.now() + 1000 }, 's');
assert.strictEqual(auth.verify(t, 's').role, 'admin');
assert.strictEqual(auth.verify(t, 'other'), null);
console.log('All self-tests passed.');
