import { config, getJSON, need, sleep, addDays, localDay } from './lib.mjs';

const notes = [];
export const sourceNotes = notes;

// Try each variant until one works; record a note instead of stopping the run.
async function firstThatWorks(label, variants) {
  const errs = [];
  for (const v of variants) {
    try { return await v(); } catch (e) { errs.push(e.message); }
  }
  notes.push(`${label}: unavailable (${errs[errs.length - 1]})`);
  return null;
}

// ---------------- Housecall Pro ----------------
function hcpHeaders(scheme = 'Token') {
  return { Authorization: `${scheme} ${need('HCP_API_KEY')}` };
}
let hcpScheme = 'Token';
async function hcpGet(pathQ) {
  const url = config.hcp.base + pathQ;
  try { return await getJSON(url, { headers: hcpHeaders(hcpScheme) }, 'Housecall Pro ' + pathQ.split('?')[0]); }
  catch (e) {
    if (/HTTP 401/.test(e.message) && hcpScheme === 'Token') { hcpScheme = 'Bearer'; return getJSON(url, { headers: hcpHeaders('Bearer') }, 'Housecall Pro'); }
    throw e;
  }
}
async function hcpAll(resource, key, extra = '') {
  const out = [];
  for (let page = 1; page < 500; page++) {
    const r = await hcpGet(`/${resource}?page=${page}&page_size=100${extra}`);
    const rows = r[key] || r.data || [];
    out.push(...rows);
    const total = r.total_pages ?? r.totalPages;
    if (!rows.length || (total && page >= total)) break;
    await sleep(120);
  }
  return out;
}
export async function pullHCP() {
  const jobs = await hcpAll('jobs', 'jobs', '&sort_direction=asc');
  const estimates = (await firstThatWorks('Housecall Pro estimates', [() => hcpAll('estimates', 'estimates')])) || [];
  // full customer records: job payloads can carry a trimmed customer without phones or email
  const customers = (await firstThatWorks('Housecall Pro customers', [() => hcpAll('customers', 'customers')])) || [];
  return { jobs, estimates, customers };
}
export async function checkHCP() {
  const r = await hcpGet('/jobs?page=1&page_size=1');
  return `${r.total_items ?? (r.jobs || []).length} jobs visible`;
}

// ---------------- GoHighLevel ----------------
function ghlHeaders() {
  return { Authorization: `Bearer ${need('GHL_TOKEN')}`, Version: config.ghl.version, 'Content-Type': 'application/json' };
}
const ghl = (p, opts = {}, version) => getJSON(config.ghl.base + p, { ...opts, headers: { ...ghlHeaders(), ...(version ? { Version: version } : {}) } }, 'GoHighLevel ' + p.split('?')[0].replace(/[A-Za-z0-9]{16,}/g, '{id}'));

async function ghlContacts(loc) {
  // v2 search with searchAfter; falls back to the older list endpoint
  return firstThatWorks('GoHighLevel contacts', [
    async () => {
      const out = []; let after = null;
      for (let i = 0; i < 400; i++) {
        const body = { locationId: loc, pageLimit: 500, sort: [{ field: 'dateAdded', direction: 'asc' }] };
        if (after) body.searchAfter = after;
        const r = await ghl('/contacts/search', { method: 'POST', body: JSON.stringify(body) });
        const rows = r.contacts || [];
        out.push(...rows);
        if (rows.length < 500) break;
        after = rows[rows.length - 1].searchAfter;
        if (!after) break;
        await sleep(150);
      }
      return out;
    },
    async () => {
      const out = []; let q = '';
      for (let i = 0; i < 2000; i++) {
        const r = await ghl(`/contacts/?locationId=${loc}&limit=100${q}`);
        const rows = r.contacts || [];
        out.push(...rows);
        const m = r.meta || {};
        if (!rows.length || !m.startAfterId) break;
        q = `&startAfterId=${m.startAfterId}&startAfter=${m.startAfter}`;
        await sleep(150);
      }
      return out;
    },
  ]);
}

async function ghlConversations(loc, sinceDay) {
  const out = []; let after = '';
  for (let i = 0; i < 300; i++) {
    const r = await ghl(`/conversations/search?locationId=${loc}&limit=100&sort=desc&sortBy=last_message_date${after}`);
    const rows = r.conversations || [];
    out.push(...rows);
    if (rows.length < 100) break;
    const last = rows[rows.length - 1];
    if (localDay(last.lastMessageDate) < sinceDay) break;
    after = `&startAfterDate=${last.lastMessageDate}`;
    await sleep(150);
  }
  return out;
}

let msgVersion = '2021-04-15'; // the conversations API expects this version
async function ghlMessages(convId) {
  const out = []; let q = '';
  for (let i = 0; i < 10; i++) {
    let r;
    try { r = await ghl(`/conversations/${convId}/messages?limit=100${q}`, {}, msgVersion); }
    catch (e) { if (msgVersion === '2021-04-15') { msgVersion = config.ghl.version; r = await ghl(`/conversations/${convId}/messages?limit=100${q}`, {}, msgVersion); } else throw e; }
    const box = r.messages || {};
    const rows = box.messages || [];
    out.push(...rows);
    if (!box.nextPage || !box.lastMessageId) break;
    q = `&lastMessageId=${box.lastMessageId}`;
  }
  return out;
}

