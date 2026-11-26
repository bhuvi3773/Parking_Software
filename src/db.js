import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

/**
 * Create and initialize the SQLite-backed valet ticket & chat store.
 * @param {string} dbPath - File path or ':memory:' for in-memory database.
 * @param {{ defaultPin?: string }} [options]
 */
export function createValetDb(dbPath = 'data/valet.db', options = {}) {
  const defaultPin = String(options.defaultPin || process.env.VALET_PIN || '1234');

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  const existingCols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  const needsLegacyMigration = existingCols.length > 0 && !existingCols.includes('car_number');
  if (needsLegacyMigration) {
    db.exec('ALTER TABLE tickets RENAME TO tickets_legacy;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `);

  if (needsLegacyMigration) {
    db.exec(`
      INSERT INTO tickets (
        id, ticket_number, code, car_number, customer_name, valet_number, parking_spot,
        status, created_at, requested_at, at_entrance_at, completed_at, cancelled_at
      )
      SELECT
        id,
        ticket_number,
        code,
        vehicle,
        COALESCE(NULLIF(TRIM(guest_name), ''), 'Guest'),
        COALESCE(NULLIF(TRIM(key_hook), ''), CAST(ticket_number AS TEXT)),
        COALESCE(parking_spot, ''),
        status,
        created_at,
        requested_at,
        at_entrance_at,
        completed_at,
        cancelled_at
      FROM tickets_legacy;

      INSERT INTO messages (ticket_id, sender, body, created_at)
      SELECT
        id,
        'worker',
        'Hi ' || customer_name || '! Your car (' || car_number || ') is parked under Valet #' || valet_number || '. Send "I am ready to leave" whenever you want your car at the entrance.',
        created_at
      FROM tickets;

      DROP TABLE tickets_legacy;
    `);
  }

  const isDefaultPin = defaultPin === '1234' ? 'true' : 'false';
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('hotel_name', 'Grand Valet');
  insertSetting.run('valet_whatsapp_phone', '');
  insertSetting.run('valet_pin_hash', hashPin(defaultPin));
  insertSetting.run('is_default_pin', isDefaultPin);
  insertSetting.run('session_secret', crypto.randomBytes(32).toString('hex'));

  const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsertSettingStmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const getTicketByCodeStmt = db.prepare('SELECT * FROM tickets WHERE code = ?');
  const getMessagesStmt = db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id ASC');
  const insertMessageStmt = db.prepare(
    'INSERT INTO messages (ticket_id, sender, body, created_at) VALUES (?, ?, ?, ?)'
  );
  const getMaxTicketNumberStmt = db.prepare('SELECT COALESCE(MAX(ticket_number), 100) AS max_num FROM tickets');
  const insertTicketStmt = db.prepare(`
    INSERT INTO tickets (
      ticket_number, code, car_number, customer_name, valet_number, parking_spot, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'parked', ?)
  `);

  function getSettingSync(key, fallback = '') {
    const row = getSettingStmt.get(key);
    return row ? row.value : fallback;
  }

  function getSettingsSync() {
    return {
      hotel_name: getSettingSync('hotel_name', 'Grand Valet'),
      valet_whatsapp_phone: getSettingSync('valet_whatsapp_phone', ''),
      is_default_pin: getSettingSync('is_default_pin', 'true') === 'true',
    };
  }

  function verifyPinSync(pin) {
    if (typeof pin !== 'string' && typeof pin !== 'number') return false;
    const trimmed = String(pin).trim();
    if (!trimmed) return false;
    return checkPinHash(trimmed, getSettingSync('valet_pin_hash'));
  }

  function hydrateTicket(ticket) {
    if (!ticket) return null;
    return {
      ...ticket,
      messages: getMessagesStmt.all(ticket.id),
    };
  }

  async function init() {
    // SQLite schema initializes synchronously above.
  }

  async function getSessionSecret() {
    return getSettingSync('session_secret');
  }

  async function getSettings() {
    return getSettingsSync();
  }

  async function verifyPin(pin) {
    return verifyPinSync(pin);
  }

  async function updateSettings({ hotel_name, valet_whatsapp_phone, valet_pin } = {}) {
    if (hotel_name !== undefined) {
      const cleaned = String(hotel_name).trim();
      if (!cleaned) {
        throw new Error('hotel_name cannot be empty');
      }
      upsertSettingStmt.run('hotel_name', cleaned.slice(0, 80));
    }
    if (valet_whatsapp_phone !== undefined) {
      upsertSettingStmt.run('valet_whatsapp_phone', normalizePhone(valet_whatsapp_phone));
    }
    if (valet_pin !== undefined && String(valet_pin).trim() !== '') {
      const nextPin = String(valet_pin).trim();
      if (nextPin.length < 4 || nextPin.length > 12) {
        throw new Error('valet_pin must be 4 to 12 characters');
      }
      upsertSettingStmt.run('valet_pin_hash', hashPin(nextPin));
      upsertSettingStmt.run('is_default_pin', 'false');
    }
    return getSettingsSync();
  }

  async function getMessages(ticketId) {
    return getMessagesStmt.all(ticketId);
  }

  async function getTicketByCode(code) {
    if (!code) return null;
    return hydrateTicket(getTicketByCodeStmt.get(String(code).trim()));
  }

  async function listTickets() {
    const activeRows = db
      .prepare(
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
      )
      .all();

    const historyRows = db
      .prepare(
        `SELECT * FROM tickets
         WHERE status IN ('completed', 'cancelled')
         ORDER BY COALESCE(completed_at, cancelled_at, created_at) DESC, id DESC
         LIMIT 25`
      )
      .all();

    const { max_num } = getMaxTicketNumberStmt.get();
    return {
      active: activeRows.map(hydrateTicket),
      history: historyRows.map(hydrateTicket),
      next_valet_number: String(Number(max_num) + 1),
    };
  }

  async function createTicket({ car_number, customer_name, valet_number = '', parking_spot = '' }) {
    const cleanCar = String(car_number || '').trim();
    const cleanCustomer = String(customer_name || '').trim();
    const cleanSpot = String(parking_spot || '').trim();

    if (!cleanCar) throw new Error('car_number is required');
    if (!cleanCustomer) throw new Error('customer_name is required');

    db.exec('BEGIN IMMEDIATE');
    try {
      const { max_num } = getMaxTicketNumberStmt.get();
      const ticketNumber = Number(max_num) + 1;
      const cleanValet = String(valet_number || '').trim() || String(ticketNumber);

      let code = generateTicketCode();
      while (getTicketByCodeStmt.get(code)) {
        code = generateTicketCode();
      }
      const createdAt = nowIso();
      const info = insertTicketStmt.run(
        ticketNumber,
        code,
        cleanCar.slice(0, 120),
        cleanCustomer.slice(0, 80),
        cleanValet.slice(0, 40),
        cleanSpot.slice(0, 40),
        createdAt
      );

      const hotelName = getSettingSync('hotel_name', 'Grand Valet');
      const hiMessage = buildWelcomeMessage(cleanCustomer, hotelName, cleanCar, cleanValet);
      insertMessageStmt.run(info.lastInsertRowid, 'worker', hiMessage, createdAt);

      db.exec('COMMIT');
      return hydrateTicket(getTicketByCodeStmt.get(code));
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async function markScanned(code) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const ticket = getTicketByCodeStmt.get(String(code || '').trim());
      if (!ticket) {
        db.exec('ROLLBACK');
        return { found: false };
      }

      if (!ticket.scanned_at) {
        const ts = nowIso();
        const res = db
          .prepare('UPDATE tickets SET scanned_at = ? WHERE code = ? AND scanned_at IS NULL')
          .run(ts, ticket.code);
        db.exec('COMMIT');
        return {
          found: true,
          newlyScanned: res.changes > 0,
          ticket: hydrateTicket(getTicketByCodeStmt.get(ticket.code)),
        };
      }

      db.exec('COMMIT');
      return {
        found: true,
        newlyScanned: false,
        ticket: hydrateTicket(ticket),
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async function editTicket(code, updates = {}) {
    const existing = getTicketByCodeStmt.get(String(code || '').trim());
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

    db.prepare(
      `UPDATE tickets
       SET car_number = ?, customer_name = ?, valet_number = ?, parking_spot = ?
       WHERE code = ?`
    ).run(
      nextCar.slice(0, 120),
      nextCustomer.slice(0, 80),
      nextValet.slice(0, 40),
      nextSpot.slice(0, 40),
      existing.code
    );

    return hydrateTicket(getTicketByCodeStmt.get(existing.code));
  }

  async function requestPickup(code, customText = 'I am ready to leave') {
    const cleanText = String(customText || '').trim() || 'I am ready to leave';

    db.exec('BEGIN IMMEDIATE');
    try {
      const ticket = getTicketByCodeStmt.get(String(code || '').trim());
      if (!ticket) {
        db.exec('ROLLBACK');
        return { found: false };
      }

      if (ticket.status === 'parked') {
        const ts = nowIso();
        const res = db
          .prepare(`UPDATE tickets SET status = 'requested', requested_at = ? WHERE code = ? AND status = 'parked'`)
          .run(ts, ticket.code);
        if (res.changes > 0) {
          insertMessageStmt.run(ticket.id, 'customer', cleanText.slice(0, 500), ts);
        }
        db.exec('COMMIT');
        return {
          found: true,
          alreadyUpdated: res.changes === 0,
          ticket: hydrateTicket(getTicketByCodeStmt.get(ticket.code)),
          message: 'Your valet has been alerted and is retrieving your car.',
        };
      }

      db.exec('COMMIT');
      return {
        found: true,
        alreadyUpdated: true,
        ticket: hydrateTicket(ticket),
        message: getAlreadyRequestedMessage(ticket.status),
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async function addCustomerMessage(code, body) {
    const cleanBody = String(body || '').trim();
    if (!cleanBody) throw new Error('Message cannot be empty');

    db.exec('BEGIN IMMEDIATE');
    try {
      const ticket = getTicketByCodeStmt.get(String(code || '').trim());
      if (!ticket) {
        db.exec('ROLLBACK');
        return { found: false };
      }
      if (!ACTIVE_STATUSES.has(ticket.status)) {
        db.exec('ROLLBACK');
        throw new Error('Cannot send messages on a closed ticket');
      }

      const ts = nowIso();
      let statusChanged = false;
      if (ticket.status === 'parked') {
        const res = db
          .prepare(`UPDATE tickets SET status = 'requested', requested_at = ? WHERE code = ? AND status = 'parked'`)
          .run(ts, ticket.code);
        statusChanged = res.changes > 0;
      }

      insertMessageStmt.run(ticket.id, 'customer', cleanBody.slice(0, 500), ts);
      db.exec('COMMIT');
      return {
        found: true,
        statusChanged,
        ticket: hydrateTicket(getTicketByCodeStmt.get(ticket.code)),
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async function addWorkerMessage(code, body) {
    const cleanBody = String(body || '').trim();
    if (!cleanBody) throw new Error('Message cannot be empty');

    db.exec('BEGIN IMMEDIATE');
    try {
      const ticket = getTicketByCodeStmt.get(String(code || '').trim());
      if (!ticket) {
        db.exec('ROLLBACK');
        return { found: false };
      }
      if (!ACTIVE_STATUSES.has(ticket.status)) {
        db.exec('ROLLBACK');
        throw new Error('Cannot send messages on a closed ticket');
      }

      insertMessageStmt.run(ticket.id, 'worker', cleanBody.slice(0, 500), nowIso());
      db.exec('COMMIT');
      return {
        found: true,
        ticket: hydrateTicket(getTicketByCodeStmt.get(ticket.code)),
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async function markAtEntrance(code, customMessage = '') {
    db.exec('BEGIN IMMEDIATE');
    try {
      const ticket = getTicketByCodeStmt.get(String(code || '').trim());
      if (!ticket) {
        db.exec('ROLLBACK');
        return { found: false };
      }

      if (ticket.status === 'parked' || ticket.status === 'requested') {
        const ts = nowIso();
        const res = db
          .prepare(
            `UPDATE tickets
             SET status = 'at_entrance',
                 requested_at = COALESCE(requested_at, ?),
                 at_entrance_at = ?
             WHERE code = ? AND status IN ('parked', 'requested')`
          )
          .run(ts, ts, ticket.code);

        if (res.changes > 0) {
          const msg = buildEntranceMessage(ticket.car_number, ticket.valet_number, customMessage);
          insertMessageStmt.run(ticket.id, 'worker', msg, ts);
        }

        db.exec('COMMIT');
        return {
          found: true,
          alreadyUpdated: res.changes === 0,
          ticket: hydrateTicket(getTicketByCodeStmt.get(ticket.code)),
          message: res.changes > 0 ? 'Car marked as ready at entrance.' : 'Already updated by another worker.',
        };
      }

      db.exec('COMMIT');
      return {
        found: true,
        alreadyUpdated: true,
        ticket: hydrateTicket(ticket),
        message: getAlreadyEntranceMessage(ticket.status),
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async function markCompleted(code) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const ticket = getTicketByCodeStmt.get(String(code || '').trim());
      if (!ticket) {
        db.exec('ROLLBACK');
        return { found: false };
      }

      if (ACTIVE_STATUSES.has(ticket.status)) {
        const ts = nowIso();
        const res = db
          .prepare(
            `UPDATE tickets
             SET status = 'completed',
                 completed_at = ?
             WHERE code = ? AND status IN ('parked', 'requested', 'at_entrance')`
          )
          .run(ts, ticket.code);
        if (res.changes > 0) {
          insertMessageStmt.run(ticket.id, 'system', 'Keys handed over. Have a safe drive!', ts);
        }
        db.exec('COMMIT');
        return {
          found: true,
          alreadyUpdated: res.changes === 0,
          ticket: hydrateTicket(getTicketByCodeStmt.get(ticket.code)),
          message: res.changes > 0 ? 'Handover completed.' : 'Already completed by another worker.',
        };
      }

      db.exec('COMMIT');
      return {
        found: true,
        alreadyUpdated: true,
        ticket: hydrateTicket(ticket),
        message:
          ticket.status === 'cancelled'
            ? 'This ticket was already cancelled.'
            : 'Already marked as picked up by another worker.',
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async function cancelTicket(code, pin) {
    if (!verifyPinSync(pin)) {
      return { ok: false, reason: 'invalid_pin' };
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const ticket = getTicketByCodeStmt.get(String(code || '').trim());
      if (!ticket) {
        db.exec('ROLLBACK');
        return { ok: true, found: false };
      }

      if (ACTIVE_STATUSES.has(ticket.status)) {
        const ts = nowIso();
        const res = db
          .prepare(
            `UPDATE tickets
             SET status = 'cancelled',
                 cancelled_at = ?
             WHERE code = ? AND status IN ('parked', 'requested', 'at_entrance')`
          )
          .run(ts, ticket.code);
        if (res.changes > 0) {
          insertMessageStmt.run(
            ticket.id,
            'system',
            'This ticket was cancelled and your keys were returned.',
            ts
          );
        }
        db.exec('COMMIT');
        return {
          ok: true,
          found: true,
          alreadyUpdated: res.changes === 0,
          ticket: hydrateTicket(getTicketByCodeStmt.get(ticket.code)),
          message: res.changes > 0 ? 'Ticket cancelled.' : 'Already cancelled by another worker.',
        };
      }

      db.exec('COMMIT');
      return {
        ok: true,
        found: true,
        alreadyUpdated: true,
        ticket: hydrateTicket(ticket),
        message:
          ticket.status === 'completed'
            ? 'Ticket was already completed.'
            : 'Ticket was already cancelled.',
      };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async function close() {
    db.close();
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
