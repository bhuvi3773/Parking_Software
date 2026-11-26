# QR Valet Chat

A free, zero-API two-sided hotel valet application (**Worker Side** + **Customer Side**).

## Local Run (Zero Config — Uses SQLite)

```bash
npm install
npm start
```

Open `http://localhost:4100` (default Valet PIN: `1234`).

## Deploy to Vercel + Neon Postgres (Free — Works Everywhere)

1. Go to [Vercel](https://vercel.com/new), import `bhuvi3773/Parking_Software` from GitHub.
2. Under **Environment Variables**, add:
   - `DATABASE_URL` = your Neon Postgres pooled connection string
   - `VALET_PIN` = your 4–12 digit Valet PIN (for example `5678`)
3. Click **Deploy**. Vercel serves `public/` via CDN, routes `/api/*` to `api/index.js`, and runs `public/valet.html` (`/`) and `public/guest.html` (`/t/:code`).

## Environment Variables

- `DATABASE_URL` — When set, uses PostgreSQL (Neon); when omitted locally, uses local SQLite (`data/valet.db`).
- `VALET_PIN` — Initial Valet PIN when creating a fresh database (default `1234`; also changeable inside Settings).
- `PORT` — Local HTTP port (default `4100`).
- `VALET_DB_PATH` — Custom local SQLite path when `DATABASE_URL` is unset.
