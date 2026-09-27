import { config, localDay, localWeekdayHour, month, addDays, dayRange, daysBetween, phone10, email, rx } from './lib.mjs';

const CH = config.channels.map((c) => ({ ...c, re: rx(c.match) }));
const JT = config.job_types.map((t) => ({ ...t, re: rx(t.match) }));
const PAID = ['Google Ads', 'LSA', 'Meta'];
const LEAD_CHANNELS = [...CH.filter((c) => !c.exclude && c.name !== 'Text campaign').map((c) => c.name), 'Source not captured'];
const TYPES = [...JT.map((t) => t.name), 'Other'];
const num = (x) => (x == null || x === '' ? 0 : Number(x) || 0);
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- helpers ----------
function rawSource(c) {
  const a = c.attributionSource || {};
  return c.source || (c._oppSources || [])[0] || a.utmSource || a.medium || a.sessionSource || (c.tags || []).slice(0, 3).join(', ') || '(blank)';
}
// Channel comes from where the contact originated: its own source field first, then the
// pipeline opportunity and ad-click attribution. Tags and custom fields are only a fallback,
// and a tag can never mark a contact as a sync record (the HCP sync tags real leads after they book).
function contactChannel(c) {
  const a = c.attributionSource || {}; const b = c.lastAttributionSource || {};
  const primary = [c.source, ...(c._oppSources || []), a.medium, a.utmSource, a.utmMedium, a.sessionSource, a.campaign, a.utmCampaign, a.gclid ? 'gclid' : '', a.fbclid ? 'facebook' : '', b.medium, b.utmSource, b.sessionSource].filter(Boolean);
  for (const v of primary) { const t = String(v).toLowerCase(); for (const ch of CH) if (ch.re.test(t)) return ch.name; }
  const cf = (c.customFields || c.customField || []).map((f) => f.value ?? f.field_value).filter((v) => typeof v === 'string' && v.length <= 40);
  const hay = [...(c.tags || []), ...cf].join(' | ').toLowerCase();
  for (const ch of CH) if (!ch.exclude && ch.re.test(hay)) return ch.name;
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
  return { ph, em: email(c.email), nm: nameKey(c.first_name, c.last_name) };
}
const nameKey = (f, l) => { const k = `${f || ''} ${l || ''}`.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); return k.includes(' ') ? k : null; };
const hcpName = (c = {}) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || 'Customer';
const ghlName = (c = {}) => c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.companyName || 'Contact';
const HCP = 'https://pro.housecallpro.com/app';
export const HCP_BASE = HCP;
// link templates come from config so they can match the account's real web addresses
const hcpLink = (kind, id) => { const tpl = config.hcp.links?.[kind]; return tpl && id ? tpl.replace('{id}', encodeURIComponent(id)) : null; };

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
    if (!byCust.has(cid)) byCust.set(cid, { id: cid, jobs: [], keys: customerKeys(j.customer), name: hcpName(j.customer) });
    byCust.get(cid).jobs.push(j);
  }
  const custRec = new Map((hcp.customers || []).map((c) => [c.id, c]));
  for (const c of byCust.values()) {
    const full = custRec.get(c.id); if (!full) continue;
    const k = customerKeys(full);
    c.keys = { ph: [...new Set([...c.keys.ph, ...k.ph])], em: c.keys.em || k.em, nm: c.keys.nm || k.nm };
    if (c.name === 'Customer') c.name = hcpName(full);
    c.leadSource = full.lead_source || null;
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
  const winList = [];
  let withJob = 0, repeat = 0, tune = 0, tuneConv = 0, tuneConvRev = 0, wb12 = 0, wb24 = 0;
  for (const c of byCust.values()) {
    if (!c.done.length) continue;
    withJob++; if (c.done.length > 1) repeat++;
    const last = c.done[c.done.length - 1].day;
    const age = daysBetween(last, today);
    if (age >= 365 && age < 730) wb12++; else if (age >= 730) wb24++;
    if (age >= 365) winList.push({ n: c.name, last: last, ltv: Math.round(c.done.reduce((x, d) => x + d.amt, 0)), jobs: c.done.length, h: hcpLink('customer', c.id) });
    for (const t of c.done.filter((d) => d.type === 'Tune-up' && daysBetween(d.day, today) >= 30)) {
      tune++;
      const hit = c.done.find((d) => (d.type === 'Repair' || d.type === 'Replacement') && d.day > t.day && daysBetween(t.day, d.day) <= 120);
      if (hit) { tuneConv++; tuneConvRev += hit.amt; }
    }
  }
  
  const schedule = dayRange(today, addDays(today, 13)).map((d) => ({ d, n: 0 }));
  const sIdx = Object.fromEntries(schedule.map((s, i) => [s.d, i]));
  for (const j of jobs) { const d = localDay(j.schedule?.scheduled_start); if (d in sIdx && !isDone(j)) schedule[sIdx[d]].n++; }

  // open estimates
  // open estimate: sent in the last 90 days, no option approved or declined, not cancelled,
  // and no job booked for that customer after it (a booked job means it was won another way)
  let estOpen = 0, estValue = 0, estAged = 0; const estList = [];
  for (const e of hcp.estimates || []) {
    const opts = e.options || [];
    const st = opts.map((o) => String(o.approval_status || o.status || '').toLowerCase());
    if (/cancel|complete|lost|archiv|declin/.test(String(e.work_status || e.status || '').toLowerCase())) continue;
    if (st.some((x) => /approved|declin|expired/.test(x))) continue;
    const created = localDay(e.created_at); if (!created || daysBetween(created, today) > 90) continue;
    const cid = e.customer?.id || e.customer_id; const cust = cid && byCust.get(cid);
    if (cust && cust.created.some((d) => d > created)) continue;
    const v = Math.max(0, ...opts.map((o) => amount(o.total_amount)));
    estOpen++; estValue += v; if (daysBetween(created, today) > 30) estAged++;
    estList.push({ n: cust?.name || hcpName(e.customer), d: created, v: Math.round(v), u: hcpLink('estimate', e.id) });
  }
  estList.sort((a, b) => b.v - a.v);
  const unsched = (hcp.jobs || []).filter((j) => /needs scheduling|unscheduled/.test(status(j)) && daysBetween(localDay(j.created_at) || today, today) <= 120)
    .map((j) => ({ n: hcpName(j.customer), d: localDay(j.created_at), t: jobType(j), u: hcpLink('job', j.id) })).sort((a, b) => (a.d < b.d ? 1 : -1));

  // ======================= GHL: leads & attribution =======================
  const phoneIdx = new Map(), emailIdx = new Map();
  for (const c of byCust.values()) { for (const p of c.keys.ph) phoneIdx.set(p, c.id); if (c.keys.em) emailIdx.set(c.keys.em, c.id); }
  const leadsDaily = Object.fromEntries(LEAD_CHANNELS.map((n) => [n, zeros()]));
  const cohorts = {}; // lead month -> channel -> {leads}
  const cell = (m, ch) => ((cohorts[m] ||= {})[ch] ||= { leads: 0 });
  const opp = new Map();
  for (const o of ghl.opportunities || []) { const k = o.contactId || o.contact?.id; if (k && o.source) (opp.get(k) || opp.set(k, []).get(k)).push(o.source); }
  for (const c of ghl.contacts || []) c._oppSources = opp.get(c.id) || [];
  const leadList = [];
  const gLink = (id) => (ghl.locationId && id ? `${config.ghl.app_base}/v2/location/${ghl.locationId}/contacts/detail/${id}` : null);
  const leadHeat = Array.from({ length: 7 }, () => new Array(24).fill(0));
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
    if (daysBetween(leadDay, today) <= 90) { const [wd, hr] = localWeekdayHour(c.dateAdded || c.dateCreated); leadHeat[wd][hr]++; }
    if (daysBetween(leadDay, today) <= 400) leadList.push({ n: ghlName(c), d: leadDay, ch, raw: rawSource(c).slice(0, 40), g: gLink(c.id), h: cust ? hcpLink('customer', cust.id) : null, b: !!(cust && cust.created.some((d) => d >= leadDay)) });
    cell(month(leadDay), ch).leads++;
  }

  // ======================= HCP-first attribution =======================
  // Every completed HCP job belongs to a customer. The customer's source comes from the
  // earliest matching GHL contact that existed before their first HCP job (within a year),
  // then from the HCP lead source field, else "Source not captured". Customers whose first
  // job predates the marketing program are "Existing customers".
  const gByPhone = new Map(), gByEmail = new Map(), gByName = new Map();
  const add = (m, k, c) => { if (!k) return; (m.get(k) || m.set(k, []).get(k)).push(c); };
  const rawCount = new Map();
  for (const c of ghl.contacts || []) {
    const ch = contactChannel(c);
    const d = localDay(c.dateAdded || c.dateCreated); if (!d) continue;
    const raw = rawSource(c).slice(0, 40); rawCount.set(raw, (rawCount.get(raw) || 0) + 1);
    const o = { d, ch, raw, id: c.id, n: ghlName(c) };
    add(gByPhone, phone10(c.phone), o); add(gByEmail, email(c.email), o); add(gByName, nameKey(c.firstName, c.lastName) || nameKey(...String(c.contactName || '').split(' ')), o);
    for (const p of c.additionalPhones || []) add(gByPhone, phone10(p.phone || p), o);
  }
  // names only count when they point to exactly one HCP customer
  const hcpNameCount = new Map(); for (const c of byCust.values()) if (c.keys.nm) hcpNameCount.set(c.keys.nm, (hcpNameCount.get(c.keys.nm) || 0) + 1);
  const hcpChannel = (src) => { if (!src) return null; for (const ch of CH) if (!ch.exclude && ch.re.test(String(src))) return ch.name; return null; };
  const SOURCES = [...LEAD_CHANNELS, 'Existing customers'];
  const revBy = Object.fromEntries(SOURCES.map((n) => [n, zeros()]));
  const newBy = Object.fromEntries(SOURCES.map((n) => [n, zeros()]));
  const custCohorts = {}; // first-job month -> source -> {customers, jobs, revenue}
  const how = { phone: 0, email: 0, name: 0, hcp_field: 0, not_captured: 0, existing: 0, imported: 0 };
  const match = { phone: 0, email: 0, name: 0, none: 0, withGhlSource: 0 };
  const diag = { overlap: 0, lateOnly: 0 };
  const credited = [];
  const start = config.marketing_start || from;
  for (const c of byCust.values()) {
    if (!c.done.length) continue;
    const firstJob = [c.created[0], c.done[0].day].filter(Boolean).sort()[0];
    let src = null, via = null, hit = null, cands = [];
    if (c.done[0].day < start) { src = 'Existing customers'; via = 'existing'; }
    else {
      const ok = (o) => o.d <= firstJob && daysBetween(o.d, firstJob) <= 365;
      cands = [];
      for (const p of c.keys.ph) for (const o of gByPhone.get(p) || []) if (ok(o)) cands.push([o, 'phone']);
      for (const o of gByEmail.get(c.keys.em) || []) if (ok(o)) cands.push([o, 'email']);
      if (c.keys.nm && hcpNameCount.get(c.keys.nm) === 1) { const g = (gByName.get(c.keys.nm) || []).filter(ok); if (g.length && new Set(g.map((o) => o.id)).size === 1) cands.push([g[0], 'name']); }
      // prefer a contact with a real source, then the earliest
      const credits = (o) => o.ch !== 'Source not captured' && o.ch !== 'Text campaign' && !CH.find((x) => x.name === o.ch)?.exclude;
      cands.sort((a, b) => (credits(b[0]) - credits(a[0])) || (a[0].d < b[0].d ? -1 : 1));
      if (cands.length) { [hit, via] = cands[0]; if (credits(hit)) src = hit.ch; else if (cands.some(([o]) => o.ch === 'Imported list')) { src = 'Existing customers'; via = 'imported'; } }
      if (!src) { const f = hcpChannel(c.leadSource || c.jobs.map((j) => j.lead_source || j.customer?.lead_source).find(Boolean)); if (f && f !== 'Text campaign') { src = f; via = 'hcp_field'; } }
      if (!src) { src = 'Source not captured'; via = hit ? via : 'not_captured'; }
    }
    how[src === 'Source not captured' ? 'not_captured' : via]++;
    if (src !== 'Existing customers') { const any = c.keys.ph.some((p) => gByPhone.has(p)) || (c.keys.em && gByEmail.has(c.keys.em)); if (any) diag.overlap++; if (any && !cands.length) diag.lateOnly++; }
    if (src !== 'Existing customers') { match[cands.length ? cands[0][1] : 'none']++; if (hit && src === hit.ch && via !== 'hcp_field' && src !== 'Source not captured') match.withGhlSource++; }
    put(newBy[src], c.done[0].day);
    const k = ((custCohorts[month(c.done[0].day)] ||= {})[src] ||= { customers: 0, jobs: 0, revenue: 0 });
    k.customers++;
    let total = 0;
    for (const d of c.done) { put(revBy[src], d.day, d.amt); k.jobs++; k.revenue += d.amt; total += d.amt; }
    if (src !== 'Existing customers') credited.push({ n: c.name, src, via, raw: hit?.raw || null, lead: hit?.d || null, first: c.done[0].day, jobs: c.done.length, rev: Math.round(total), h: hcpLink('customer', c.id), g: hit ? gLink(hit.id) : null });
  }
  credited.sort((a, b) => (a.first < b.first ? 1 : -1));
  const hcpWith = { phone: 0, email: 0, name: 0 }; for (const c of byCust.values()) { if (c.keys.ph.length) hcpWith.phone++; if (c.keys.em) hcpWith.email++; if (c.keys.nm) hcpWith.name++; }
  const ghlWith = { phone: 0, email: 0 }; for (const c of ghl.contacts || []) { if (phone10(c.phone)) ghlWith.phone++; if (email(c.email)) ghlWith.email++; }
  { const pd = { leads: 0, inHcp: 0, before: 0, after: 0 };
    for (const c of ghl.contacts || []) { const ch = contactChannel(c); if (!PAID.includes(ch)) continue; const d = localDay(c.dateAdded); if (!d || d < start) continue; pd.leads++;
      const cid = phoneIdx.get(phone10(c.phone)) || emailIdx.get(email(c.email)); const cu = cid && byCust.get(cid); if (!cu) continue; pd.inHcp++;
      const fj = [cu.created[0], cu.done[0]?.day].filter(Boolean).sort()[0]; if (fj && fj < d) pd.before++; else pd.after++; }
    // also look in the full HCP customer list, which includes people with only an estimate or no job
    const allPh = new Set(), allEm = new Set(); for (const c of hcp.customers || []) { const k = customerKeys(c); k.ph.forEach((p) => allPh.add(p)); if (k.em) allEm.add(k.em); }
    let anyRec = 0; for (const c of ghl.contacts || []) { if (!PAID.includes(contactChannel(c))) continue; const d = localDay(c.dateAdded); if (!d || d < start) continue; if (allPh.has(phone10(c.phone)) || (email(c.email) && allEm.has(email(c.email)))) anyRec++; }
    notes.push(`Paid leads with any Housecall Pro customer record (including estimate-only): ${anyRec} of ${pd.leads}.`);
    notes.push(`Paid leads since ${start}: ${pd.leads}. Found in HCP: ${pd.inHcp} (${pd.before} were already customers before the lead, ${pd.after} became customers after).`); }
  notes.push(`Imported-list customers (old customer file, now counted as existing): ${how.imported}.`);
  notes.push(`Phone or email shared with a GHL contact: ${diag.overlap} new customers; ${diag.lateOnly} of them only have GHL contacts created after their first job (not credited).`);
  notes.push(`Matching: ${match.phone + match.email + match.name} of ${match.phone + match.email + match.name + match.none} new customers found in GHL (phone ${match.phone}, email ${match.email}, name ${match.name}); ${match.withGhlSource} of those had a source in GHL. HCP customers with phone ${hcpWith.phone}, email ${hcpWith.email}, of ${byCust.size}. GHL contacts with phone ${ghlWith.phone}, email ${ghlWith.email}, of ${(ghl.contacts || []).length}.`);
  notes.push(`Attribution (HCP customers since ${start}): matched to GHL by phone ${how.phone}, email ${how.email}, name ${how.name}; from the HCP lead source ${how.hcp_field}; no source ${how.not_captured}; existing customers ${how.existing}.`);
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
  const byContact = new Map(); const missList = [];
  const nameById = new Map((ghl.contacts || []).map((c) => [c.id, ghlName(c)]));
  let callMsgs = 0;
  for (const m of ghl.messages || []) {
    const type = String(m.messageType || m.type || '').toUpperCase();
    const day = localDay(m.dateAdded); if (!day) continue;
    (byContact.get(m.contactId) || byContact.set(m.contactId, []).get(m.contactId)).push(m);
    if (/CALL/.test(type)) callMsgs++;
    if (!/CALL/.test(type) || String(m.direction).toLowerCase() !== 'inbound' || day < since) continue;
    const st = String(m.meta?.call?.status || m.status || '').toLowerCase();
    const kind = /voicemail/.test(st) ? 'voicemail' : /complete|answered/.test(st) ? 'answered' : 'missed';
    put(calls[kind], day);
    ba[day >= fix ? 'after' : 'before'][kind]++;
    const [wd, hr] = localWeekdayHour(m.dateAdded);
    heatAll[wd][hr]++; if (kind !== 'answered') { heat[wd][hr]++; missList.push({ n: nameById.get(m.contactId) || 'Caller', t: m.dateAdded, k: kind, u: gLink(m.contactId) }); }
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
  // what happened to each paid lead in the message window
  const OUT = ['Booked a job', 'In Housecall Pro, no job', 'Answered, not booked', 'Missed, followed up, not booked', 'Missed, never followed up', 'No call, replied to', 'No call, no reply'];
  const hcpPh = new Set(), hcpEm = new Set(); for (const c of [...(hcp.customers || []), ...[...byCust.values()].map((x) => ({ mobile_number: x.keys.ph[0], email: x.keys.em }))]) { const k = customerKeys(c); k.ph.forEach((p) => hcpPh.add(p)); if (k.em) hcpEm.add(k.em); }
  const outcome = {}; const outList = [];
  for (const c of ghl.contacts || []) {
    const ch = contactChannel(c); if (!PAID.includes(ch)) continue;
    const ld = localDay(c.dateAdded || c.dateCreated); if (!ld || ld < since) continue;
    const cid = phoneIdx.get(phone10(c.phone)) || emailIdx.get(email(c.email)); const cust = cid && byCust.get(cid);
    const ms = (byContact.get(c.id) || []).sort((x, y) => new Date(x.dateAdded) - new Date(y.dateAdded));
    const isCall = (m) => /CALL/.test(String(m.messageType || m.type).toUpperCase());
    const inb = ms.filter((m) => String(m.direction).toLowerCase() === 'inbound' && isCall(m));
    const answered = inb.some((m) => /complete|answered/.test(String(m.meta?.call?.status || m.status).toLowerCase()));
    const human = ms.some((m) => String(m.direction).toLowerCase() === 'outbound' && (isCall(m) || !autoRe.test(String(m.source || ''))));
    let k;
    if (cust && cust.created.some((d) => d >= ld)) k = OUT[0];
    else if (hcpPh.has(phone10(c.phone)) || (email(c.email) && hcpEm.has(email(c.email)))) k = OUT[1];
    else if (inb.length) k = answered ? OUT[2] : human ? OUT[3] : OUT[4];
    else k = human ? OUT[5] : OUT[6];
    (outcome[ch] ||= Object.fromEntries(OUT.map((o) => [o, 0])))[k]++;
    outList.push({ n: ghlName(c), ch, d: ld, k, g: gLink(c.id), h: cust ? hcpLink('customer', cust.id) : null });
  }
  const leadOutcomes = { cats: OUT, since, byCh: outcome };
  { const tot = Object.fromEntries(OUT.map((o) => [o, 0])); for (const v of Object.values(outcome)) for (const o of OUT) tot[o] += v[o];
    notes.push(`Paid leads in the last ${config.ghl.message_window_days} days: ${OUT.map((o) => `${o} ${tot[o]}`).join(', ')}.`); }
  const r = resp.length ? { median: med(resp), within5: resp.filter((x) => x <= 5).length / resp.length, over60: resp.filter((x) => x > 60).length, n: resp.length, noReply } : { median: null, n: 0, noReply };

  // waiting: last message came from the customer in the last 30 days and needs an answer.
  // Opt-outs and one-word acknowledgements to texting campaigns don't count.
  const waiting = { total: 0, lt1: 0, d1_3: 0, d3p: 0, older: 0, skipped: 0 }; const waitList = [];
  const ackOnly = /^\s*(stop\w*|unsubscribe|end|quit|cancel|thanks?( you)?|thx|ty|ok(ay)?|k|yes|no|got it|sounds good|perfect|great|👍|🙏|❤️)[\s.!]*$/i;
  const typeLabel = (t) => { t = String(t || '').toUpperCase(); return /CALL/.test(t) ? 'Missed call' : /SMS|TEXT/.test(t) ? 'Text' : /EMAIL/.test(t) ? 'Email' : /FB|FACEBOOK|IG|INSTAGRAM/.test(t) ? 'Social message' : /GMB|GOOGLE/.test(t) ? 'Google message' : /FORM|WEBCHAT|LIVE/.test(t) ? 'Web chat or form' : 'Message'; };
  for (const c of ghl.conversations || []) {
    if (String(c.lastMessageDirection || '').toLowerCase() !== 'inbound') continue;
    const d = localDay(c.lastMessageDate); if (!d) continue;
    const age = daysBetween(d, today);
    if (age > 30) { waiting.older++; continue; }
    if (!/CALL/i.test(String(c.lastMessageType || '')) && ackOnly.test(String(c.lastMessageBody || ''))) { waiting.skipped++; continue; }
    waiting.total++; if (age < 1) waiting.lt1++; else if (age <= 3) waiting.d1_3++; else waiting.d3p++;
    waitList.push({ n: c.fullName || c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Contact', d, age, t: typeLabel(c.lastMessageType), u: ghl.locationId ? `${config.ghl.app_base}/v2/location/${ghl.locationId}/conversations/conversations/${c.id}` : null });
  }
  waitList.sort((a, b) => b.age - a.age);
  const loc = ghl.locationId || '';

  // ======================= Windsor: spend, listings, rankings =======================
  const ex = rx(config.windsor.exclude_campaigns);
  const spend = { 'Google Ads': zeros(), Meta: zeros() };
  const clicks = { 'Google Ads': zeros(), Meta: zeros() };
  const lastSpend = {};
  const lsaRe = rx(config.windsor.exclude_google_lsa || 'localservices');
  const lsaWin = {}, lsaLeads = {};
  for (const x of win.gads || []) { if (lsaRe.test(x.campaign || '')) { const m = month(x.date); lsaWin[m] = (lsaWin[m] || 0) + num(x.spend); lsaLeads[m] = (lsaLeads[m] || 0) + num(x.conversions); continue; } if (ex.test(x.campaign || '')) continue; put(spend['Google Ads'], x.date, num(x.spend)); put(clicks['Google Ads'], x.date, num(x.clicks)); if (num(x.spend) > 0 && (!lastSpend['Google Ads'] || x.date > lastSpend['Google Ads'])) lastSpend['Google Ads'] = x.date; }
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
  const rankEx = rx(config.windsor.rank_exclude || '$^');
  const weekOf = (d) => Math.floor(daysBetween(d, today) / 7); // 0 = this week
  const q = new Map();
  for (const x of win.sc || []) {
    if (!x.query || brand.test(x.query) || rankEx.test(x.query)) continue;
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


  // ======================= website (Search Console, per site) =======================
  const townRe = rx(config.windsor.towns || '$^'), topics = (config.windsor.topics || []).map(([n, m]) => [n, rx(m)]);
  const sites = (config.windsor.sites || []).map((st) => {
    const src = win.sites?.[st.id];
    if (!src) return { name: st.name, pending: !!st.pending };
    const clicks = zeros(), impr = zeros(), posW = zeros();
    for (const x of src.totals || []) { put(clicks, x.date, num(x.clicks)); put(impr, x.date, num(x.impressions)); put(posW, x.date, num(x.position) * num(x.impressions)); }
    // last 28 days vs the 28 before, by topic and by town (non-brand, service-area queries only)
    const cut1 = addDays(today, -28), cut0 = addDays(today, -56);
    const agg = () => ({ i: 0, c: 0, pw: 0, pi: 0, ppw: 0, ppi: 0 });
    const byTopic = {}, byTown = {}, qAgg = new Map(); let brandC = 0, brandI = 0, nbC = 0, nbI = 0;
    for (const x of src.queries || []) {
      const q = String(x.query || '').toLowerCase(); if (!q || !x.date || x.date < cut0) continue;
      if (rankEx.test(q)) continue;
      const i = num(x.impressions), c = num(x.clicks), p = num(x.position), cur = x.date >= cut1;
      if (brand.test(q)) { if (cur) { brandC += c; brandI += i; } continue; }
      if (cur) { nbC += c; nbI += i; }
      const add = (o) => { if (cur) { o.i += i; o.c += c; o.pw += p * i; o.pi += i; } else { o.ppw += p * i; o.ppi += i; } };
      const tp = (topics.find(([, re]) => re.test(q)) || ['Other'])[0]; add(byTopic[tp] ||= agg());
      const tm = q.match(townRe); if (tm) add(byTown[tm[0].replace(/\b\w/g, (m) => m.toUpperCase())] ||= agg());
      if (cur) { const o = qAgg.get(q) || { q, i: 0, c: 0, pw: 0 }; o.i += i; o.c += c; o.pw += p * i; qAgg.set(q, o); }
    }
    const fin = (o) => ({ impr: o.i, clicks: o.c, pos: o.pi ? +(o.pw / o.pi).toFixed(1) : null, prev: o.ppi ? +(o.ppw / o.ppi).toFixed(1) : null });
    const striking = [...qAgg.values()].map((o) => ({ q: o.q, impr: o.i, clicks: o.c, pos: o.i ? +(o.pw / o.i).toFixed(1) : null })).filter((o) => o.pos >= 8 && o.pos <= 20 && o.impr >= 5).sort((a, b) => b.impr - a.impr).slice(0, 15);
    const pages = (src.pages || []).map((x) => ({ u: String(x.page || '').replace(/^https?:\/\/[^/]+/, '') || '/', clicks: num(x.clicks), impr: num(x.impressions), pos: +num(x.position).toFixed(1) })).filter((x) => !rankEx.test(x.u)).sort((a, b) => b.clicks - a.clicks || b.impr - a.impr).slice(0, 15);
    const rr = (a) => a.map((v) => Math.round(v));
    return { name: st.name, clicks: rr(clicks), impr: rr(impr), posW: rr(posW),
      topics: Object.entries(byTopic).map(([n, o]) => ({ n, ...fin(o) })).sort((a, b) => b.impr - a.impr),
      towns: Object.entries(byTown).map(([n, o]) => ({ n, ...fin(o) })).sort((a, b) => b.impr - a.impr).slice(0, 15),
      brand: { clicks: brandC, impr: brandI }, nonBrand: { clicks: nbC, impr: nbI }, striking, pages,
      rankings: st.id === (config.windsor.sites || [])[0]?.id ? rankings : [] };
  });

  // ======================= insights =======================
  // technicians: credit the first assigned employee on each completed job
  const techName = (j) => { const e = (j.assigned_employees || j.employees || [])[0]; return e ? [e.first_name, e.last_name].filter(Boolean).join(' ') || e.name || 'Unassigned' : 'Unassigned'; };
  const techs = {};
  for (const c of byCust.values()) for (const d of c.done) {
    const n = techName(d.j); const o = techs[n] ||= { rev: zeros(), cnt: zeros(), repl: zeros() };
    put(o.rev, d.day, d.amt); put(o.cnt, d.day); if (d.type === 'Replacement') put(o.repl, d.day);
  }
  for (const o of Object.values(techs)) o.rev = o.rev.map(Math.round);
  // estimates: sent date, won, value, days until a job was booked for that customer
  const estStats = [];
  for (const e of hcp.estimates || []) {
    const d = localDay(e.created_at); if (!d || d < from) continue;
    const opts = e.options || [];
    const won = opts.some((o) => /approved/.test(String(o.approval_status || o.status || '').toLowerCase()));
    const lost = !won && opts.length && opts.every((o) => /declin|expired/.test(String(o.approval_status || o.status || '').toLowerCase()));
    const cid = e.customer?.id || e.customer_id; const cust = cid && byCust.get(cid);
    const booked = cust ? cust.created.find((x) => x >= d) : null;
    const wonOpt = opts.find((o) => /approved/.test(String(o.approval_status || '').toLowerCase()));
    estStats.push([d, won ? 1 : lost ? -1 : 0, Math.round(amount((wonOpt || opts[0] || {}).total_amount)), booked && won ? daysBetween(d, booked) : null]);
  }
  // tune-ups due: last tune-up 10 to 14 months ago and none since
  const tuneDue = [];
  for (const c of byCust.values()) {
    const tu = c.done.filter((d) => d.type === 'Tune-up'); if (!tu.length) continue;
    const last = tu[tu.length - 1].day, age = daysBetween(last, today);
    if (age >= 300 && age <= 430) tuneDue.push({ n: c.name, last, jobs: c.done.length, ltv: Math.round(c.done.reduce((x, d) => x + d.amt, 0)), h: hcpLink('customer', c.id) });
  }
  tuneDue.sort((a, b) => (a.last < b.last ? -1 : 1));
  // campaigns: a GHL pipeline, matched to HCP jobs booked after each opportunity was created
  const stageName = new Map(); const pipeName = new Map();
  for (const pl of ghl.pipelines || []) { pipeName.set(pl.id, pl.name); for (const st of pl.stages || []) stageName.set(st.id, st.name); }
  const contactById = new Map((ghl.contacts || []).map((c) => [c.id, c]));
  const campaigns = (config.campaigns || []).map((cp) => {
    const re = rx(cp.pipeline), win = cp.window_days || 60, offer = rx(cp.offer || 'tune');
    const opps = (ghl.opportunities || []).filter((o) => re.test(pipeName.get(o.pipelineId) || o.pipeline?.name || ''));
    const stages = {}; const list = []; let booked = 0, done = 0, revenue = 0, followOn = 0, otherWork = 0; const starts = [];
    for (const o of opps) {
      const d = localDay(o.createdAt || o.dateAdded); if (!d) continue; starts.push(d);
      const st = stageName.get(o.pipelineStageId) || o.status || 'Open'; stages[st] = (stages[st] || 0) + 1;
      const ct = contactById.get(o.contactId) || o.contact || {};
      const cid = phoneIdx.get(phone10(ct.phone)) || emailIdx.get(email(ct.email));
      const cust = cid && byCust.get(cid);
      const inWin = (x) => x >= d && daysBetween(d, x) <= win;
      // the campaign's own result: a tune-up booked or done after the customer was texted
      const tuJobs = cust ? cust.jobs.filter((j) => inWin(localDay(j.created_at) || '') && jobType(j) === 'Tune-up') : [];
      const tuDone = cust ? cust.done.filter((x) => x.type === 'Tune-up' && inWin(x.day)) : [];
      const firstTu = tuDone[0]?.day || null;
      // follow-on: repair or replacement completed after that campaign tune-up
      const fo = firstTu ? cust.done.filter((x) => (x.type === 'Repair' || x.type === 'Replacement') && x.day >= firstTu && daysBetween(firstTu, x.day) <= win) : [];
      // other work in the window that did not come through a campaign tune-up (not credited)
      const other = cust && !firstTu ? cust.done.filter((x) => inWin(x.day) && x.type !== 'Tune-up').reduce((a, x) => a + x.amt, 0) : 0;
      const rv = tuDone.reduce((a, x) => a + x.amt, 0), fov = fo.reduce((a, x) => a + x.amt, 0);
      if (tuJobs.length || tuDone.length) booked++; if (tuDone.length) done++; revenue += rv; followOn += fov; otherWork += other;
      list.push({ n: ghlName(ct) !== 'Contact' ? ghlName(ct) : (o.name || 'Contact'), d, st, b: !!(tuJobs.length || tuDone.length), rv: Math.round(rv + fov), g: gLink(o.contactId), h: cust ? hcpLink('customer', cust.id) : null });
    }
    list.sort((a, b) => b.rv - a.rv || (b.b - a.b) || (a.d < b.d ? 1 : -1));
    return { name: cp.name, start: starts.sort()[0] || null, opps: list.length, stages: Object.entries(stages).sort((a, b) => b[1] - a[1]), booked, done, revenue: Math.round(revenue), followOn: Math.round(followOn), otherWork: Math.round(otherWork), window: win, list: list.slice(0, 1200) };
  });
  if ((config.campaigns || []).length && !campaigns.some((c) => c.opps)) notes.push(`Campaigns: no GHL pipeline matched "${config.campaigns.map((c) => c.pipeline).join(', ')}". Pipelines found: ${[...pipeName.values()].join(', ') || 'none'}.`);

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
    sources: SOURCES, marketingStart: start, matching: match,
    audit: { rawSources: [...rawCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40), callMessages: callMsgs, messages: (ghl.messages || []).length, conversations: (ghl.conversations || []).length, contacts: (ghl.contacts || []).length, opportunities: (ghl.opportunities || []).length, waitingSkipped: waiting.skipped },
    lsa, lsaWindsor: Object.fromEntries(Object.entries(lsaWin).map(([m, v]) => [m, +v.toFixed(2)])), lsaCharged: lsaLeads, cohorts, custCohorts, attribution: how, listings, rankings,
    snapshot: {
      waiting, link: loc ? `${config.ghl.app_base}/v2/location/${loc}/conversations/conversations` : null,
      estimates: { open: estOpen, value: Math.round(estValue), aged: estAged }, needsScheduling: unsched.length, schedule,
      customers: { withJob, repeat, winback12: wb12, winback24: wb24 },
      pullThrough: { tuneups: tune, converted: tuneConv, revenue: Math.round(tuneConvRev) },
      response: r, heat, heatAll, beforeAfter: ba, existingInCrm, syncExcluded,
    },
    techs, estStats, campaigns, sites, leadOutcomes, leadHeat, answering: config.answering_hours || [8, 20],
    lists: {
      credited: credited.slice(0, 2500), leads: leadList.sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 3000), waiting: waitList.slice(0, 300),
      estimates: estList.slice(0, 300), unscheduled: unsched.slice(0, 300), missed: missList.sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 400),
      winback: winList.sort((a, b) => b.ltv - a.ltv).slice(0, 300), tuneDue: tuneDue.slice(0, 600), outcomes: outList.sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 1500),
    },
  };
}
