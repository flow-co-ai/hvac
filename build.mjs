// Pull → transform → encrypt → public/data.enc.json
// Preview with fake data: FIXTURE=1 NO_ENCRYPT=1 node scripts/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { ROOT, localDay, addDays, config } from './lib.mjs';
import { transform } from './transform.mjs';

const today = localDay(Date.now());
const lsaSpend = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/lsa-spend.json'), 'utf8'));
let raw, notes = [];

if (process.env.FIXTURE) {
  const { makeFixture } = await import('./fixture.mjs');
  raw = makeFixture(today);
  Object.assign(lsaSpend.months, raw.lsa);
} else {
  const { pullHCP, pullGHL, pullWindsor, sourceNotes } = await import('./sources.mjs');
  console.log('Pulling Housecall Pro…'); const hcp = await pullHCP();
  console.log(`  ${hcp.jobs.length} jobs, ${hcp.estimates.length} estimates`);
  console.log('Pulling GoHighLevel…'); const ghl = await pullGHL(today);
  console.log(`  ${ghl.contacts.length} contacts, ${ghl.conversations.length} conversations, ${ghl.messages.length} messages`);
  console.log('Pulling Windsor…'); const win = await pullWindsor(config.history_start, today);
  raw = { hcp, ghl, win }; notes = sourceNotes;
}

const data = transform({ ...raw, lsaSpend, today, notes });
for (const n of data.meta.notes) console.log('NOTE:', n);
if (data.meta.missingLsa.length) console.log('NOTE: LSA spend missing for', data.meta.missingLsa.join(', '));

// leak guard: the page carries totals only
const json = JSON.stringify(data);
if (/@[a-z0-9-]+\.[a-z]{2,}/i.test(json) || /\b\d{10}\b/.test(json.replace(/"(generated|today)":"[^"]*"/g, ''))) {
  throw new Error('Output looks like it contains an email or phone number. Stopping.');
}

const out = path.join(ROOT, 'public');
if (process.env.NO_ENCRYPT) {
  fs.writeFileSync(path.join(out, 'data.json'), json);
  console.log('Wrote public/data.json (unencrypted preview)');
} else {
  const pass = (process.env.DASHBOARD_KEY || '').trim();
  if (!pass) throw new Error('DASHBOARD_KEY is not set.');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pass, salt, 200000, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(zlib.gzipSync(json)), c.final(), c.getAuthTag()]);
  fs.writeFileSync(path.join(out, 'data.enc.json'), JSON.stringify({ v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') }));
  try { fs.unlinkSync(path.join(out, 'data.json')); } catch {}
  console.log(`Wrote public/data.enc.json (${(ct.length / 1024).toFixed(0)} KB)`);
}
