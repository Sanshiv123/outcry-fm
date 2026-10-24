// Move PYUSD from the station wallet (data/setup/station-wallet.json) to a listener wallet.
// Run ONLY on the laptop that created the station wallet; its signer key must match.
// Usage: MOCK_MODE=false npx tsx scripts/move-station-funds.ts <solana_address> <qty>
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createTransfer, executeTransfer, getTransfer, listAssets } from '../server/tm/gateway.ts';
import { stampAll, signerPublicKeyCompressedHex } from '../server/tm/stamp.ts';
import { isAddressOn } from '../shared/validation.ts';

const [to, qty] = process.argv.slice(2);
if (!to || !qty || !/^\d+(\.\d{1,6})?$/.test(qty)) { console.log('Usage: npx tsx scripts/move-station-funds.ts <solana_address> <qty>'); process.exit(1); }
if (Number(qty) <= 0 || Number(qty) > 25) { console.log('Refusing: qty must be between 0 and 25 PYUSD.'); process.exit(1); }
if (!isAddressOn('solana', to)) { console.log('Refusing: not a valid Solana address.'); process.exit(1); }
const station = JSON.parse(readFileSync('data/setup/station-wallet.json', 'utf8')) as { user_id: string };
const { data } = await listAssets();
const pyusd = data.find(a => a.symbol.toUpperCase() === 'PYUSD' && a.chain === 'solana');
if (!pyusd) { console.log('PYUSD on Solana not found in the Gateway catalog.'); process.exit(1); }

const t = await createTransfer(station.user_id, { asset_id: pyusd.id, qty, to });
console.log(`Prepared transfer ${t.id}: ${t.qty} PYUSD -> ${t.to}, fee ${t.fee}. Signer ${signerPublicKeyCompressedHex.slice(0, 10)}…`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('Type SEND to execute this real transfer: ');
rl.close();
if (answer.trim() !== 'SEND') { console.log('Cancelled. Nothing was sent.'); process.exit(0); }
const payloads = (t as unknown as { payloads?: { payload: string }[] }).payloads ?? [];
try {
  const r = await executeTransfer(station.user_id, t.id, stampAll(payloads as never));
  console.log(`Submitted: status ${r.status}, transfer ${r.id}`);
} catch (e) {
  console.log(`Execute did not complete (${(e as Error).message}). Checking status instead of resending…`);
  try { const s = await getTransfer(station.user_id, t.id); console.log(`Status: ${s.status}`); } catch { console.log('Status unknown. Do NOT rerun; check the console activity page.'); }
}
