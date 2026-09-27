// Made-up rows shaped like the real APIs. Preview and leak testing only.
import { config, addDays, dayRange } from './lib.mjs';

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const iso = (day, h = 9 + Math.floor(rnd() * 10), m = Math.floor(rnd() * 60)) => new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`).toISOString();

export function makeFixture(today) {
  const days = dayRange(config.history_start, today);
  const season = (d) => { const m = Number(d.slice(5, 7)); return [1.4, 1.3, 0.8, 0.7, 0.9, 1.3, 1.6, 1.5, 1.0, 1.1, 1.3, 1.5][m - 1]; };
  const jobs = [], contacts = [], conversations = [], messages = [], estimates = [];
  const customers = [];
  let n = 0;
  const newCustomer = (day) => {
    n++;
    const c = { id: `cus_${n}`, mobile_number: `70855${String(10000 + n).slice(-5)}`, email: `fake${n}@example.test` };
    customers.push({ ...c, since: day });
    return c;
  };
  for (let i = 0; i < 60; i++) newCustomer(config.history_start);
  const types = [
    ['Tune-up', 'Furnace tune-up $89', 89, 129],
    ['Repair', 'No heat service call', 250, 900],
    ['Replacement', 'Furnace replacement - American Standard', 6500, 12500],
    ['Other', 'Property management work order', 180, 600],
  ];
  const srcs = ['Google Ads', 'LSA', 'Facebook lead form', 'website form', '', 'GBP call', 'housecall pro sync'];
  for (const d of days) {
    const k = season(d);
    // new leads in GHL
    const leads = Math.round(rnd() * 3 * k);
    for (let i = 0; i < leads; i++) {
      const src = pick(srcs);
      const c = newCustomer(d);
      contacts.push({ id: `ct_${c.id}`, dateAdded: iso(d), phone: '+1' + c.mobile_number, email: c.email, source: src, tags: src.includes('sync') ? ['hcp'] : [] });
      if (rnd() < 0.55) {
        const jd = addDays(d, Math.floor(rnd() * 6));
        if (jd <= today) {
          const t = rnd() < 0.12 ? types[2] : rnd() < 0.5 ? types[1] : types[0];
          jobs.push(job(c, t, jd, today));
        }
      }
      // conversation + messages
      const conv = { id: `cv_${c.id}`, contactId: `ct_${c.id}`, lastMessageDate: iso(d), lastMessageDirection: rnd() < 0.2 ? 'inbound' : 'outbound' };
      conversations.push(conv);
      const t0 = new Date(iso(d, 7 + Math.floor(rnd() * 15)));
      const st = rnd() < 0.3 ? 'no-answer' : rnd() < 0.1 ? 'voicemail' : 'completed';
      messages.push({ conversationId: conv.id, contactId: conv.contactId, messageType: 'TYPE_CALL', direction: 'inbound', dateAdded: t0.toISOString(), meta: { call: { status: d >= config.routing_fix_date && st === 'no-answer' && rnd() < 0.5 ? 'completed' : st } } });
      messages.push({ conversationId: conv.id, contactId: conv.contactId, messageType: 'TYPE_SMS', direction: 'outbound', source: 'workflow', dateAdded: new Date(+t0 + 20e3).toISOString() });
      if (rnd() < 0.85) messages.push({ conversationId: conv.id, contactId: conv.contactId, messageType: 'TYPE_SMS', direction: 'outbound', source: 'app', dateAdded: new Date(+t0 + rnd() * 180 * 60e3).toISOString() });
    }
    // repeat work from existing customers
    const rep = Math.round(rnd() * 4 * k);
    for (let i = 0; i < rep; i++) jobs.push(job(pick(customers.slice(0, Math.max(60, customers.length - 20))), rnd() < 0.3 ? types[3] : pick(types), d, today));
  }
  for (let i = 1; i < 14; i++) for (let k = 0; k < 3 + Math.floor(rnd() * 5); k++) jobs.push(job(pick(customers), pick(types), addDays(today, i), today));
  for (let i = 0; i < 14; i++) estimates.push({ id: `est_${i}`, created_at: iso(addDays(today, -Math.floor(rnd() * 60))), options: [{ total_amount: Math.round(6000 + rnd() * 7000) * 100, approval_status: null }] });
  for (let i = 0; i < 9; i++) conversations.push({ id: `cvw_${i}`, contactId: 'x', lastMessageDate: iso(addDays(today, -Math.floor(rnd() * 6))), lastMessageDirection: 'inbound' });

  // Windsor-shaped rows
  const gads = [], meta = [], metaTotal = [], gbp = {}, reviews = {}, totals = {}, sc = [];
  for (const d of days) {
    const k = season(d);
    if (d >= '2026-04-01') {
      gads.push({ date: d, campaign: 'Heating - Exact', spend: +(40 * k * (0.6 + rnd())).toFixed(2), clicks: Math.round(4 * k * rnd()), impressions: 200 });
      const ms = +(18 * k * (0.6 + rnd())).toFixed(2);
      meta.push({ date: d, campaign: 'Financing kinetic', spend: ms, clicks: Math.round(12 * rnd()), impressions: 900 });
      metaTotal.push({ date: d, spend: ms });
    }
  }
  config.windsor.listings.forEach((l, li) => {
    gbp[l.id] = days.map((d) => ({ date: d, call_clicks: daysAgo(d, today) < 3 ? 0 : Math.round(rnd() * [2, 0.6, 0.4][li]), website_clicks: Math.round(rnd() * [3, 1, 0.8][li]), impressions: Math.round(rnd() * [180, 60, 40][li]) }));
    reviews[l.id] = days.filter(() => rnd() < [0.12, 0.05, 0.04][li]).map((d, i) => ({ review_id: `${li}-${i}`, review_create_time: iso(d), review_star_rating: rnd() < 0.93 ? 'FIVE' : 'FOUR' }));
    totals[l.id] = { review_total_count: [201, 397, 98][li], review_average_rating_total: [5, 5, 4.9][li] };
  });
  const queries = ['furnace repair near me', 'hvac orland park', 'ac repair homer glen', 'furnace tune up', 'furnace replacement cost', 'hvac company frankfort il', 'heating repair burr ridge', 'american standard furnace dealer', 'emergency furnace repair', 'boiler repair orland park', 'quality hvac solutions'];
  for (const d of dayRange(addDays(today, -120), today)) queries.forEach((q, i) => sc.push({ date: d, query: q, impressions: Math.round(rnd() * (20 - i)), clicks: rnd() < 0.1 ? 1 : 0, position: Math.max(1, 3 + i * 1.8 + (rnd() - 0.5) * 3 - daysAgo(d, today) / 60) }));

  const lsa = {}; for (const m of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08']) lsa[m] = Math.round(500 + rnd() * 500);
  return { hcp: { jobs, estimates }, ghl: { contacts, conversations, messages, locationId: 'FAKELOCATION' }, win: { gads, meta, metaTotal, gbp, reviews, totals, sc }, lsa };
}
const daysAgo = (d, today) => Math.round((new Date(today) - new Date(d)) / 864e5);
let jn = 0;
function job(c, t, day, today) {
  jn++;
  const future = day > addDays(today, -1);
  const done = !future && rnd() < 0.93;
  return {
    id: `job_${jn}`, customer: { id: c.id, mobile_number: c.mobile_number, email: c.email },
    description: t[1], work_status: future ? 'scheduled' : done ? 'complete rated' : rnd() < 0.5 ? 'pro canceled' : 'needs scheduling',
    created_at: iso(addDays(day, -Math.floor(rnd() * 3))), schedule: { scheduled_start: iso(day), scheduled_end: iso(day, 17) },
    work_timestamps: { completed_at: done ? iso(day, 16) : null },
    total_amount: Math.round((t[2] + rnd() * (t[3] - t[2])) * 100),
  };
}
