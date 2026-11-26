import { createStore } from './store.js';
import { createSseHub } from './sse.js';
import { createBaseUrlResolver, getLanIp } from './network.js';
import { createApp } from './create-app.js';

const PORT = Number(process.env.PORT || 4100);

const store = createStore();
await store.init();

const sse = createSseHub();
const resolveBaseUrl = createBaseUrlResolver(PORT);
const app = createApp({ store, sse, resolveBaseUrl, realtimeMode: 'sse' });

const server = app.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`QR Valet server running:`);
  console.log(`  Podium (this PC):  http://localhost:${PORT}`);
  console.log(`  Wi-Fi / QR base:   http://${lanIp}:${PORT}`);
});

function shutdown() {
  sse.closeAll();
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
