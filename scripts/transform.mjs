import { config, localDay, localWeekdayHour, month, addDays, dayRange, daysBetween, phone10, email, rx } from './lib.mjs';

const CH = config.channels.map((c) => ({ ...c, re: rx(c.match) }));
const JT = config.job_types.map((t) => ({ ...t, re: rx(t.match) }));
const PAID = ['Google Ads', 'LSA', 'Meta'];
const LEAD_CHANNELS = [...CH.filter((c) => !c.exclude && c.name !== 'Text campaign').map((c) => c.name), 'Source not captured'];
const TYPES = [...JT.map((t) => t.name), 'Other'];
const num = (x) => (x == null || x === '' ? 0 : Number(x) || 0);
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- helpers ----------
function contactChannel(c) {
  const a = c.attributionSource || {}; const b = c.lastAttributionSource || {};
  const hay = [c.source, ...(c.tags || []), a.medium, a.utmSource, a.utmMedium, a.sessionSource, a.campaign, a.utmCampaign, a.referrer, a.gclid ? 'gclid' : '', a.fbclid ? 'facebook' : '', b.medium, b.utmSource, b.sessionSource].filter(Boolean).join(' | ').toLowerCase();
  for (const ch of CH) if (ch.re.test(hay)) return ch.name;
  return 'Source not captured';
}
const jobText = (j) => [j.job_fields?.job_type?.name, j.description, j.name, ...(j.tags || []), ...(j.line_items || []).map((l) => l.name)].filter(Boolean).join(' ');
function jobType(j) { const t = jobText(j); for (const x of JT) if (x.re.test(t)) return x.name; return 'Other'; }
const amount = (v) => num(v) / (config.hcp.amounts_in_cents ? 100 : 1);
const status = (j) => String(j.work_status || '').toLowerCase();
const isDone = (j) => /complete/.test(status(j));
const isCancel = (j) => /cancel/.test(status(j));
const doneAt = (j) => j.work_timestamps?.completed_at || j.schedule?.scheduled_end || j.updated_at || j.created_at;
function customerKeys(c = {}) {
  const ph = [c.mobile_number, c.home_number, c.work_number, c.phone].map(phone10).filter(Boolean);
  return { ph, em: email(c.email) };
}

