import crypto from 'node:crypto';

export const ACTIVE_STATUSES = new Set(['parked', 'requested', 'at_entrance']);

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

export function checkPinHash(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expectedHex] = stored.split(':');
  const derived = crypto.scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d]/g, '');
}

export function generateTicketCode() {
  return crypto.randomBytes(6).toString('base64url');
}

export function nowIso() {
  return new Date().toISOString();
}

export function buildWelcomeMessage(customerName, hotelName, carNumber, valetNumber) {
  return `Hi ${customerName}! Welcome to ${hotelName}. Your car (${carNumber}) is safely parked under Valet #${valetNumber}. Send "I am ready to leave" here whenever you want your car at the entrance.`;
}

export function buildEntranceMessage(carNumber, valetNumber, customMessage = '') {
  const cleaned = String(customMessage || '').trim();
  if (cleaned) return cleaned.slice(0, 500);
  return `Your car (${carNumber}, Valet #${valetNumber}) is ready at the entrance! Please collect your keys and have a safe drive.`;
}

export function getAlreadyRequestedMessage(status) {
  const messages = {
    requested: 'Your valet has already been alerted and is on the way to get your car.',
    at_entrance: 'Your car is already waiting at the entrance!',
    completed: 'This ticket is already completed. Thanks for visiting!',
    cancelled: 'This ticket was cancelled and your keys were returned.',
  };
  return messages[status] || 'Ticket status unchanged.';
}

export function getAlreadyEntranceMessage(status) {
  const messages = {
    at_entrance: 'Already marked at entrance by another worker.',
    completed: 'This ticket was already marked as picked up.',
    cancelled: 'This ticket was already cancelled.',
  };
  return messages[status] || 'Already updated.';
}
