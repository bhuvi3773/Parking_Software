# QR-to-Web-Ticket Valet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-cost, zero-external-API valet parking check-in and pickup web app where guests scan a QR code, see a warm "Hi!" ticket, tap "I am ready to leave", and the valet podium alerts in real time to place the car at the entrance.

**Architecture:** Single Node.js (`v24.13.0`) + Express server backed by built-in `node:sqlite` (`data/valet.db`), server-side `qrcode` SVG/DataURL generation, and Server-Sent Events (SSE) for instant two-way updates between the Valet Podium Console (`/`) and Guest Mobile Ticket (`/t/:code`). Valet endpoints use a lightweight `HttpOnly` signed session cookie unlocked by a configurable Valet PIN (default `1234`), with explicit PIN verification for cancelling/voiding active tickets.

**Tech Stack:** Node.js 24 (`node:sqlite`, `node:test`, `node:crypto`), Express, `qrcode`, vanilla HTML/CSS/ES modules.

**Spec:** `docs/superpowers/specs/2026-11-26-qr-valet-design.md`

## Global Constraints
- Zero external paid APIs, cloud databases, or build steps; runs out of the box via `npm start`.
- Uses `node:sqlite` persisted at `data/valet.db` and `node --test` for automated tests.
- Default Valet PIN is `1234` (or `VALET_PIN` env var) and can be rotated via settings.
- QR codes encode the LAN-reachable base URL when accessed locally so real phones on Wi-Fi can scan and open `/t/:code`.

## Review Focus
- Guest taps "I am ready to leave" twice rapidly or after completion/cancellation -> must be a safe `200 OK` no-op with a friendly message.
- Two valet screens tap "Placed at Entrance" or "Mark Picked Up" concurrently -> second tap returns `200 OK` with `alreadyUpdated: true`, never an error.
- Valet edits vehicle/hook/spot on an active ticket -> updates DB and broadcasts via SSE to both podium and guest view; blocks edits on completed/cancelled tickets.
- Cancel/void ticket without valid PIN -> returns `403` and leaves ticket untouched.
- Guest accesses `/api/tickets` or valet mutations without a session cookie -> returns `401`; guest can only view/request their own `/t/:code` capability URL.

---

### Task 1: Project Scaffold & Dependencies
- Initialize `package.json`, `.gitignore`, and install `express` and `qrcode`.

### Task 2: SQLite Store, PIN Auth & Atomic Ticket State Machine (`src/db.js`)
- TDD (`test/db.test.js` RED -> GREEN): schema setup, PIN hashing/verification, ticket creation (`#101+`, 8-char URL-safe code), `editTicket`, idempotent `requestPickup`, idempotent `markAtEntrance`, idempotent `markCompleted`, PIN-checked `cancelTicket`, and settings (`hotel_name`, `valet_whatsapp_phone`).

### Task 3: Network Resolver, SSE Hub & Express API (`src/network.js`, `src/sse.js`, `src/app.js`, `src/server.js`)
- TDD (`test/api.test.js` RED -> GREEN): health, auth login/logout/session, protected valet routes (`401` when unauthenticated), public guest ticket + idempotent `/request`, SSE real-time broadcasts on `/api/events` and `/api/tickets/:code/events`, QR SVG generation, and `wa.me` link formatting.

### Task 4: Valet Podium Console & Guest Mobile Ticket UI (`public/`)
- Build responsive, clean hospitality UIs:
  - `public/styles.css` — shared design tokens & mobile-first layout.
  - `public/valet.html` + `public/valet.js` — PIN unlock screen, Check-in form, QR modal, Live "Ready to Leave" retrieval queue with Web Audio chime toggle, Parked & At Entrance sections, Edit modal, PIN-confirmed Cancel modal, Settings modal.
  - `public/guest.html` + `public/guest.js` — Warm "Hi!" digital ticket, live SSE status banner, "I am ready to leave" CTA, friendly idempotency feedback, optional `wa.me` button.

### Task 5: End-to-End Verification
- Run `npm test` (full test suite), boot the server and verify live HTTP/HTML/SSE responses cleanly.
