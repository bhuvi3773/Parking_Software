/**
 * Manage Server-Sent Events (SSE) streams for worker consoles and customer chat views.
 */
export function createSseHub({ heartbeatMs = 25000, disabled = false } = {}) {
  const valetClients = new Set();
  const ticketClients = new Map();

  function setupHeaders(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
  }

  function sendEvent(res, eventName, data) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function addValetClient(req, res) {
    if (disabled) return res.status(204).end();
    setupHeaders(res);
    valetClients.add(res);
    req.on('close', () => {
      valetClients.delete(res);
    });
  }

  function addTicketClient(code, req, res) {
    if (disabled) return res.status(204).end();
    setupHeaders(res);
    let set = ticketClients.get(code);
    if (!set) {
      set = new Set();
      ticketClients.set(code, set);
    }
    set.add(res);
    req.on('close', () => {
      set.delete(res);
      if (set.size === 0) {
        ticketClients.delete(code);
      }
    });
  }

  function broadcastTicketChange(ticket, guestPayload) {
    if (disabled) return;
    for (const res of valetClients) {
      sendEvent(res, 'ticket', ticket);
    }
    const guests = ticketClients.get(ticket.code);
    if (guests) {
      for (const res of guests) {
        sendEvent(res, 'ticket', guestPayload);
      }
    }
  }

  function broadcastSettingsChange(settings) {
    if (disabled) return;
    for (const res of valetClients) {
      sendEvent(res, 'settings', settings);
    }
    for (const guests of ticketClients.values()) {
      for (const res of guests) {
        sendEvent(res, 'settings', {
          hotel_name: settings.hotel_name,
          valet_whatsapp_phone: settings.valet_whatsapp_phone,
        });
      }
    }
  }

  const timer = disabled
    ? null
    : setInterval(() => {
        for (const res of valetClients) {
          res.write(': ping\n\n');
        }
        for (const guests of ticketClients.values()) {
          for (const res of guests) {
            res.write(': ping\n\n');
          }
        }
      }, heartbeatMs);
  if (timer) timer.unref();

  function closeAll() {
    if (timer) clearInterval(timer);
    for (const res of valetClients) {
      res.end();
    }
    valetClients.clear();
    for (const guests of ticketClients.values()) {
      for (const res of guests) {
        res.end();
      }
    }
    ticketClients.clear();
  }

  return {
    addValetClient,
    addTicketClient,
    broadcastTicketChange,
    broadcastSettingsChange,
    closeAll,
  };
}
