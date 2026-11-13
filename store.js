'use strict';
const fs = require('fs');
const path = require('path');
const log = require('./log');

const FILE = path.join(__dirname, 'data', 'store.json');
let coll = null;
let mode = 'file';

async function init() {
  if (!process.env.MONGODB_URI) { log.warn('MONGODB_URI not set: using a local file. On Render free the file is wiped on redeploy.'); return; }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    coll = client.db(process.env.MONGODB_DB || 'merou_widget').collection('state');
    mode = 'mongodb';
    log.info('Storage: MongoDB connected.');
  } catch (e) {
    coll = null;
    log.warn(`MongoDB unavailable (${e.message}). Falling back to a local file.`);
  }
}

async function load() {
  try {
    if (coll) { const d = await coll.findOne({ _id: 'main' }); return d ? { config: d.config, link: d.link, lastPush: d.lastPush } : {}; }
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { return {}; }
}

async function save(state) {
  const doc = { config: state.config, link: state.link, lastPush: state.lastPush };
  if (coll) { await coll.updateOne({ _id: 'main' }, { $set: doc }, { upsert: true }); return; }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2));
}

module.exports = { init, load, save, get mode() { return mode; } };
