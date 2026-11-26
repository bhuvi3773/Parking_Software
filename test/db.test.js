import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createValetDb } from '../src/db.js';
import { createStore } from '../src/store.js';

describe('Valet SQLite Store & Chat State Machine', () => {
  let store;

  beforeEach(async () => {
    store = createValetDb(':memory:', { defaultPin: '1234' });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('initializes default settings and verifies default PIN', async () => {
    const settings = await store.getSettings();
    assert.equal(settings.hotel_name, 'Grand Valet');
    assert.equal(settings.valet_whatsapp_phone, '');
    assert.equal(settings.is_default_pin, true);
    assert.equal(await store.verifyPin('1234'), true);
    assert.equal(await store.verifyPin('0000'), false);
  });

  it('creates ticket with auto-assigned valet_number, initial Hi message, and 8-char code', async () => {
    const t1 = await store.createTicket({
      car_number: 'KA01-AB-1234',
      customer_name: 'Riya',
    });
    const t2 = await store.createTicket({
      car_number: 'MH02-XY-9999',
      customer_name: 'Arjun',
      valet_number: 'V-14',
      parking_spot: 'B2-08',
    });

    assert.equal(t1.ticket_number, 101);
    assert.equal(t1.valet_number, '101');
    assert.equal(t1.car_number, 'KA01-AB-1234');
    assert.equal(t1.customer_name, 'Riya');
    assert.equal(t1.parking_spot, '');
    assert.equal(t1.status, 'parked');
    assert.match(t1.code, /^[A-Za-z0-9_-]{8}$/);

    const msgs = await store.getMessages(t1.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].sender, 'worker');
    assert.match(msgs[0].body, /Hi Riya/i);
    assert.match(msgs[0].body, /KA01-AB-1234/);
    assert.match(msgs[0].body, /101/);

    assert.equal(t2.ticket_number, 102);
    assert.equal(t2.valet_number, 'V-14');
    assert.equal(t2.parking_spot, 'B2-08');
  });

  it('rejects ticket creation when car_number or customer_name is missing', async () => {
    await assert.rejects(
      () => store.createTicket({ car_number: '', customer_name: 'Riya' }),
      /car_number/i
    );
    await assert.rejects(
      () => store.createTicket({ car_number: 'KA01-1234', customer_name: '' }),
      /customer_name/i
    );
  });

  it('records QR scan timestamp once without overwriting later scans', async () => {
    const t = await store.createTicket({ car_number: 'KA01-1234', customer_name: 'Riya' });
    assert.equal(t.scanned_at, null);

    const firstScan = await store.markScanned(t.code);
    assert.equal(firstScan.newlyScanned, true);
    assert.ok(firstScan.ticket.scanned_at);

    const secondScan = await store.markScanned(t.code);
    assert.equal(secondScan.newlyScanned, false);
    assert.equal(secondScan.ticket.scanned_at, firstScan.ticket.scanned_at);
  });

  it('edits car_number, customer_name, valet_number, and parking_spot on active tickets only', async () => {
    const created = await store.createTicket({
      car_number: 'KA01-0001',
      customer_name: 'Alex',
      valet_number: '101',
      parking_spot: 'B1-01',
    });

    const edited = await store.editTicket(created.code, {
      car_number: 'KA01-9999',
      customer_name: 'Alex M.',
      valet_number: 'V-09',
      parking_spot: 'B2-11',
    });

    assert.equal(edited.car_number, 'KA01-9999');
    assert.equal(edited.customer_name, 'Alex M.');
    assert.equal(edited.valet_number, 'V-09');
    assert.equal(edited.parking_spot, 'B2-11');

    await store.markCompleted(created.code);
    await assert.rejects(
      () => store.editTicket(created.code, { car_number: 'Changed' }),
      /active/i
    );
  });

  it('appends customer ready-to-leave message and handles double-taps idempotently', async () => {
    const t = await store.createTicket({
      car_number: 'DL05-3322',
      customer_name: 'Meera',
      valet_number: '22',
    });

    const first = await store.requestPickup(t.code, 'I am ready to leave');
    assert.equal(first.alreadyUpdated, false);
    assert.equal(first.ticket.status, 'requested');
    assert.ok(first.ticket.requested_at);

    const msgsAfterReq = await store.getMessages(t.id);
    assert.equal(msgsAfterReq.length, 2);
    assert.equal(msgsAfterReq[1].sender, 'customer');
    assert.equal(msgsAfterReq[1].body, 'I am ready to leave');

    const second = await store.requestPickup(t.code, 'I am ready to leave');
    assert.equal(second.alreadyUpdated, true);
    assert.equal(second.ticket.status, 'requested');
    assert.equal((await store.getMessages(t.id)).length, 2);

    await store.markAtEntrance(t.code);
    const msgsAtEnt = await store.getMessages(t.id);
    assert.equal(msgsAtEnt.length, 3);
    assert.equal(msgsAtEnt[2].sender, 'worker');
    assert.match(msgsAtEnt[2].body, /entrance/i);

    const afterEntrance = await store.requestPickup(t.code);
    assert.equal(afterEntrance.alreadyUpdated, true);
    assert.match(afterEntrance.message, /entrance/i);
  });

  it('supports sending follow-up chat messages between customer and worker', async () => {
    const t = await store.createTicket({
      car_number: 'KA03-7788',
      customer_name: 'Dev',
    });

    const cMsg = await store.addCustomerMessage(t.code, 'Hi, please bring my car in 2 mins');
    assert.equal(cMsg.statusChanged, true);
    assert.equal(cMsg.ticket.status, 'requested');

    const wMsg = await store.addWorkerMessage(t.code, 'Bringing it up right now!');
    assert.equal(wMsg.ticket.status, 'requested');

    const msgs = await store.getMessages(t.id);
    assert.equal(msgs.length, 3);
    assert.equal(msgs[1].sender, 'customer');
    assert.equal(msgs[2].sender, 'worker');
  });

  it('handles concurrent valet entrance and complete taps gracefully', async () => {
    const t = await store.createTicket({
      car_number: 'TN09-1111',
      customer_name: 'Sam',
    });
    await store.requestPickup(t.code);

    const ent1 = await store.markAtEntrance(t.code);
    assert.equal(ent1.alreadyUpdated, false);
    assert.equal(ent1.ticket.status, 'at_entrance');

    const ent2 = await store.markAtEntrance(t.code);
    assert.equal(ent2.alreadyUpdated, true);
    assert.equal(ent2.ticket.status, 'at_entrance');

    const comp1 = await store.markCompleted(t.code);
    assert.equal(comp1.alreadyUpdated, false);
    assert.equal(comp1.ticket.status, 'completed');

    const comp2 = await store.markCompleted(t.code);
    assert.equal(comp2.alreadyUpdated, true);
    assert.equal(comp2.ticket.status, 'completed');
  });

  it('requires valid PIN to cancel/void a ticket and appends cancellation message', async () => {
    const t = await store.createTicket({
      car_number: 'KA05-5555',
      customer_name: 'Kiran',
    });

    const bad = await store.cancelTicket(t.code, '9999');
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'invalid_pin');
    assert.equal((await store.getTicketByCode(t.code)).status, 'parked');

    const ok1 = await store.cancelTicket(t.code, '1234');
    assert.equal(ok1.ok, true);
    assert.equal(ok1.alreadyUpdated, false);
    assert.equal(ok1.ticket.status, 'cancelled');

    const msgs = await store.getMessages(t.id);
    assert.match(msgs[msgs.length - 1].body, /cancelled/i);

    const ok2 = await store.cancelTicket(t.code, '1234');
    assert.equal(ok2.ok, true);
    assert.equal(ok2.alreadyUpdated, true);
  });

  it('updates settings including rotating valet PIN', async () => {
    await store.updateSettings({
      hotel_name: 'Hotel Meridian',
      valet_whatsapp_phone: '+91 98765-43210',
      valet_pin: '5678',
    });

    const settings = await store.getSettings();
    assert.equal(settings.hotel_name, 'Hotel Meridian');
    assert.equal(settings.valet_whatsapp_phone, '919876543210');
    assert.equal(settings.is_default_pin, false);
    assert.equal(await store.verifyPin('1234'), false);
    assert.equal(await store.verifyPin('5678'), true);
  });

  it('migrates legacy tickets table cleanly while preserving existing tickets', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');

    const tmpPath = path.join(os.tmpdir(), `valet-migrate-${Date.now()}.db`);
    const legacy = new DatabaseSync(tmpPath);
    legacy.exec(`
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_number INTEGER NOT NULL UNIQUE,
        code TEXT NOT NULL UNIQUE,
        vehicle TEXT NOT NULL,
        key_hook TEXT NOT NULL,
        parking_spot TEXT NOT NULL,
        guest_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        requested_at TEXT,
        at_entrance_at TEXT,
        completed_at TEXT,
        cancelled_at TEXT
      );
      INSERT INTO tickets (ticket_number, code, vehicle, key_hook, parking_spot, guest_name, status, created_at)
      VALUES (101, 'abcd1234', 'KA01-OLD', 'H-07', 'B1-02', 'Legacy Guest', 'parked', '2026-11-26T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = createValetDb(tmpPath);
    await migrated.init();
    const existing = await migrated.getTicketByCode('abcd1234');
    assert.ok(existing);
    assert.equal(existing.car_number, 'KA01-OLD');
    assert.equal(existing.customer_name, 'Legacy Guest');
    assert.equal(existing.valet_number, 'H-07');
    assert.equal(existing.parking_spot, 'B1-02');
    assert.equal(existing.messages.length, 1);

    const next = await migrated.createTicket({ car_number: 'KA02-NEW', customer_name: 'New Guest' });
    assert.equal(next.ticket_number, 102);

    await migrated.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(tmpPath + suffix);
      } catch {
        // ignore missing WAL files
      }
    }
  });

  it('requires DATABASE_URL on Vercel when running serverless store factory', () => {
    assert.throws(
      () => createStore({ env: { VERCEL: '1' } }),
      /DATABASE_URL/
    );
  });
});
