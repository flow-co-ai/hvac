// Tests each connection and prints OK or the exact error. Runs first in every Action.
import { checkHCP, checkGHL, checkWindsor } from './sources.mjs';
let bad = 0;
for (const [name, fn] of [['Housecall Pro', checkHCP], ['GoHighLevel', checkGHL], ['Windsor', checkWindsor]]) {
  try { console.log(`OK    ${name}: ${await fn()}`); }
  catch (e) { bad++; console.log(`FAIL  ${name}: ${e.message}`); }
}
if (!(process.env.DASHBOARD_KEY || '').trim()) { bad++; console.log('FAIL  DASHBOARD_KEY is not set'); } else console.log('OK    DASHBOARD_KEY is set');
process.exit(bad ? 1 : 0);
