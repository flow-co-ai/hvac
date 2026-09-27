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

// leak guard: the page carries names but never an email or phone number.
// Scrub any that slipped into a text field (a GHL contact named by its email, a source like "Call 708…").
const EMAIL = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/gi, PHONE = /\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
let scrubbed = 0;
const scrub = (v) => { if (typeof v !== 'string' || v.startsWith('http')) return v; const w = v.replace(EMAIL, '[email]').replace(PHONE, '[phone]'); if (w !== v) scrubbed++; return /^\s*\[(email|phone)\]\s*$/.test(w) ? 'Contact' : w; };
for (const list of Object.values(data.lists || {})) for (const row of list) for (const k of Object.keys(row)) row[k] = scrub(row[k]);
if (data.audit) data.audit.rawSources = data.audit.rawSources.map(([k, v]) => [scrub(k), v]);
if (scrubbed) console.log(`NOTE: removed ${scrubbed} emails or phone numbers from names and source labels`);
const json = JSON.stringify(data);
const bad = [];
json.replace(/"(\w+)":"([^"]*)"/g, (m, k, v) => { if (!v.startsWith('http') && (EMAIL.test(v) || /\b\d{10}\b/.test(v))) bad.push(k); EMAIL.lastIndex = 0; return m; });
if (bad.length) throw new Error(`Output still has an email or phone number in field(s): ${[...new Set(bad)].join(', ')}. Stopping.`);

// Counts-only summary on the run page (Actions → run → Summary). No names.
if (process.env.GITHUB_STEP_SUMMARY) {
  const a = data.audit, at = data.attribution, sn = data.snapshot;
  const lines = [
    '## Data check', '',
    `Pulled: ${a.contacts} GHL contacts, ${a.opportunities} opportunities, ${a.conversations} conversations, ${a.messages} messages (${a.callMessages} call records).`, '',
    `**Attribution of new HCP customers since ${data.marketingStart}:** phone ${at.phone}, email ${at.email}, name ${at.name}, HCP lead source ${at.hcp_field}, no source ${at.not_captured}. Existing customers: ${at.existing}.`, '',
    `**Waiting:** ${sn.waiting.total} counted, ${a.waitingSkipped} skipped as opt-outs or one-word replies, ${sn.waiting.older} older than 30 days.`, '',
    `**Open estimates:** ${sn.estimates.open} worth $${sn.estimates.value.toLocaleString()}.`, '',
    ...data.meta.notes.map((n) => `- ${n}`), '',
    '### GHL source values → channel', '', '| Source value | Contacts |', '|---|---|',
    ...a.rawSources.map(([k, v]) => `| ${String(k).replace(/\|/g, '/')} | ${v} |`),
  ];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
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
