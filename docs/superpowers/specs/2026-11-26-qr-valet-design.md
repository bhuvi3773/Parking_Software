# Two-Sided QR Valet Chat Application Design

**Date:** 2026-11-26  
**Approach:** Approach 2 — Zero-API QR-to-Web Chat (Worker Side + Customer Side)

---

## 1. Intent & Why

Recreate the exact hotel valet experience completely free with zero external APIs, structured cleanly into **two connected sides**:

1. **Worker Side (`/`):** The valet receives the customer's keys, enters **Car Number**, **Customer Name**, and **Valet Number** (key tag number, auto-assigned or custom, plus optional Parking Spot), and immediately generates and displays a **QR code** right on the Worker screen.
2. **Customer Side (`/t/:code`):** The customer scans the QR code on their phone and immediately sees a WhatsApp-style chat thread starting with an automated **"Hi" message** showing their **Car Number**, **Customer Name**, and **Valet Number**.
3. **Leaving Flow:** When ready to leave, the customer sends **"I am ready to leave"** (via quick button or chat box). The worker immediately receives the message along with the **Car Number**, **Customer Name**, and **Valet Number**, retrieves the keys and car, places the car at the entrance, and sends the **"Car is ready at the entrance"** message straight into the customer's chat.

---

## 2. Core Workflow & States

### Ticket Lifecycle States
`parked` → `requested` → `at_entrance` → `completed` (or `cancelled` from any active state)

1. **Drop-off (`parked`):**
   - Worker submits `car_number`, `customer_name`, `valet_number` (defaults to sequential tag `#101+` if left auto), and optional `parking_spot`.
   - Backend creates the ticket and automatically inserts the initial **Hi message** from the worker/valet into `messages`:
     > *"Hi [Customer Name]! Welcome to [Hotel Name]. Your car ([Car Number]) is safely parked under Valet #[Valet Number]. Message 'I am ready to leave' here whenever you want your car at the entrance."*
   - Worker screen displays the QR code inline right away so the customer can scan immediately.
2. **QR Scan Receipt:**
   - When the customer opens `/t/:code`, `GET /api/tickets/:code` marks `scanned_at` (if not already set) and notifies the worker in real time (`"Customer scanned QR ✓"`).
3. **Customer Ready to Leave (`requested`):**
   - Customer taps the quick-send **"I am ready to leave"** button (`POST /api/tickets/:code/request`) or sends a chat message (`POST /api/tickets/:code/messages`).
   - If `parked`, `status` becomes `requested`, the customer's message is stored in `messages`, and SSE alerts all open Worker screens (with optional sound chime).
   - If `status` is already `requested`, `at_entrance`, `completed`, or `cancelled`, tapping **"I am ready to leave"** again is a safe `200 OK` no-op with a friendly status notice.
4. **Car Placed at Entrance (`at_entrance`):**
   - Worker finds the keys via `Valet Number` and `Car Number`, stages the car at the entrance, and clicks **"Car Ready at Entrance"** (`POST /api/tickets/:code/entrance`, with optional custom message text).
   - Backend updates status to `at_entrance`, appends the entrance message to `messages`, and pushes both the updated ticket and new message to the Customer Side via SSE.
   - Concurrent taps by two workers resolve gracefully (`200 OK`, `alreadyUpdated: true`).
5. **Pickup / Edits / Cancellation:**
   - **Mark Picked Up (`POST /api/tickets/:code/complete`):** Closes the ticket after handover (`completed`).
   - **Edit Details (`PATCH /api/tickets/:code`):** Fixes typos in `car_number`, `customer_name`, `valet_number`, or `parking_spot` on active tickets and broadcasts updates.
   - **Cancel / Void (`POST /api/tickets/:code/cancel`):** Requires Valet PIN confirmation (`pin` in request body) and notifies the customer chat that keys were returned.

---

## 3. Data Model (`data/valet.db` via `node:sqlite`)

- `tickets`:
  - `id`, `ticket_number` (sequential integer `101+`), `code` (8-char URL-safe token)
  - `car_number` (TEXT NOT NULL), `customer_name` (TEXT NOT NULL), `valet_number` (TEXT NOT NULL), `parking_spot` (TEXT NOT NULL DEFAULT `''`)
  - `status` (`parked` | `requested` | `at_entrance` | `completed` | `cancelled`)
  - `created_at`, `scanned_at`, `requested_at`, `at_entrance_at`, `completed_at`, `cancelled_at`
- `messages`:
  - `id`, `ticket_id` (FK → `tickets.id`), `sender` (`worker` | `customer` | `system`), `body`, `created_at`
- `settings`:
  - `hotel_name`, `valet_whatsapp_phone`, `valet_pin_hash`, `is_default_pin`, `session_secret`

---

## 4. Access Control & Real-Time SSE

- **Worker Side (`/` and valet APIs):** Protected by Valet PIN (`1234` default) via signed `HttpOnly` cookie. Cancel/void also re-checks the PIN.
- **Customer Side (`/t/:code` and public ticket/message endpoints):** Scoped by the random 8-char `code`; exposes public ticket fields (`ticket_number`, `valet_number`, `car_number`, `customer_name`, `status`, timestamps) + `messages` thread + optional `wa_me_url`, while keeping internal `parking_spot` private to the worker.
- **SSE Streams:**
  - `GET /api/events` (worker): receives `ticket` (full ticket + latest messages) and `settings` events.
  - `GET /api/tickets/:code/events` (customer): receives `ticket` (sanitized guest ticket + messages) and `settings` events.
