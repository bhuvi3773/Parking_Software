import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createValetDb } from '../src/db.js';
import { createSseHub } from '../src/sse.js';
import { createApp } from '../src/app.js';

async function startTestServer(extraOpts = {}) {
  const store = createValetDb(':memory:', { defaultPin: '1234' });
  await store.init();
  const sse = createSseHub({ heartbeatMs: 60000, disabled: extraOpts.realtimeMode === 'poll' });
  const app = createApp({
    store,
    sse,
    resolveBaseUrl: () => 'http://192.168.1.50:4100',
    realtimeMode: extraOpts.realtimeMode || 'sse',
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        store,
        sse,
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

async function loginCookie(baseUrl, pin = '1234') {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  assert.equal(res.status, 200);
  const cookieHeader = res.headers.get('set-cookie');
  assert.ok(cookieHeader);
  return cookieHeader.split(';')[0];
}

function readNextSseEvent(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const frames = buffer.split('\n\n');
        for (const frame of frames) {
          if (frame.includes('event: ticket')) {
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (dataLine) {
              req.destroy();
              resolve(JSON.parse(dataLine.slice(6)));
              return;
            }
          }
        }
      });
      res.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
  });
}

describe('Valet HTTP API & Two-Sided Chat SSE', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startTestServer();
  });

  afterEach(async () => {
    ctx.sse.closeAll();
    await new Promise((resolve) => ctx.server.close(resolve));
    await ctx.store.close();
  });

  it('protects worker routes with PIN session auth', async () => {
    const unauthList = await fetch(`${ctx.baseUrl}/api/tickets`);
    assert.equal(unauthList.status, 401);

    const unauthCreate = await fetch(`${ctx.baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ car_number: 'KA01-1234', customer_name: 'Riya' }),
    });
    assert.equal(unauthCreate.status, 401);

    const badLogin = await fetch(`${ctx.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '9999' }),
    });
    assert.equal(badLogin.status, 401);

    const cookie = await loginCookie(ctx.baseUrl, '1234');
    const sessionRes = await fetch(`${ctx.baseUrl}/api/auth/session`, {
      headers: { Cookie: cookie },
    });
    const sessionJson = await sessionRes.json();
    assert.equal(sessionJson.authenticated, true);
    assert.equal(sessionJson.is_default_pin, true);
  });

  it('runs full two-sided QR scan -> Hi message -> customer ready -> worker entrance flow', async () => {
    const cookie = await loginCookie(ctx.baseUrl);

    const createRes = await fetch(`${ctx.baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        car_number: 'KA01-1234',
        customer_name: 'Arjun',
        valet_number: 'V-14',
        parking_spot: 'B2-08',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.ticket.ticket_number, 101);
    assert.equal(created.ticket.valet_number, 'V-14');
    assert.equal(created.guestUrl, `http://192.168.1.50:4100/t/${created.ticket.code}`);
    assert.ok(created.qrDataUrl.startsWith('data:image/png;base64,'));
    assert.equal(created.ticket.messages.length, 1);

    // Edit ticket
    const editRes = await fetch(`${ctx.baseUrl}/api/tickets/${created.ticket.code}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ parking_spot: 'B2-12', valet_number: 'V-19' }),
    });
    assert.equal(editRes.status, 200);
    const edited = await editRes.json();
    assert.equal(edited.ticket.parking_spot, 'B2-12');
    assert.equal(edited.ticket.valet_number, 'V-19');

    // Subscribe worker SSE before customer scans QR
    const scanSsePromise = readNextSseEvent(`${ctx.baseUrl}/api/events`, { Cookie: cookie });
    await new Promise((r) => setTimeout(r, 30));

    // Customer opens /api/tickets/:code (scanning QR) -> marks scanned_at and returns Hi chat thread
    const guestRes = await fetch(`${ctx.baseUrl}/api/tickets/${created.ticket.code}`);
    assert.equal(guestRes.status, 200);
    const guestData = await guestRes.json();
    assert.equal(guestData.ticket.car_number, 'KA01-1234');
    assert.equal(guestData.ticket.customer_name, 'Arjun');
    assert.equal(guestData.ticket.valet_number, 'V-19');
    assert.equal(guestData.ticket.parking_spot, undefined);
    assert.ok(guestData.ticket.scanned_at);
    assert.equal(guestData.messages.length, 1);
    assert.match(guestData.messages[0].body, /Hi Arjun/i);

    const scanEvt = await scanSsePromise;
    assert.ok(scanEvt.scanned_at);

    // Subscribe both SSE streams before customer sends "I am ready to leave"
    const valetEventPromise = readNextSseEvent(`${ctx.baseUrl}/api/events`, { Cookie: cookie });
    const guestEventPromise = readNextSseEvent(`${ctx.baseUrl}/api/tickets/${created.ticket.code}/events`);
    await new Promise((r) => setTimeout(r, 40));

    const req1 = await fetch(`${ctx.baseUrl}/api/tickets/${created.ticket.code}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'I am ready to leave' }),
    });
    assert.equal(req1.status, 200);
    const req1Json = await req1.json();
    assert.equal(req1Json.alreadyUpdated, false);
    assert.equal(req1Json.ticket.status, 'requested');
    assert.equal(req1Json.messages.length, 2);

    const [valetEvt, guestEvt] = await Promise.all([valetEventPromise, guestEventPromise]);
    assert.equal(valetEvt.status, 'requested');
    assert.equal(valetEvt.messages.length, 2);
    assert.equal(guestEvt.ticket.status, 'requested');
    assert.equal(guestEvt.messages.length, 2);

    // Idempotent second tap
    const req2 = await fetch(`${ctx.baseUrl}/api/tickets/${created.ticket.code}/request`, { method: 'POST' });
    const req2Json = await req2.json();
    assert.equal(req2Json.alreadyUpdated, true);
    assert.equal(req2Json.messages.length, 2);

    // Customer sends custom chat message & worker replies
    const cChatRes = await fetch(`${ctx.baseUrl}/api/tickets/${created.ticket.code}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Waiting near main lobby door' }),
    });
    assert.equal(cChatRes.status, 201);
    assert.equal((await cChatRes.json()).messages.length, 3);

    // Two workers tap Placed at Entrance concurrently
    const ent1 = await fetch(`${ctx.baseUrl}/api/tickets/${created.ticket.code}/entrance`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    const ent2 = await fetch(`${ctx.baseUrl}/api/tickets/${created.ticket.code}/entrance`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    const ent1Json = await ent1.json();
    const ent2Json = await ent2.json();
    assert.equal(ent1Json.alreadyUpdated, false);
    assert.equal(ent2Json.alreadyUpdated, true);
    assert.equal(ent1Json.ticket.messages.length, 4);
    assert.match(ent1Json.ticket.messages[3].body, /ready at the entrance/i);

    // Complete handover twice
    const comp1 = await fetch(`${ctx.baseUrl}/api/tickets/${created.ticket.code}/complete`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    const comp2 = await fetch(`${ctx.baseUrl}/api/tickets/${created.ticket.code}/complete`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal((await comp1.json()).alreadyUpdated, false);
    assert.equal((await comp2.json()).alreadyUpdated, true);
  });

  it('requires PIN to cancel ticket and builds wa.me fallback URL when configured', async () => {
    const cookie = await loginCookie(ctx.baseUrl);

    const setRes = await fetch(`${ctx.baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ hotel_name: 'Oakwood Hotel', valet_whatsapp_phone: '+1 555-010-9988' }),
    });
    assert.equal(setRes.status, 200);

    const createRes = await fetch(`${ctx.baseUrl}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ car_number: 'BLUE-77', customer_name: 'Nina' }),
    });
    const { ticket } = await createRes.json();

    const guestBefore = await (await fetch(`${ctx.baseUrl}/api/tickets/${ticket.code}`)).json();
    assert.equal(guestBefore.hotel_name, 'Oakwood Hotel');
    assert.match(guestBefore.wa_me_url, /^https:\/\/wa\.me\/15550109988\?text=/);

    const qrRes = await fetch(`${ctx.baseUrl}/api/tickets/${ticket.code}/qr`);
    assert.equal(qrRes.status, 200);
    assert.match(qrRes.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await qrRes.text(), /<svg/);

    const badCancel = await fetch(`${ctx.baseUrl}/api/tickets/${ticket.code}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(badCancel.status, 403);

    const goodCancel = await fetch(`${ctx.baseUrl}/api/tickets/${ticket.code}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ pin: '1234' }),
    });
    assert.equal(goodCancel.status, 200);
    assert.equal((await goodCancel.json()).ticket.status, 'cancelled');
  });

  it('serves Worker Side HTML, Customer Side HTML, and shared stylesheet', async () => {
    const valetHtml = await fetch(`${ctx.baseUrl}/`);
    assert.equal(valetHtml.status, 200);
    assert.match(await valetHtml.text(), /Worker/i);

    const guestHtml = await fetch(`${ctx.baseUrl}/t/anycode`);
    assert.equal(guestHtml.status, 200);
    assert.match(await guestHtml.text(), /I am ready to leave/);

    const css = await fetch(`${ctx.baseUrl}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  });

  it('sets Secure cookie and resolves https QR URLs behind reverse proxies', async () => {
    const { createBaseUrlResolver } = await import('../src/network.js');
    const proxyStore = createValetDb(':memory:', { defaultPin: '1234' });
    await proxyStore.init();
    const proxySse = createSseHub({ heartbeatMs: 60000 });
    const proxyApp = createApp({
      store: proxyStore,
      sse: proxySse,
      resolveBaseUrl: createBaseUrlResolver(4100),
      realtimeMode: 'poll',
    });

    const srv = await new Promise((resolve) => {
      const s = proxyApp.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const port = srv.address().port;
      const base = `http://127.0.0.1:${port}`;
      const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Proto': 'https',
        },
        body: JSON.stringify({ pin: '1234' }),
      });
      const setCookie = loginRes.headers.get('set-cookie');
      assert.match(setCookie, /;\s*Secure/i);

      const health = await new Promise((resolve, reject) => {
        const req = http.get(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/health',
            headers: {
              Host: 'valet.up.railway.app',
              'X-Forwarded-Proto': 'https, http',
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(JSON.parse(body)));
          }
        );
        req.on('error', reject);
      });
      assert.equal(health.baseUrl, 'https://valet.up.railway.app');
      assert.equal(health.realtimeMode, 'poll');
    } finally {
      proxySse.closeAll();
      await new Promise((resolve) => srv.close(resolve));
      await proxyStore.close();
    }
  });
});
