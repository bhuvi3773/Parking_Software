# QR Valet Chat

A free, zero-API two-sided hotel valet application (**Worker Side** + **Customer Side**).

## Local Run

```bash
npm install
npm start
```

Open `http://localhost:4100` (default Valet PIN: `1234`).

## 24/7 Cloud Deploy (Railway — No Credit Card Required on Free Plan)

1. Go to [Railway](https://railway.app/new) → **Deploy from GitHub repo** → choose `bhuvi3773/Parking_Software`.
   - Railway automatically picks up `Dockerfile` (Node 24) and `railway.json` (`/api/health` check).
2. Open your service **Settings → Volumes → + New Volume** and set the mount path to `/data`.
3. Open **Variables** and add:
   - `VALET_DB_PATH=/data/valet.db`
   - `VALET_PIN=<your-4-to-12-char-pin>`
4. Open **Settings → Networking → Generate Domain** to get your permanent `https://...up.railway.app` URL.
   - Keep instance replicas at `1` so all requests share the SQLite volume.

## Environment Variables (Optional)

- `PORT` (default `4100`, automatically injected by Railway/Fly)
- `VALET_DB_PATH` (default `data/valet.db`, set `/data/valet.db` in cloud volumes)
- `VALET_PIN` (default `1234` on fresh DB creation; can also be changed inside Settings)