export async function pullGHL(today) {
  const loc = need('GHL_LOCATION_ID');
  const contacts = (await ghlContacts(loc)) || [];
  const opportunities = (await firstThatWorks('GoHighLevel opportunities', [async () => {
    const out = [];
    for (let page = 1; page < 200; page++) {
      const r = await ghl(`/opportunities/search?location_id=${loc}&limit=100&page=${page}`);
      const rows = r.opportunities || [];
      out.push(...rows);
      if (rows.length < 100) break;
      await sleep(150);
    }
    return out;
  }])) || [];
  const pipelines = (await firstThatWorks('GoHighLevel pipelines', [async () => (await ghl(`/opportunities/pipelines?locationId=${loc}`)).pipelines || []])) || [];
  const since = addDays(today, -config.ghl.message_window_days);
  const conversations = (await firstThatWorks('GoHighLevel conversations', [() => ghlConversations(loc, addDays(today, -400))])) || [];
  const recent = conversations.filter((c) => localDay(c.lastMessageDate) >= since);
  const messages = [];
  let failed = 0, firstErr = '';
  for (const c of recent) {
    try {
      const ms = await ghlMessages(c.id);
      for (const m of ms) messages.push({ ...m, conversationId: c.id, contactId: m.contactId || c.contactId });
    } catch (e) { failed++; if (!firstErr) firstErr = e.message.slice(0, 180); if (failed >= 25 && messages.length === 0) break; }
    await sleep(110);
  }
  if (failed) notes.push(`GoHighLevel messages: ${failed} conversations could not be read. First error: ${firstErr}`);
  return { contacts, opportunities, pipelines, conversations, messages, locationId: loc };
}
export async function checkGHL() {
  const loc = need('GHL_LOCATION_ID');
  const r = await ghl(`/contacts/?locationId=${loc}&limit=1`);
  const total = r.meta?.total ?? r.total;
  return `contacts readable${total != null ? ` (${total} contacts)` : ''}`;
}

// ---------------- Windsor ----------------
async function windsor(connector, account, fields, from, to) {
  const key = need('WINDSOR_API_KEY');
  const qs = new URLSearchParams({ api_key: key, date_from: from, date_to: to, fields: fields.join(','), select_accounts: account });
  const r = await getJSON(`https://connectors.windsor.ai/${connector}?${qs}`, {}, `Windsor ${connector}`);
  const rows = r.data || r.result || [];
  // Shared Windsor: keep only this client's account even if the filter was ignored
  return rows.filter((x) => !x.account_id || String(x.account_id).replace(/-/g, '') === String(account).replace(/-/g, '') || x.account_id === account);
}

export async function pullWindsor(from, to) {
  const w = config.windsor;
  const safe = (label, fn) => firstThatWorks(label, [fn]).then((x) => x || []);
  const gads = await safe('Google Ads', () => windsor('google_ads', w.google_ads, ['account_id', 'date', 'campaign', 'spend', 'clicks', 'impressions', 'conversions'], from, to));
  const meta = await safe('Meta', () => windsor('facebook', w.meta, ['account_id', 'date', 'campaign', 'spend', 'clicks', 'impressions', 'actions_lead', 'actions_onsite_conversion_lead_grouped', 'actions_click_to_call_call_confirm'], from, to));
  // account-wide check: campaign-level pulls with filters can drop campaigns
  const metaTotal = await safe('Meta total', () => windsor('facebook', w.meta, ['account_id', 'date', 'spend'], from, to));
  const gbp = {}; const reviews = {}; const totals = {};
  for (const l of w.listings) {
    gbp[l.id] = await safe(`Listing ${l.name}`, () => windsor('google_my_business', l.id, ['account_id', 'date', 'call_clicks', 'website_clicks', 'impressions'], from, to));
    reviews[l.id] = await safe(`Reviews ${l.name}`, () => windsor('google_my_business', l.id, ['account_id', 'review_id', 'review_create_time', 'review_star_rating'], from, to));
    totals[l.id] = (await safe(`Review totals ${l.name}`, () => windsor('google_my_business', l.id, ['account_id', 'review_total_count', 'review_average_rating_total'], addDays(to, -7), to)))[0] || null;
  }
  const sites = {};
  for (const st of w.sites || [{ id: w.search_console, name: w.search_console }]) {
    if (st.pending) continue;
    sites[st.id] = {
      totals: await safe(`Search Console ${st.name}`, () => windsor('searchconsole', st.id, ['date', 'clicks', 'impressions', 'position'], from, to)),
      queries: await safe(`Search Console queries ${st.name}`, () => windsor('searchconsole', st.id, ['date', 'query', 'clicks', 'impressions', 'position'], addDays(to, -120), to)),
      pages: await safe(`Search Console pages ${st.name}`, () => windsor('searchconsole', st.id, ['page', 'clicks', 'impressions', 'position'], addDays(to, -90), to)),
    };
  }
  const sc = sites[(w.sites || [])[0]?.id]?.queries || [];
  return { gads, meta, metaTotal, gbp, reviews, totals, sc, sites };
}
export async function checkWindsor() {
  const d = new Date().toISOString().slice(0, 10);
  const rows = await windsor('google_ads', config.windsor.google_ads, ['account_id', 'date', 'spend'], addDays(d, -14), d);
  const last = rows.filter((r) => Number(r.spend) > 0).map((r) => r.date).sort().pop();
  return `Google Ads rows: ${rows.length}, last day with spend: ${last || 'none in 14 days'}`;
}
