import { PlasmaTrackApi } from '../api/client.ts';
import { BASE_URL, BOT_TOKEN, MockPlasmaTrackServer } from './server.ts';

// The "demo" backend: the contract mock with made-up data, for test Discord
// servers until a real test server exists. One instance per Worker isolate,
// so its data resets whenever the isolate restarts. Never real data.

let demo: PlasmaTrackApi | undefined;

export function demoApi(): PlasmaTrackApi {
  if (!demo) {
    const server = new MockPlasmaTrackServer({ anyActorIsAdmin: true });
    demo = new PlasmaTrackApi({ baseUrl: BASE_URL, token: BOT_TOKEN, fetch: server.fetch });
  }
  return demo;
}
