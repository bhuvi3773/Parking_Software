import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE_NAME = 'valet_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function signSessionToken(secret, expMs) {
  const payload = String(expMs);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token, secret) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expMs = Number(payload);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function toGuestTicket(ticket) {
  return {
    ticket_number: ticket.ticket_number,
    code: ticket.code,
    car_number: ticket.car_number,
    customer_name: ticket.customer_name,
    valet_number: ticket.valet_number,
    status: ticket.status,
    created_at: ticket.created_at,
    scanned_at: ticket.scanned_at,
    requested_at: ticket.requested_at,
    at_entrance_at: ticket.at_entrance_at,
    completed_at: ticket.completed_at,
    cancelled_at: ticket.cancelled_at,
  };
}

function toGuestPayload(ticket) {
  return {
    ticket: toGuestTicket(ticket),
    messages: ticket.messages || [],
  };
}

function buildWaMeUrl(phone, ticket) {
  if (!phone) return null;
  const text = `Hi! Valet #${ticket.valet_number} (${ticket.car_number}, ${ticket.customer_name}) — I am ready to leave. Please bring my car to the entrance.`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/**
 * Create the configured Express app for the two-sided QR Valet Chat system.
 */
export function createApp({ store, sse, resolveBaseUrl, realtimeMode = 'sse' }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  let initPromise = null;
  app.use(async (_req, _res, next) => {
    if (!initPromise) {
      initPromise = Promise.resolve(store.init ? store.init() : undefined).catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    await initPromise;
    next();
  });

  async function isAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie);
    const secret = await store.getSessionSecret();
    return verifySessionToken(cookies[COOKIE_NAME], secret);
  }

  async function requireValetAuth(req, res, next) {
    if (!(await isAuthenticated(req))) {
      return res.status(401).json({ error: 'Valet PIN required' });
    }
    return next();
  }

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      baseUrl: resolveBaseUrl(req),
      realtimeMode,
    });
  });

  app.get('/api/auth/session', async (req, res) => {
    const settings = await store.getSettings();
    res.json({
      authenticated: await isAuthenticated(req),
      is_default_pin: settings.is_default_pin,
      hotel_name: settings.hotel_name,
      realtimeMode,
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { pin } = req.body || {};
    if (!(await store.verifyPin(pin))) {
      return res.status(401).json({ error: 'Invalid valet PIN' });
    }
    const secret = await store.getSessionSecret();
    const token = signSessionToken(secret, Date.now() + SESSION_TTL_MS);
    const secureFlag = req.secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${secureFlag}; Max-Age=${SESSION_TTL_MS / 1000}`
    );
    const settings = await store.getSettings();
    return res.json({
      authenticated: true,
      is_default_pin: settings.is_default_pin,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const secureFlag = req.secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax${secureFlag}; Max-Age=0`
    );
    res.json({ authenticated: false });
  });

  app.get('/api/settings', requireValetAuth, async (req, res) => {
    const settings = await store.getSettings();
    res.json({
      ...settings,
      baseUrl: resolveBaseUrl(req),
      realtimeMode,
    });
  });

  app.put('/api/settings', requireValetAuth, async (req, res) => {
    try {
      const updated = await store.updateSettings(req.body || {});
      sse.broadcastSettingsChange(updated);
      res.json({
        ...updated,
        baseUrl: resolveBaseUrl(req),
        realtimeMode,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/events', requireValetAuth, (req, res) => {
    sse.addValetClient(req, res);
  });

  app.get('/api/tickets', requireValetAuth, async (_req, res) => {
    res.json(await store.listTickets());
  });

  app.post('/api/tickets', requireValetAuth, async (req, res) => {
    try {
      const ticket = await store.createTicket(req.body || {});
      const guestUrl = `${resolveBaseUrl(req)}/t/${ticket.code}`;
      const qrDataUrl = await QRCode.toDataURL(guestUrl, {
        width: 320,
        margin: 2,
        color: { dark: '#0F172A', light: '#FFFFFF' },
      });
      sse.broadcastTicketChange(ticket, toGuestPayload(ticket));
      return res.status(201).json({ ticket, guestUrl, qrDataUrl });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/tickets/:code', requireValetAuth, async (req, res) => {
    try {
      const updated = await store.editTicket(req.params.code, req.body || {});
      if (!updated) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      sse.broadcastTicketChange(updated, toGuestPayload(updated));
      return res.json({ ticket: updated });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/tickets/:code/reply', requireValetAuth, async (req, res) => {
    try {
      const result = await store.addWorkerMessage(req.params.code, req.body?.body);
      if (!result.found) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      sse.broadcastTicketChange(result.ticket, toGuestPayload(result.ticket));
      return res.status(201).json({ ticket: result.ticket });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/tickets/:code/entrance', requireValetAuth, async (req, res) => {
    const result = await store.markAtEntrance(req.params.code, req.body?.message);
    if (!result.found) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (!result.alreadyUpdated) {
      sse.broadcastTicketChange(result.ticket, toGuestPayload(result.ticket));
    }
    return res.json({
      ticket: result.ticket,
      alreadyUpdated: result.alreadyUpdated,
      message: result.message,
    });
  });

  app.post('/api/tickets/:code/complete', requireValetAuth, async (req, res) => {
    const result = await store.markCompleted(req.params.code);
    if (!result.found) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (!result.alreadyUpdated) {
      sse.broadcastTicketChange(result.ticket, toGuestPayload(result.ticket));
    }
    return res.json({
      ticket: result.ticket,
      alreadyUpdated: result.alreadyUpdated,
      message: result.message,
    });
  });

  app.post('/api/tickets/:code/cancel', requireValetAuth, async (req, res) => {
    const { pin } = req.body || {};
    const result = await store.cancelTicket(req.params.code, pin);
    if (!result.ok) {
      return res.status(403).json({ error: 'Valid valet PIN is required to cancel a ticket' });
    }
    if (!result.found) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (!result.alreadyUpdated) {
      sse.broadcastTicketChange(result.ticket, toGuestPayload(result.ticket));
    }
    return res.json({
      ticket: result.ticket,
      alreadyUpdated: result.alreadyUpdated,
      message: result.message,
    });
  });

  // Public Customer Side APIs (scoped by random 8-char capability code)
  app.get('/api/tickets/:code', async (req, res) => {
    const scanRes = await store.markScanned(req.params.code);
    if (!scanRes.found) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (scanRes.newlyScanned) {
      sse.broadcastTicketChange(scanRes.ticket, toGuestPayload(scanRes.ticket));
    }
    const settings = await store.getSettings();
    return res.json({
      ...toGuestPayload(scanRes.ticket),
      hotel_name: settings.hotel_name,
      wa_me_url: buildWaMeUrl(settings.valet_whatsapp_phone, scanRes.ticket),
      realtimeMode,
    });
  });

  app.post('/api/tickets/:code/request', async (req, res) => {
    const result = await store.requestPickup(req.params.code, req.body?.message);
    if (!result.found) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (!result.alreadyUpdated) {
      sse.broadcastTicketChange(result.ticket, toGuestPayload(result.ticket));
    }
    return res.json({
      ...toGuestPayload(result.ticket),
      alreadyUpdated: result.alreadyUpdated,
      message: result.message,
    });
  });

  app.post('/api/tickets/:code/messages', async (req, res) => {
    try {
      const result = await store.addCustomerMessage(req.params.code, req.body?.body);
      if (!result.found) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      sse.broadcastTicketChange(result.ticket, toGuestPayload(result.ticket));
      return res.status(201).json(toGuestPayload(result.ticket));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/tickets/:code/events', async (req, res) => {
    const ticket = await store.getTicketByCode(req.params.code);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    return sse.addTicketClient(ticket.code, req, res);
  });

  app.get('/api/tickets/:code/qr', async (req, res) => {
    const ticket = await store.getTicketByCode(req.params.code);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const guestUrl = `${resolveBaseUrl(req)}/t/${ticket.code}`;
    const svg = await QRCode.toString(guestUrl, {
      type: 'svg',
      margin: 2,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(svg);
  });

  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'valet.html'));
  });

  app.get('/t/:code', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'guest.html'));
  });

  return app;
}
