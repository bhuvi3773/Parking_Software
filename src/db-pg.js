import crypto from 'node:crypto';
import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import {
  ACTIVE_STATUSES,
  buildEntranceMessage,
  buildWelcomeMessage,
  checkPinHash,
  generateTicketCode,
  getAlreadyEntranceMessage,
  getAlreadyRequestedMessage,
  hashPin,
  normalizePhone,
  nowIso,
} from './store-helpers.js';

const { Pool } = pg;

export const POSTGRES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_number INTEGER NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    car_number TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    valet_number TEXT NOT NULL,
    parking_spot TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('parked', 'requested', 'at_entrance', 'completed', 'cancelled')),
    created_at TEXT NOT NULL,
    scanned_at TEXT,
    requested_at TEXT,
    at_entrance_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(code);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('worker', 'customer', 'system')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_ticket_id ON messages(ticket_id, id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/**
 * Create a Postgres-backed valet ticket & chat store (for Neon / Vercel serverless).
 * @param {string} connectionString
 * @param {{ defaultPin?: string }} [options]
 */
export function createPostgresStore(connectionString, options = {}) {
  const defaultPin = String(options.defaultPin || process.env.VALET_PIN || '1234');
  const pool = new Pool({ connectionString });
  try {
    attachDatabasePool(pool);
  } catch {
    // No-op outside Vercel Fluid compute runtime
  }

  let initPromise = null;

  async function init() {
    if (!initPromise) {
      initPromise = (async () => {
        const client = await pool.connect();
        try {
          await client.query(POSTGRES_SCHEMA_SQL);
          const defaults = [
            ['hotel_name', 'Grand Valet'],
            ['valet_whatsapp_phone', ''],
            ['valet_pin_hash', hashPin(defaultPin)],
            ['is_default_pin', 'true'],
            ['session_secret', crypto.randomBytes(32).toString('hex')],
          ];
          for (const [k, v] of defaults) {
            await client.query(
              'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
              [k, v]
            );
          }
        } finally {
          client.release();
        }
      })().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  }

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function getSetting(key, fallback = '', queryable = pool) {
    const { rows } = await queryable.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0] ? rows[0].value : fallback;
  }

  async function getSettings(queryable = pool) {
    const { rows } = await queryable.query(
      "SELECT key, value FROM settings WHERE key IN ('hotel_name', 'valet_whatsapp_phone', 'is_default_pin')"
    );
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      hotel_name: map.hotel_name || 'Grand Valet',
      valet_whatsapp_phone: map.valet_whatsapp_phone || '',
      is_default_pin: (map.is_default_pin || 'true') === 'true',
    };
  }

  async function getSessionSecret() {
    return getSetting('session_secret');
  }

  async function verifyPin(pin) {
    if (typeof pin !== 'string' && typeof pin !== 'number') return false;
    const trimmed = String(pin).trim();
    if (!trimmed) return false;
    const stored = await getSetting('valet_pin_hash');
    return checkPinHash(trimmed, stored);
  }

  async function updateSettings({ hotel_name, valet_whatsapp_phone, valet_pin } = {}) {
    if (hotel_name !== undefined) {
      const cleaned = String(hotel_name).trim();
      if (!cleaned) throw new Error('hotel_name cannot be empty');
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        ['hotel_name', cleaned.slice(0, 80)]
      );
    }
    if (valet_whatsapp_phone !== undefined) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        ['valet_whatsapp_phone', normalizePhone(valet_whatsapp_phone)]
      );
    }
    if (valet_pin !== undefined && String(valet_pin).trim() !== '') {
      const nextPin = String(valet_pin).trim();
      if (nextPin.length < 4 || nextPin.length > 12) {
        throw new Error('valet_pin must be 4 to 12 characters');
      }
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        ['valet_pin_hash', hashPin(nextPin)]
      );
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        ['is_default_pin', 'false']
      );
    }
    return getSettings();
  }

  async function getMessages(ticketId, queryable = pool) {
    const { rows } = await queryable.query(
      'SELECT * FROM messages WHERE ticket_id = $1 ORDER BY id ASC',
      [ticketId]
    );
    return rows;
  }

  async function hydrateTicket(ticket, queryable = pool) {
    if (!ticket) return null;
    return {
      ...ticket,
      messages: await getMessages(ticket.id, queryable),
    };
  }

  async function hydrateMany(tickets, queryable = pool) {
    if (tickets.length === 0) return [];
    const ids = tickets.map((t) => t.id);
    const { rows: msgs } = await queryable.query(
      'SELECT * FROM messages WHERE ticket_id = ANY($1::int[]) ORDER BY id ASC',
      [ids]
    );
    const byTicket = new Map();
    for (const m of msgs) {
      let arr = byTicket.get(m.ticket_id);
      if (!arr) {
        arr = [];
        byTicket.set(m.ticket_id, arr);
      }
      arr.push(m);
    }
    return tickets.map((t) => ({ ...t, messages: byTicket.get(t.id) || [] }));
  }

  async function getTicketByCode(code) {
    if (!code) return null;
    const { rows } = await pool.query('SELECT * FROM tickets WHERE code = $1', [String(code).trim()]);
    return hydrateTicket(rows[0] || null);
  }

  async function listTickets() {
    const { rows: activeRows } = await pool.query(
      `SELECT * FROM tickets
       WHERE status IN ('requested', 'at_entrance', 'parked')
       ORDER BY
         CASE status
           WHEN 'requested' THEN 0
           WHEN 'at_entrance' THEN 1
           ELSE 2
         END,
         COALESCE(requested_at, created_at) ASC,
         id DESC`
    );

    const { rows: historyRows } = await pool.query(
      `SELECT * FROM tickets
       WHERE status IN ('completed', 'cancelled')
       ORDER BY COALESCE(completed_at, cancelled_at, created_at) DESC, id DESC
       LIMIT 25`
    );

    const { rows: maxRows } = await pool.query(
      'SELECT COALESCE(MAX(ticket_number), 100) AS max_num FROM tickets'
    );

    return {
      active: await hydrateMany(activeRows),
      history: await hydrateMany(historyRows),
      next_valet_number: String(Number(maxRows[0].max_num) + 1),
    };
  }

  async function createTicket({ car_number, customer_name, valet_number = '', parking_spot = '' }) {
    const cleanCar = String(car_number || '').trim();
    const cleanCustomer = String(customer_name || '').trim();
    const cleanSpot = String(parking_spot || '').trim();

    if (!cleanCar) throw new Error('car_number is required');
    if (!cleanCustomer) throw new Error('customer_name is required');

    return withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(916954)');
      const { rows: maxRows } = await client.query(
        'SELECT COALESCE(MAX(ticket_number), 100) AS max_num FROM tickets'
      );
      const ticketNumber = Number(maxRows[0].max_num) + 1;
      const cleanValet = String(valet_number || '').trim() || String(ticketNumber);

      let code = generateTicketCode();
      for (;;) {
        const { rows: dup } = await client.query('SELECT 1 FROM tickets WHERE code = $1', [code]);
        if (dup.length === 0) break;
        code = generateTicketCode();
      }

      const createdAt = nowIso();
      const { rows: inserted } = await client.query(
        `INSERT INTO tickets (
           ticket_number, code, car_number, customer_name, valet_number, parking_spot, status, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'parked', $7)
         RETURNING *`,
        [
          ticketNumber,
          code,
          cleanCar.slice(0, 120),
          cleanCustomer.slice(0, 80),
          cleanValet.slice(0, 40),
          cleanSpot.slice(0, 40),
          createdAt,
        ]
      );
      const ticket = inserted[0];

      const hotelName = await getSetting('hotel_name', 'Grand Valet', client);
      const hiMessage = buildWelcomeMessage(cleanCustomer, hotelName, cleanCar, cleanValet);
      await client.query(
        'INSERT INTO messages (ticket_id, sender, body, created_at) VALUES ($1, $2, $3, $4)',
        [ticket.id, 'worker', hiMessage, createdAt]
      );

      return hydrateTicket(ticket, client);
    });
  }

  async function markScanned(code) {
    const cleanCode = String(code || '').trim();
    return withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM tickets WHERE code = $1 FOR UPDATE', [cleanCode]);
      const ticket = rows[0];
      if (!ticket) return { found: false };

      if (!ticket.scanned_at) {
        const ts = nowIso();
        const { rows: updated } = await client.query(
          'UPDATE tickets SET scanned_at = $1 WHERE code = $2 AND scanned_at IS NULL RETURNING *',
          [ts, ticket.code]
        );
        return {
          found: true,
          newlyScanned: updated.length > 0,
          ticket: await hydrateTicket(updated[0] || ticket, client),
        };
      }

      return {
        found: true,
        newlyScanned: false,
        ticket: await hydrateTicket(ticket, client),
      };
    });
  }

  async function editTicket(code, updates = {}) {
    const cleanCode = String(code || '').trim();
    const { rows } = await pool.query('SELECT * FROM tickets WHERE code = $1', [cleanCode]);
    const existing = rows[0];
    if (!existing) return null;
    if (!ACTIVE_STATUSES.has(existing.status)) {
      throw new Error('Only active tickets can be edited');
    }

    const nextCar =
      updates.car_number !== undefined ? String(updates.car_number).trim() : existing.car_number;
    const nextCustomer =
      updates.customer_name !== undefined
        ? String(updates.customer_name).trim()
        : existing.customer_name;
    const nextValet =
      updates.valet_number !== undefined ? String(updates.valet_number).trim() : existing.valet_number;
    const nextSpot =
      updates.parking_spot !== undefined ? String(updates.parking_spot).trim() : existing.parking_spot;

    if (!nextCar) throw new Error('car_number is required');
    if (!nextCustomer) throw new Error('customer_name is required');
    if (!nextValet) throw new Error('valet_number is required');

    const { rows: updated } = await pool.query(
      `UPDATE tickets
       SET car_number = $1, customer_name = $2, valet_number = $3, parking_spot = $4
       WHERE code = $5
       RETURNING *`,
      [
        nextCar.slice(0, 120),
        nextCustomer.slice(0, 80),
        nextValet.slice(0, 40),
        nextSpot.slice(0, 40),
        existing.code,
      ]
    );
    return hydrateTicket(updated[0]);
  }

  async function requestPickup(code, customText = 'I am ready to leave') {
    const cleanCode = String(code || '').trim();
    const cleanText = String(customText || '').trim() || 'I am ready to leave';

    return withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM tickets WHERE code = $1 FOR UPDATE', [cleanCode]);
      const ticket = rows[0];
      if (!ticket) return { found: false };

      if (ticket.status === 'parked') {
        const ts = nowIso();
        const { rows: updated } = await client.query(
          "UPDATE tickets SET status = 'requested', requested_at = $1 WHERE code = $2 AND status = 'parked' RETURNING *",
          [ts, ticket.code]
        );
        if (updated.length > 0) {
          await client.query(
            'INSERT INTO messages (ticket_id, sender, body, created_at) VALUES ($1, $2, $3, $4)',
            [ticket.id, 'customer', cleanText.slice(0, 500), ts]
          );
        }
        return {
          found: true,
          alreadyUpdated: updated.length === 0,
          ticket: await hydrateTicket(updated[0] || ticket, client),
          message: 'Your valet has been alerted and is retrieving your car.',
        };
      }

      return {
        found: true,
        alreadyUpdated: true,
        ticket: await hydrateTicket(ticket, client),
        message: getAlreadyRequestedMessage(ticket.status),
      };
    });
  }

  async function addCustomerMessage(code, body) {
    const cleanBody = String(body || '').trim();
    if (!cleanBody) throw new Error('Message cannot be empty');
    const cleanCode = String(code || '').trim();

    return withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM tickets WHERE code = $1 FOR UPDATE', [cleanCode]);
      const ticket = rows[0];
      if (!ticket) return { found: false };
      if (!ACTIVE_STATUSES.has(ticket.status)) {
        throw new Error('Cannot send messages on a closed ticket');
      }

      const ts = nowIso();
      let statusChanged = false;
      let latestTicket = ticket;
      if (ticket.status === 'parked') {
        const { rows: updated } = await client.query(
          "UPDATE tickets SET status = 'requested', requested_at = $1 WHERE code = $2 AND status = 'parked' RETURNING *",
          [ts, ticket.code]
        );
        if (updated.length > 0) {
          statusChanged = true;
          latestTicket = updated[0];
        }
      }

      await client.query(
        'INSERT INTO messages (ticket_id, sender, body, created_at) VALUES ($1, $2, $3, $4)',
        [ticket.id, 'customer', cleanBody.slice(0, 500), ts]
      );

      return {
        found: true,
        statusChanged,
        ticket: await hydrateTicket(latestTicket, client),
      };
    });
  }

  async function addWorkerMessage(code, body) {
    const cleanBody = String(body || '').trim();
    if (!cleanBody) throw new Error('Message cannot be empty');
    const cleanCode = String(code || '').trim();

    return withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM tickets WHERE code = $1 FOR UPDATE', [cleanCode]);
      const ticket = rows[0];
      if (!ticket) return { found: false };
      if (!ACTIVE_STATUSES.has(ticket.status)) {
        throw new Error('Cannot send messages on a closed ticket');
      }

      await client.query(
        'INSERT INTO messages (ticket_id, sender, body, created_at) VALUES ($1, $2, $3, $4)',
        [ticket.id, 'worker', cleanBody.slice(0, 500), nowIso()]
      );

      return {
        found: true,
        ticket: await hydrateTicket(ticket, client),
      };
    });
  }

  async function markAtEntrance(code, customMessage = '') {
    const cleanCode = String(code || '').trim();
    return withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM tickets WHERE code = $1 FOR UPDATE', [cleanCode]);
      const ticket = rows[0];
      if (!ticket) return { found: false };

      if (ticket.status === 'parked' || ticket.status === 'requested') {
        const ts = nowIso();
        const { rows: updated } = await client.query(
          `UPDATE tickets
           SET status = 'at_entrance',
               requested_at = COALESCE(requested_at, $1),
               at_entrance_at = $2
           WHERE code = $3 AND status IN ('parked', 'requested')
           RETURNING *`,
          [ts, ts, ticket.code]
        );
        if (updated.length > 0) {
          const msg = buildEntranceMessage(ticket.car_number, ticket.valet_number, customMessage);
          await client.query(
            'INSERT INTO messages (ticket_id, sender, body, created_at) VALUES ($1, $2, $3, $4)',
            [ticket.id, 'worker', msg, ts]
          );
        }
        return {
          found: true,
          alreadyUpdated: updated.length === 0,
          ticket: await hydrateTicket(updated[0] || ticket, client),
          message: updated.length > 0 ? 'Car marked as ready at entrance.' : 'Already updated by another worker.',
        };
      }

      return {
        found: true,
        alreadyUpdated: true,
        ticket: await hydrateTicket(ticket, client),
        message: getAlreadyEntranceMessage(ticket.status),
      };
    });
  }

  async function markCompleted(code) {
    const cleanCode = String(code || '').trim();
    return withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM tickets WHERE code = $1 FOR UPDATE', [cleanCode]);
      const ticket = rows[0];
      if (!ticket) return { found: false };

      if (ACTIVE_STATUSES.has(ticket.status)) {
        const ts = nowIso();
        const { rows: updated } = await client.query(
          `UPDATE tickets
           SET status = 'completed',
               completed_at = $1
           WHERE code = $2 AND status IN ('parked', 'requested', 'at_entrance')
           RETURNING *`,
          [ts, ticket.code]
        );
        if (updated.length > 0) {
          await client.query(
            'INSERT INTO messages (ticket_id, sender, body, created_at) VALUES ($1, $2, $3, $4)',
            [ticket.id, 'system', 'Keys handed over. Have a safe drive!', ts]
          );
        }
        return {
          found: true,
          alreadyUpdated: updated.length === 0,
          ticket: await hydrateTicket(updated[0] || ticket, client),
          message: updated.length > 0 ? 'Handover completed.' : 'Already completed by another worker.',
        };
      }

      return {
        found: true,
        alreadyUpdated: true,
        ticket: await hydrateTicket(ticket, client),
        message:
          ticket.status === 'cancelled'
            ? 'This ticket was already cancelled.'
            : 'Already marked as picked up by another worker.',
      };
    });
  }

  async function cancelTicket(code, pin) {
    if (!(await verifyPin(pin))) {
      return { ok: false, reason: 'invalid_pin' };
    }
    const cleanCode = String(code || '').trim();

    return withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM tickets WHERE code = $1 FOR UPDATE', [cleanCode]);
      const ticket = rows[0];
      if (!ticket) return { ok: true, found: false };

      if (ACTIVE_STATUSES.has(ticket.status)) {
        const ts = nowIso();
        const { rows: updated } = await client.query(
          `UPDATE tickets
           SET status = 'cancelled',
               cancelled_at = $1
           WHERE code = $2 AND status IN ('parked', 'requested', 'at_entrance')
           RETURNING *`,
          [ts, ticket.code]
        );
        if (updated.length > 0) {
          await client.query(
            'INSERT INTO messages (ticket_id, sender, body, created_at) VALUES ($1, $2, $3, $4)',
            [ticket.id, 'system', 'This ticket was cancelled and your keys were returned.', ts]
          );
        }
        return {
          ok: true,
          found: true,
          alreadyUpdated: updated.length === 0,
          ticket: await hydrateTicket(updated[0] || ticket, client),
          message: updated.length > 0 ? 'Ticket cancelled.' : 'Already cancelled by another worker.',
        };
      }

      return {
        ok: true,
        found: true,
        alreadyUpdated: true,
        ticket: await hydrateTicket(ticket, client),
        message:
          ticket.status === 'completed'
            ? 'Ticket was already completed.'
            : 'Ticket was already cancelled.',
      };
    });
  }

  async function close() {
    await pool.end();
  }

  return {
    init,
    getSettings,
    updateSettings,
    verifyPin,
    getSessionSecret,
    getMessages,
    getTicketByCode,
    listTickets,
    createTicket,
    markScanned,
    editTicket,
    requestPickup,
    addCustomerMessage,
    addWorkerMessage,
    markAtEntrance,
    markCompleted,
    cancelTicket,
    close,
  };
}
