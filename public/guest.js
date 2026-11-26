const pathParts = window.location.pathname.split('/').filter(Boolean);
const ticketCode = pathParts[1] || '';

const loadingCard = document.getElementById('loadingCard');
const errorCard = document.getElementById('errorCard');
const chatFrame = document.getElementById('chatFrame');

const hotelAvatar = document.getElementById('hotelAvatar');
const hotelNameEl = document.getElementById('hotelName');
const chatHeaderSub = document.getElementById('chatHeaderSub');
const statusBadge = document.getElementById('statusBadge');

const chipCustomer = document.getElementById('chipCustomer');
const chipCar = document.getElementById('chipCar');
const chipValet = document.getElementById('chipValet');
const stepParked = document.getElementById('stepParked');
const stepRequested = document.getElementById('stepRequested');
const stepEntrance = document.getElementById('stepEntrance');

const chatMessages = document.getElementById('chatMessages');
const quickActionBar = document.getElementById('quickActionBar');
const readyBtn = document.getElementById('readyBtn');
const requestedBanner = document.getElementById('requestedBanner');
const entranceBanner = document.getElementById('entranceBanner');
const chatComposer = document.getElementById('chatComposer');
const messageInput = document.getElementById('messageInput');
const waWrap = document.getElementById('waWrap');
const waLink = document.getElementById('waLink');
const liveStatusText = document.getElementById('liveStatusText');
const feedbackText = document.getElementById('feedbackText');