export function transform({ hcp, ghl, win, lsaSpend, today, notes = [] }) {
  const tz = config.timezone;
  const from = config.history_start;
  const days = dayRange(from, today);
  const idx = Object.fromEntries(days.map((d, i) => [d, i]));
  const zeros = () => new Array(days.length).fill(0);
  const put = (arr, day, v = 1) => { const i = idx[day]; if (i != null) arr[i] += v; };
  const months = [...new Set(days.map(month))];

  // ======================= HCP: jobs & revenue =======================
  const jobs = (hcp.jobs || []).filter((j) => !isCancel(j));
  const byCust = new Map();
  for (const j of jobs) {
    const cid = j.customer?.id || j.customer_id; if (!cid) continue;
    if (!byCust.has(cid)) byCust.set(cid, { id: cid, jobs: [], keys: customerKeys(j.customer) });
    byCust.get(cid).jobs.push(j);
  }
  const rev = { total: zeros() }; const cnt = { total: zeros() };
  for (const t of TYPES) { rev[t] = zeros(); cnt[t] = zeros(); }
  const newCustomers = zeros();
  const firstDone = new Map();
  for (const [cid, c] of byCust) {
    const done = c.jobs.filter(isDone).map((j) => ({ j, day: localDay(doneAt(j)), type: jobType(j), amt: amount(j.total_amount) })).sort((a, b) => (a.day < b.day ? -1 : 1));
    c.done = done;
    c.created = c.jobs.map((j) => localDay(j.created_at)).filter(Boolean).sort();
    if (done.length) { firstDone.set(cid, done[0].day); put(newCustomers, done[0].day); }
    for (const d of done) { put(rev.total, d.day, d.amt); put(rev[d.type], d.day, d.amt); put(cnt.total, d.day); put(cnt[d.type], d.day); }
  }

  // repeat / pull-through / win-back
  let withJob = 0, repeat = 0, tune = 0, tuneConv = 0, tuneConvRev = 0, wb12 = 0, wb24 = 0;
  for (const c of byCust.values()) {
    if (!c.done.length) continue;
    withJob++; if (c.done.length > 1) repeat++;
    const last = c.done[c.done.length - 1].day;
    const age = daysBetween(last, today);
    if (age >= 365 && age < 730) wb12++; else if (age >= 730) wb24++;
    for (const t of c.done.filter((d) => d.type === 'Tune-up' && daysBetween(d.day, today) >= 30)) {
      tune++;
      const hit = c.done.find((d) => (d.type === 'Repair' || d.type === 'Replacement') && d.day > t.day && daysBetween(t.day, d.day) <= 120);
      if (hit) { tuneConv++; tuneConvRev += hit.amt; }
    }
  }
  const needsScheduling = (hcp.jobs || []).filter((j) => /needs scheduling|unscheduled/.test(status(j))).length;
  const schedule = dayRange(today, addDays(today, 13)).map((d) => ({ d, n: 0 }));
  const sIdx = Object.fromEntries(schedule.map((s, i) => [s.d, i]));
  for (const j of jobs) { const d = localDay(j.schedule?.scheduled_start); if (d in sIdx && !isDone(j)) schedule[sIdx[d]].n++; }

  // open estimates
  let estOpen = 0, estValue = 0, estAged = 0;
  for (const e of hcp.estimates || []) {
    const opts = e.options || [];
    const st = opts.map((o) => String(o.approval_status || o.status || '').toLowerCase());
    if (st.some((s) => /approved/.test(s)) || (st.length && st.every((s) => /declin/.test(s)))) continue;
    const created = localDay(e.created_at); if (!created || daysBetween(created, today) > 180) continue;
    estOpen++; estValue += Math.max(0, ...opts.map((o) => amount(o.total_amount)));
    if (daysBetween(created, today) > 30) estAged++;
  }

  // ======================= GHL: leads & attribution =======================
  const phoneIdx = new Map(), emailIdx = new Map();
  for (const c of byCust.values()) { for (const p of c.keys.ph) phoneIdx.set(p, c.id); if (c.keys.em) emailIdx.set(c.keys.em, c.id); }
  const leadsDaily = Object.fromEntries(LEAD_CHANNELS.map((n) => [n, zeros()]));
  const cohorts = {}; // lead month -> channel -> {leads}
  const cell = (m, ch) => ((cohorts[m] ||= {})[ch] ||= { leads: 0 });
  let existingInCrm = 0, syncExcluded = 0;
  const contactCh = new Map();
  const leadDayByContact = new Map();
  for (const c of ghl.contacts || []) {
    const ch = contactChannel(c); contactCh.set(c.id, ch);
    const leadDay = localDay(c.dateAdded || c.dateCreated);
    if (!leadDay || leadDay < from) continue;
    if (CH.find((x) => x.name === ch)?.exclude) { syncExcluded++; continue; }
    const cid = phoneIdx.get(phone10(c.phone)) || emailIdx.get(email(c.email));
    const cust = cid && byCust.get(cid);
    // existing customer who landed in the CRM: counted separately, credited to no one
    if (cust && ((cust.created[0] && cust.created[0] < leadDay) || (firstDone.get(cid) && firstDone.get(cid) < leadDay))) { existingInCrm++; continue; }
    if (ch === 'Text campaign') continue; // replies from past-customer texting are not new demand
    put(leadsDaily[ch], leadDay); leadDayByContact.set(c.id, leadDay);
    cell(month(leadDay), ch).leads++;
  }

  // ======================= HCP-first attribution =======================
  // Every completed HCP job belongs to a customer. The customer's source comes from the
  // earliest matching GHL contact that existed before their first HCP job (within a year),
  // then from the HCP lead source field, else "Source not captured". Customers whose first
  // job predates the marketing program are "Existing customers".
  const gByPhone = new Map(), gByEmail = new Map();
  const add = (m, k, c) => { if (!k) return; (m.get(k) || m.set(k, []).get(k)).push(c); };
  for (const c of ghl.contacts || []) {
    const ch = contactChannel(c); if (CH.find((x) => x.name === ch)?.exclude) continue;
    const d = localDay(c.dateAdded || c.dateCreated); if (!d) continue;
    const o = { d, ch }; add(gByPhone, phone10(c.phone), o); add(gByEmail, email(c.email), o);
    for (const p of c.additionalPhones || []) add(gByPhone, phone10(p.phone || p), o);
  }
  const hcpChannel = (src) => { if (!src) return null; for (const ch of CH) if (!ch.exclude && ch.re.test(String(src))) return ch.name; return null; };
  const SOURCES = [...LEAD_CHANNELS, 'Existing customers'];
  const revBy = Object.fromEntries(SOURCES.map((n) => [n, zeros()]));
  const newBy = Object.fromEntries(SOURCES.map((n) => [n, zeros()]));
  const custCohorts = {}; // first-job month -> source -> {customers, jobs, revenue}
  const how = { ghl_phone: 0, ghl_email: 0, hcp_field: 0, not_captured: 0, existing: 0 };
  const start = config.marketing_start || from;
  for (const c of byCust.values()) {
    if (!c.done.length) continue;
    const firstJob = [c.created[0], c.done[0].day].filter(Boolean).sort()[0];
    let src = null, via = null;
    if (c.done[0].day < start) { src = 'Existing customers'; via = 'existing'; }
    else {
      const pick = (arr) => (arr || []).filter((o) => o.d <= firstJob && daysBetween(o.d, firstJob) <= 365).sort((a, b) => (a.d < b.d ? -1 : 1))[0];
      let hit = null;
      for (const p of c.keys.ph) { const h = pick(gByPhone.get(p)); if (h && (!hit || h.d < hit.d)) { hit = h; via = 'ghl_phone'; } }
      if (!hit) { const h = pick(gByEmail.get(c.keys.em)); if (h) { hit = h; via = 'ghl_email'; } }
      if (hit && hit.ch !== 'Source not captured' && hit.ch !== 'Text campaign') src = hit.ch;
      if (!src) { const f = hcpChannel(c.jobs.map((j) => j.lead_source || j.customer?.lead_source).find(Boolean)); if (f && f !== 'Text campaign') { src = f; via = 'hcp_field'; } }
      if (!src) { src = 'Source not captured'; via = 'not_captured'; }
    }
    how[via]++;
    put(newBy[src], c.done[0].day);
    const k = ((custCohorts[month(c.done[0].day)] ||= {})[src] ||= { customers: 0, jobs: 0, revenue: 0 });
    k.customers++;
    for (const d of c.done) { put(revBy[src], d.day, d.amt); k.jobs++; k.revenue += d.amt; }
  }
  notes.push(`Attribution (HCP customers since ${start}): ${how.ghl_phone} matched to GHL by phone, ${how.ghl_email} by email, ${how.hcp_field} from the HCP lead source, ${how.not_captured} with no source; ${how.existing} existing customers.`);
  // sanity: credited customers should not exceed that channel's GHL leads over the same year
  for (const ch of PAID) {
    const custN = sum12(newBy[ch]), leadN = sum12(leadsDaily[ch]);
    if (custN > leadN * 1.1 + 2) notes.push(`Check ${ch}: ${custN} new customers credited vs ${leadN} leads in 12 months. The channel rule may be too broad.`);
  }
  function sum12(a) { return a.slice(-365).reduce((x, y) => x + y, 0); }

  // ======================= GHL: calls, response, waiting =======================
  const since = addDays(today, -config.ghl.message_window_days);
  const autoRe = rx(config.ghl.automated_sources);
  const calls = { answered: zeros(), missed: zeros(), voicemail: zeros() };
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const heatAll = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const fix = config.routing_fix_date;
  const ba = { before: { answered: 0, missed: 0, voicemail: 0 }, after: { answered: 0, missed: 0, voicemail: 0 } };
  const byContact = new Map();
  for (const m of ghl.messages || []) {
    const type = String(m.messageType || m.type || '').toUpperCase();
    const day = localDay(m.dateAdded); if (!day) continue;
    (byContact.get(m.contactId) || byContact.set(m.contactId, []).get(m.contactId)).push(m);
    if (!/CALL/.test(type) || String(m.direction).toLowerCase() !== 'inbound' || day < since) continue;
    const st = String(m.meta?.call?.status || m.status || '').toLowerCase();
    const kind = /voicemail/.test(st) ? 'voicemail' : /complete|answered/.test(st) ? 'answered' : 'missed';
    put(calls[kind], day);
    ba[day >= fix ? 'after' : 'before'][kind]++;
    const [wd, hr] = localWeekdayHour(m.dateAdded);
    heatAll[wd][hr]++; if (kind !== 'answered') heat[wd][hr]++;
  }
  // human first response for new leads in the message window
  const resp = [];
  let noReply = 0;
  for (const [cid, leadDay] of leadDayByContact) {
    if (leadDay < since) continue;
    const ms = (byContact.get(cid) || []).sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
    if (!ms.length) continue;
    const firstIn = ms.find((m) => String(m.direction).toLowerCase() === 'inbound') || ms[0];
    const t0 = new Date(firstIn.dateAdded);
    const human = ms.find((m) => new Date(m.dateAdded) >= t0 && (
      (String(m.direction).toLowerCase() === 'outbound' && !autoRe.test(String(m.source || ''))) ||
      (String(m.direction).toLowerCase() === 'inbound' && /CALL/.test(String(m.messageType || m.type).toUpperCase()) && /complete|answered/.test(String(m.meta?.call?.status || m.status).toLowerCase()))));
    if (human) resp.push((new Date(human.dateAdded) - t0) / 60000); else noReply++;
  }
  const r = resp.length ? { median: med(resp), within5: resp.filter((x) => x <= 5).length / resp.length, over60: resp.filter((x) => x > 60).length, n: resp.length, noReply } : { median: null, n: 0, noReply };

  const waiting = { total: 0, lt1: 0, d1_3: 0, d3p: 0, older: 0 };
  for (const c of ghl.conversations || []) {
    if (String(c.lastMessageDirection || '').toLowerCase() !== 'inbound') continue;
    const d = localDay(c.lastMessageDate); if (!d) continue;
    const age = daysBetween(d, today);
    if (age > 30) { waiting.older++; continue; }
    waiting.total++; if (age < 1) waiting.lt1++; else if (age <= 3) waiting.d1_3++; else waiting.d3p++;
  }
  const loc = ghl.locationId || '';

  // ======================= Windsor: spend, listings, rankings =======================
  const ex = rx(config.windsor.exclude_campaigns);
  const spend = { 'Google Ads': zeros(), Meta: zeros() };
  const clicks = { 'Google Ads': zeros(), Meta: zeros() };
  const lastSpend = {};
  const lsaRe = rx(config.windsor.exclude_google_lsa || '^ghs');
  for (const x of win.gads || []) { if (ex.test(x.campaign || '') || lsaRe.test(x.campaign || '')) continue; put(spend['Google Ads'], x.date, num(x.spend)); put(clicks['Google Ads'], x.date, num(x.clicks)); if (num(x.spend) > 0 && (!lastSpend['Google Ads'] || x.date > lastSpend['Google Ads'])) lastSpend['Google Ads'] = x.date; }
  for (const x of win.meta || []) { if (ex.test(x.campaign || '')) continue; put(spend.Meta, x.date, num(x.spend)); put(clicks.Meta, x.date, num(x.clicks)); if (num(x.spend) > 0 && (!lastSpend.Meta || x.date > lastSpend.Meta)) lastSpend.Meta = x.date; }
  const metaCamp = (win.meta || []).reduce((s, x) => s + num(x.spend), 0);
  const metaAll = (win.metaTotal || []).reduce((s, x) => s + num(x.spend), 0);
  if (metaAll && Math.abs(metaAll - metaCamp) / metaAll > 0.05) notes.push(`Meta campaign rows ($${metaCamp.toFixed(0)}) differ from account total ($${metaAll.toFixed(0)}); check campaign coverage.`);
  for (const [ch, d] of Object.entries(lastSpend)) if (config.ads_active && daysBetween(d, today) > 5) notes.push(`${ch}: no spend rows after ${d}. Confirm in the ad platform before reading as paused.`);
  const lsa = lsaSpend.months || {};
  const missingLsa = months.filter((m) => m >= '2026-04' && m < month(today) && !(m in lsa));

  const listings = config.windsor.listings.map((l) => {
    const calls = zeros(), web = zeros(), impr = zeros(), rev = zeros();
    for (const x of win.gbp?.[l.id] || []) { put(calls, x.date, num(x.call_clicks)); put(web, x.date, num(x.website_clicks)); put(impr, x.date, num(x.impressions)); }
    const seen = new Set(); const stars = [];
    for (const x of win.reviews?.[l.id] || []) {
      if (!x.review_id || seen.has(x.review_id)) continue; seen.add(x.review_id);
      put(rev, localDay(x.review_create_time));
      stars.push({ d: localDay(x.review_create_time), s: { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[x.review_star_rating] || num(x.review_star_rating) });
    }
    const t = win.totals?.[l.id];
    return { id: l.id, name: l.name, area: l.area, moved: l.moved || null, calls, web, impr, reviews: rev, total: t ? num(t.review_total_count) : seen.size, rating: t ? num(t.review_average_rating_total) : null };
  });

  // rankings: weekly avg position per non-brand query
  const brand = rx(config.windsor.brand_queries);
  const weekOf = (d) => Math.floor(daysBetween(d, today) / 7); // 0 = this week
  const q = new Map();
  for (const x of win.sc || []) {
    if (!x.query || brand.test(x.query)) continue;
    const w = weekOf(x.date); if (w < 0 || w > 11) continue;
    const o = q.get(x.query) || { query: x.query, impr: 0, clicks: 0, wk: Array.from({ length: 12 }, () => ({ p: 0, i: 0 })) };
    const i = num(x.impressions); o.impr += i; o.clicks += num(x.clicks);
    o.wk[11 - w].p += num(x.position) * Math.max(i, 1); o.wk[11 - w].i += Math.max(i, 1);
    q.set(x.query, o);
  }
  const rankings = [...q.values()].sort((a, b) => b.impr - a.impr).slice(0, 25).map((o) => {
    const series = o.wk.map((w) => (w.i ? +(w.p / w.i).toFixed(1) : null));
    const avg = (arr) => { const v = arr.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    const now = avg(series.slice(8)), before = avg(series.slice(4, 8));
    return { query: o.query, pos: now != null ? +now.toFixed(1) : null, change: now != null && before != null ? +(before - now).toFixed(1) : null, impr: o.impr, clicks: o.clicks, series };
  }).filter((x) => x.pos != null);

  const r0 = (a) => a.map((v) => Math.round(v));
  for (const k of Object.keys(rev)) rev[k] = r0(rev[k]);
  for (const k of Object.keys(spend)) spend[k] = spend[k].map((v) => +v.toFixed(2));
  for (const m of Object.values(custCohorts)) for (const c of Object.values(m)) c.revenue = Math.round(c.revenue);
  for (const k of Object.keys(revBy)) revBy[k] = r0(revBy[k]);
  if (r.median != null) r.median = +r.median.toFixed(1);
  if (r.within5 != null) r.within5 = +r.within5.toFixed(3);
  return {
    meta: { name: config.name, generated: new Date().toISOString(), today, tz, from, adsActive: config.ads_active, routingFix: fix, messageWindow: config.ghl.message_window_days, gbpLag: config.windsor.gbp_lag_days, notes, missingLsa, lastSpend },
    days, types: TYPES, channels: LEAD_CHANNELS, paid: PAID,
    daily: { rev, cnt, newCustomers, leads: leadsDaily, calls, spend, clicks, revBy, newBy },
    sources: SOURCES, marketingStart: start,
    lsa, cohorts, custCohorts, attribution: how, listings, rankings,
    snapshot: {
      waiting, link: loc ? `${config.ghl.app_base}/v2/location/${loc}/conversations/conversations` : null,
      estimates: { open: estOpen, value: Math.round(estValue), aged: estAged }, needsScheduling, schedule,
      customers: { withJob, repeat, winback12: wb12, winback24: wb24 },
      pullThrough: { tuneups: tune, converted: tuneConv, revenue: Math.round(tuneConvRev) },
      response: r, heat, heatAll, beforeAfter: ba, existingInCrm, syncExcluded,
    },
  };
}
