// Render one shared demo segment; no server, no test cases, no real trades.
import { loadAssets,assets } from '../server/assets.ts';
import { env } from '../server/env.ts';
import { mockGateway,mockPrice } from '../server/outcry/mock.ts';
import { generateShow,segment } from '../server/outcry/show.ts';
if(!env.MOCK_MODE)throw Error('This preparation script only renders the simulated station.');
await loadAssets(mockGateway.listAssets);
await generateShow({gateway:mockGateway,assets,prices:{get:s=>({price:String(mockPrice(s)),change_24h:'.026',as_of:new Date().toISOString()})}});
console.log(JSON.stringify({voice:segment.voice,source:segment.source,clips:segment.lines.filter(l=>l.audio).length,simulated:segment.simulated}));