let currentTicket = null;
let currentMessages = [];
let lastMessageSignature = '';
let eventSource = null;
let pollTimer = null;

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function statusLabel(status) {
  const map = {
    parked: 'Parked',
    requested: 'Valet Notified',
    at_entrance: 'At Entrance',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  return map[status] || status;
}

function updateSteps(status) {
  [stepParked, stepRequested, stepEntrance].forEach((el) => {
    el.classList.remove('active', 'done');
  });

  if (status === 'parked') {
    stepParked.classList.add('active');
  } else if (status === 'requested') {
    stepParked.classList.add('done');
    stepRequested.classList.add('active');
  } else if (status === 'at_entrance') {
    stepParked.classList.add('done');
    stepRequested.classList.add('done');
    stepEntrance.classList.add('active');
  } else if (status === 'completed') {
    stepParked.classList.add('done');
    stepRequested.classList.add('done');
    stepEntrance.classList.add('done');
  }
}

function renderMessages(messages) {
  const sig = messages.map((m) => `${m.id}:${m.body}`).join('|');
  if (sig === lastMessageSignature) return;
  lastMessageSignature = sig;

  chatMessages.replaceChildren();
  for (const m of messages) {
    const row = document.createElement('div');
    row.className = `msg-row ${m.sender}`;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const body = document.createElement('div');
    body.textContent = m.body;
    bubble.appendChild(body);

    if (m.sender !== 'system') {
      const meta = document.createElement('div');
      meta.className = 'msg-time';
      meta.textContent =
        m.sender === 'customer'
          ? `${formatTime(m.created_at)} ✓✓`
          : formatTime(m.created_at);
      bubble.appendChild(meta);
    }

    row.appendChild(bubble);
    chatMessages.appendChild(row);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderAll(ticket, messages, hotelName, waMeUrl) {
  currentTicket = ticket;
  if (messages) currentMessages = messages;

  if (hotelName) {
    hotelNameEl.textContent = hotelName;
    hotelAvatar.textContent = hotelName.trim().charAt(0).toUpperCase() || 'V';
    document.title = `${hotelName} · Valet #${ticket.valet_number}`;
  }

  chatHeaderSub.textContent = `Valet #${ticket.valet_number} · ${ticket.car_number}`;
  statusBadge.className = `badge badge-${ticket.status}`;
  statusBadge.textContent = statusLabel(ticket.status);

  chipCustomer.textContent = `Customer: ${ticket.customer_name}`;
  chipCar.textContent = `Car: ${ticket.car_number}`;
  chipValet.textContent = `Valet #${ticket.valet_number}`;

  updateSteps(ticket.status);
  renderMessages(currentMessages);

  const isClosed = ticket.status === 'completed' || ticket.status === 'cancelled';

  quickActionBar.classList.toggle('hidden', ticket.status !== 'parked');
  readyBtn.disabled = ticket.status !== 'parked';
  readyBtn.textContent = 'I am ready to leave';

  requestedBanner.classList.toggle('hidden', ticket.status !== 'requested');
  entranceBanner.classList.toggle('hidden', ticket.status !== 'at_entrance');
  chatComposer.classList.toggle('hidden', isClosed);

  if (waMeUrl !== undefined) {
    if (waMeUrl && !isClosed) {
      waLink.href = waMeUrl;
      waWrap.classList.remove('hidden');
    } else {
      waWrap.classList.add('hidden');
    }
  }
}

async function loadInitialTicket() {
  if (!ticketCode) {
    loadingCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch(`/api/tickets/${encodeURIComponent(ticketCode)}`);
    if (!res.ok) {
      loadingCard.classList.add('hidden');
      errorCard.classList.remove('hidden');
      return;
    }
    const data = await res.json();
    loadingCard.classList.add('hidden');
    chatFrame.classList.remove('hidden');
    renderAll(data.ticket, data.messages, data.hotel_name, data.wa_me_url);
    if (data.realtimeMode === 'poll') {
      startPolling();
    } else {
      connectSse();
    }
  } catch {
    loadingCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  liveStatusText.textContent = 'Live updates connected';
  pollTimer = setInterval(async () => {
    if (
      currentTicket &&
      (currentTicket.status === 'completed' || currentTicket.status === 'cancelled')
    ) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketCode)}`);
      if (res.ok) {
        const data = await res.json();
        renderAll(data.ticket, data.messages, data.hotel_name, data.wa_me_url);
        liveStatusText.textContent = 'Live updates connected';
      }
    } catch {
      liveStatusText.textContent = 'Reconnecting…';
    }
  }, 2000);
}

function connectSse() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/tickets/${encodeURIComponent(ticketCode)}/events`);
  let openedOnce = false;

  eventSource.onopen = async () => {
    liveStatusText.textContent = 'Live updates connected';
    if (openedOnce) {
      try {
        const res = await fetch(`/api/tickets/${encodeURIComponent(ticketCode)}`);
        if (res.ok) {
          const data = await res.json();
          renderAll(data.ticket, data.messages, data.hotel_name, data.wa_me_url);
        }
      } catch {
        // Retry on next reconnect
      }
    }
    openedOnce = true;
  };

  eventSource.onerror = () => {
    liveStatusText.textContent = 'Reconnecting…';
  };

  eventSource.addEventListener('ticket', (evt) => {
    const payload = JSON.parse(evt.data);
    renderAll(payload.ticket, payload.messages);
  });

  eventSource.addEventListener('settings', (evt) => {
    const s = JSON.parse(evt.data);
    if (s.hotel_name && currentTicket) {
      const waUrl = s.valet_whatsapp_phone
        ? `https://wa.me/${s.valet_whatsapp_phone}?text=${encodeURIComponent(
            `Hi! Valet #${currentTicket.valet_number} (${currentTicket.car_number}, ${currentTicket.customer_name}) — I am ready to leave. Please bring my car to the entrance.`
          )}`
        : null;
      renderAll(currentTicket, currentMessages, s.hotel_name, waUrl);
    }
  });
}

readyBtn.addEventListener('click', async () => {
  readyBtn.disabled = true;
  readyBtn.textContent = 'Sending…';
  feedbackText.textContent = '';

  try {
    const res = await fetch(`/api/tickets/${encodeURIComponent(ticketCode)}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'I am ready to leave' }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not alert valet');
    }
    renderAll(data.ticket, data.messages);
    if (data.message) feedbackText.textContent = data.message;
  } catch (err) {
    readyBtn.disabled = false;
    readyBtn.textContent = 'I am ready to leave';
    feedbackText.textContent = err.message;
  }
});

chatComposer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  feedbackText.textContent = '';

  try {
    const res = await fetch(`/api/tickets/${encodeURIComponent(ticketCode)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Message failed');
    }
    messageInput.value = '';
    renderAll(data.ticket, data.messages);
  } catch (err) {
    feedbackText.textContent = err.message;
  }
});

loadInitialTicket();
