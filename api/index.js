import { createStore } from '../src/store.js';
import { createSseHub } from '../src/sse.js';
import { createBaseUrlResolver } from '../src/network.js';
import { createApp } from '../src/app.js';

const store = createStore();
const sse = createSseHub({ disabled: true });
const resolveBaseUrl = createBaseUrlResolver(process.env.PORT || 4100);
const app = createApp({
  store,
  sse,
  resolveBaseUrl,
  realtimeMode: 'poll',
});

export default app;
