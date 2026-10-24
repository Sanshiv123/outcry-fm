import { readFileSync,writeFileSync,existsSync,mkdirSync,chmodSync } from 'node:fs';
import { createOrganizationUser } from '../server/tm/gateway.ts';
import { signerPublicKeyCompressedHex } from '../server/tm/stamp.ts';
// Stable signer-derived reference makes retries idempotent for this station.
const ref=`outcry-station-${signerPublicKeyCompressedHex.slice(0,16)}`;
const file='data/setup/station-wallet.json';
if(existsSync(file)){console.log('Station wallet already recorded; preserving existing setup.');process.exit(0);}
try{
 const user=await createOrganizationUser(ref,signerPublicKeyCompressedHex);
 mkdirSync('data/setup',{recursive:true});writeFileSync(file,JSON.stringify({user_id:user.user_id,external_ref_id:ref,wallets:user.wallets},null,2),{mode:0o600});
 let s=readFileSync('.env','utf8');
 for(const wallet of user.wallets){const k=wallet.chain_family==='solana'?'STATION_WALLET_SOLANA':wallet.chain_family==='evm'?'STATION_WALLET_EVM':null;if(!k)continue;const re=new RegExp(`^${k}=.*$`,'m');s=re.test(s)?s.replace(re,()=>`${k}=${wallet.address}`):s+`\n${k}=${wallet.address}\n`;console.log(`Created ${wallet.chain_family} station receiving wallet.`);}
 writeFileSync('.env',s,{mode:0o600});chmodSync('.env',0o600);
 console.log('Station addresses saved in .env. No funding or trades. MOCK_MODE unchanged.');
}catch(e){const err=e as {status?:number;name?:string};console.log(`Station wallet setup did not complete: ${err.name||'error'}${err.status?' HTTP '+err.status:''}. No secrets displayed.`);process.exitCode=1;}
