import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValetDb } from './db.js';
import { createSseHub } from './sse.js';
import { createBaseUrlResolver, getLanIp } from './network.js';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4100);
const DB_PATH = process.env.VALET_DB_PATH || path.join(__dirname, '..', 'data', 'valet.db');

const store = createValetDb(DB_PATH);
const sse = createSseHub();
const resolveBaseUrl = createBaseUrlResolver(PORT);
const app = createApp({ store, sse, resolveBaseUrl });

const server = app.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`QR Valet server running:`);
  console.log(`  Podium (this PC):  http://localhost:${PORT}`);
  console.log(`  Wi-Fi / QR base:   http://${lanIp}:${PORT}`);
});

function shutdown() {
  sse.closeAll();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
