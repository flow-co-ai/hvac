import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
export const TZ = config.timezone;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export function need(name) {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`${name} is not set. Add it under GitHub → Settings → Secrets and variables → Actions.`);
  return v;
}

// fetch JSON with retries on 429/5xx; throws readable errors
export async function getJSON(url, opts = {}, label = '') {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 ? ' (the key or token is invalid)' : res.status === 403 ? ' (valid key, but missing permission or plan)' : res.status === 404 ? ' (wrong ID or path)' : '';
      throw new Error(`${label || url.split('?')[0]} → HTTP ${res.status}${hint}: ${text.slice(0, 200)}`);
    }
    try { return JSON.parse(text); } catch { throw new Error(`${label} returned non-JSON: ${text.slice(0, 120)}`); }
  }
  throw new Error(`${label || url} kept failing after retries`);
}

// ---------- dates (all bucketing in the business's timezone) ----------
const dfDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dfParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hour12: false });
export function localDay(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return dfDay.format(d); // YYYY-MM-DD
}
export function localWeekdayHour(ts) {
  const d = new Date(ts);
  const p = Object.fromEntries(dfParts.formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return [wd, Number(p.hour) % 24];
}
export const month = (day) => day && day.slice(0, 7);
export function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dayRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);

export const phone10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
export const email = (e) => (e && String(e).trim().toLowerCase()) || null;
export const rx = (s) => new RegExp(s, 'i');
