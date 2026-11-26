import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STORE_METHODS = [
  'getSettings',
  'updateSettings',
  'verifyPin',
  'getSessionSecret',
  'getMessages',
  'getTicketByCode',
  'listTickets',
  'createTicket',
  'markScanned',
  'editTicket',
  'requestPickup',
  'addCustomerMessage',
  'addWorkerMessage',
  'markAtEntrance',
  'markCompleted',
  'cancelTicket',
];

/**
 * Create the appropriate store lazily so Vercel serverless functions never load node:sqlite.
 */
export function createStore({ env = process.env, dbPath } = {}) {
  const usePostgres = Boolean(env.DATABASE_URL);
  if (!usePostgres && env.VERCEL) {
    throw new Error('Missing DATABASE_URL environment variable for Vercel deployment');
  }

  const sqlitePath = dbPath || env.VALET_DB_PATH || path.join(__dirname, '..', 'data', 'valet.db');
  const defaultPin = env.VALET_PIN;

  let implPromise = null;

  async function ensureImpl() {
    if (!implPromise) {
      implPromise = (async () => {
        const impl = usePostgres
          ? (await import('./db-pg.js')).createPostgresStore(env.DATABASE_URL, { defaultPin })
          : (await import('./db.js')).createValetDb(sqlitePath, { defaultPin });
        await impl.init();
        return impl;
      })().catch((err) => {
        implPromise = null;
        throw err;
      });
    }
    return implPromise;
  }

  const store = {
    async init() {
      await ensureImpl();
    },
    async close() {
      if (!implPromise) return;
      const impl = await implPromise;
      await impl.close();
      implPromise = null;
    },
  };

  for (const method of STORE_METHODS) {
    store[method] = async (...args) => {
      const impl = await ensureImpl();
      return impl[method](...args);
    };
  }

  return store;
}
