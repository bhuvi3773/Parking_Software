const lockScreen = document.getElementById('lockScreen');
const podiumApp = document.getElementById('podiumApp');
const loginForm = document.getElementById('loginForm');
const pinInput = document.getElementById('pinInput');
const loginError = document.getElementById('loginError');
const defaultPinHint = document.getElementById('defaultPinHint');
const lockHotelLabel = document.getElementById('lockHotelLabel');

const podiumHotelName = document.getElementById('podiumHotelName');
const lanInfo = document.getElementById('lanInfo');
const sseStatusText = document.getElementById('sseStatusText');
const soundToggleBtn = document.getElementById('soundToggleBtn');
const settingsBtn = document.getElementById('settingsBtn');
const lockBtn = document.getElementById('lockBtn');

const checkinForm = document.getElementById('checkinForm');
const carNumberInput = document.getElementById('carNumberInput');
const customerNameInput = document.getElementById('customerNameInput');
const valetNumberInput = document.getElementById('valetNumberInput');
const parkingSpotInput = document.getElementById('parkingSpotInput');
const checkinError = document.getElementById('checkinError');

const activeQrCard = document.getElementById('activeQrCard');
const qrCardHeading = document.getElementById('qrCardHeading');
const qrScanStatusBadge = document.getElementById('qrScanStatusBadge');
const inlineQrImage = document.getElementById('inlineQrImage');
const inlineQrDetails = document.getElementById('inlineQrDetails');
const inlineQrUrl = document.getElementById('inlineQrUrl');
const copyInlineQrBtn = document.getElementById('copyInlineQrBtn');
const openInlineCustomerBtn = document.getElementById('openInlineCustomerBtn');

const requestedList = document.getElementById('requestedList');
const entranceList = document.getElementById('entranceList');
const parkedList = document.getElementById('parkedList');
const historyList = document.getElementById('historyList');
const requestedCount = document.getElementById('requestedCount');
const entranceCount = document.getElementById('entranceCount');
const parkedCount = document.getElementById('parkedCount');
const historyCount = document.getElementById('historyCount');

const chatModal = document.getElementById('chatModal');
const chatModalTitle = document.getElementById('chatModalTitle');
const chatModalSub = document.getElementById('chatModalSub');
const workerChatFeed = document.getElementById('workerChatFeed');
const workerReplyForm = document.getElementById('workerReplyForm');
const workerReplyInput = document.getElementById('workerReplyInput');
const modalEntranceBtn = document.getElementById('modalEntranceBtn');
const modalCompleteBtn = document.getElementById('modalCompleteBtn');
const closeChatModal = document.getElementById('closeChatModal');

const editModal = document.getElementById('editModal');
const editForm = document.getElementById('editForm');
const editModalTitle = document.getElementById('editModalTitle');
const editCarNumber = document.getElementById('editCarNumber');
const editCustomerName = document.getElementById('editCustomerName');
const editValetNumber = document.getElementById('editValetNumber');
const editParkingSpot = document.getElementById('editParkingSpot');
const editError = document.getElementById('editError');
const closeEditModal = document.getElementById('closeEditModal');

const cancelModal = document.getElementById('cancelModal');
const cancelForm = document.getElementById('cancelForm');
const cancelModalTitle = document.getElementById('cancelModalTitle');
const cancelPinInput = document.getElementById('cancelPinInput');
const cancelError = document.getElementById('cancelError');
const closeCancelModal = document.getElementById('closeCancelModal');

const settingsModal = document.getElementById('settingsModal');
const settingsForm = document.getElementById('settingsForm');
const settingHotelName = document.getElementById('settingHotelName');
const settingWaPhone = document.getElementById('settingWaPhone');
const settingNewPin = document.getElementById('settingNewPin');
const settingsError = document.getElementById('settingsError');
const closeSettingsModal = document.getElementById('closeSettingsModal');

const toastEl = document.getElementById('toast');

let state = {
  active: [],
  history: [],
  baseUrl: window.location.origin,
  hotelName: 'Grand Valet',
  activeQrCode: null,
  soundEnabled: false,
  audioCtx: null,
  chatCode: null,
  editingCode: null,
  cancellingCode: null,
  sse: null,
  pollTimer: null,
};

let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3600);
}

function playAlertChime() {
  if (!state.soundEnabled || !state.audioCtx) return;
  try {
    const ctx = state.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.14);
      gain.gain.setValueAtTime(0.18, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.14 + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.26);
    });
  } catch {
    // Ignore audio errors
  }
}

soundToggleBtn.addEventListener('click', () => {
  if (!state.audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) state.audioCtx = new AudioCtx();
  }
  state.soundEnabled = !state.soundEnabled;
  soundToggleBtn.textContent = state.soundEnabled ? 'Sound Alerts: On' : 'Enable Sound Alerts';
  if (state.soundEnabled) playAlertChime();
});

function formatElapsed(iso) {
  if (!iso) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(status) {
  const labels = {
    parked: 'Parked',
    requested: 'Ready to Leave',
    at_entrance: 'At Entrance',
    completed: 'Picked Up',
    cancelled: 'Cancelled',
  };
  return labels[status] || status;
}

function showInlineQr(ticket, preloadedDataUrl = null, preloadedGuestUrl = null) {
  state.activeQrCode = ticket.code;
  const guestUrl = preloadedGuestUrl || `${state.baseUrl}/t/${ticket.code}`;
  activeQrCard.classList.remove('hidden');
  qrCardHeading.textContent = `QR · Valet #${ticket.valet_number}`;
  inlineQrDetails.textContent = `${ticket.car_number} · ${ticket.customer_name}`;
  inlineQrUrl.textContent = guestUrl;
  inlineQrImage.src =
    preloadedDataUrl || `/api/tickets/${encodeURIComponent(ticket.code)}/qr?t=${Date.now()}`;
  openInlineCustomerBtn.href = `/t/${encodeURIComponent(ticket.code)}`;

  if (ticket.scanned_at) {
    qrScanStatusBadge.className = 'badge badge-scanned';
    qrScanStatusBadge.textContent = 'Customer scanned QR ✓';
  } else {
    qrScanStatusBadge.className = 'badge badge-unscanned';
    qrScanStatusBadge.textContent = 'Waiting for scan…';
  }
}

function syncActiveQrCard() {
  if (!state.activeQrCode) return;
  const found =
    state.active.find((t) => t.code === state.activeQrCode) ||
    state.history.find((t) => t.code === state.activeQrCode);
  if (!found) return;
  qrCardHeading.textContent = `QR · Valet #${found.valet_number}`;
  inlineQrDetails.textContent = `${found.car_number} · ${found.customer_name}`;
  if (found.scanned_at) {
    qrScanStatusBadge.className = 'badge badge-scanned';
    qrScanStatusBadge.textContent = 'Customer scanned QR ✓';
  } else {
    qrScanStatusBadge.className = 'badge badge-unscanned';
    qrScanStatusBadge.textContent = 'Waiting for scan…';
  }
}

copyInlineQrBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inlineQrUrl.textContent);
    showToast('Customer QR link copied');
  } catch {
    showToast('Copy failed — use Open Customer Side');
  }
});

function buildTicketCard(ticket) {
  const card = el('article', `ticket-card is-${ticket.status}`);
  const main = el('div', 'ticket-main');

  const top = el('div', 'ticket-top');
  top.appendChild(el('span', 'valet-pill mono', `Valet #${ticket.valet_number}`));
  top.appendChild(el('span', `badge badge-${ticket.status}`, statusLabel(ticket.status)));
  if (ticket.status === 'parked') {
    top.appendChild(
      el(
        'span',
        `badge ${ticket.scanned_at ? 'badge-scanned' : 'badge-unscanned'}`,
        ticket.scanned_at ? 'QR Scanned ✓' : 'Awaiting Scan'
      )
    );
  }
  if (ticket.status === 'requested' && ticket.requested_at) {
    const waitBadge = el('span', 'mono', `Waiting ${formatElapsed(ticket.requested_at)}`);
    waitBadge.style.fontSize = '12px';
    waitBadge.style.color = 'var(--amber)';
    waitBadge.style.fontWeight = '700';
    top.appendChild(waitBadge);
  }
  main.appendChild(top);

  main.appendChild(el('div', 'ticket-car', `${ticket.car_number} · ${ticket.customer_name}`));

  const meta = el('div', 'ticket-meta');
  if (ticket.parking_spot) {
    meta.appendChild(el('span', 'meta-chip mono', `Spot ${ticket.parking_spot}`));
  }
  meta.appendChild(el('span', 'meta-chip mono', `Ticket #${ticket.ticket_number}`));
  main.appendChild(meta);

  const msgs = ticket.messages || [];
  if (msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    const preview = el('div', 'last-msg-preview');
    const senderLabel =
      last.sender === 'customer'
        ? `${ticket.customer_name}:`
        : last.sender === 'worker'
          ? 'Worker:'
          : 'System:';
    preview.appendChild(el('span', 'last-msg-sender', senderLabel));
    preview.appendChild(document.createTextNode(last.body));
    main.appendChild(preview);
  }

  card.appendChild(main);

  const actions = el('div', 'ticket-actions');
  if (ticket.status === 'requested' || ticket.status === 'parked') {
    const entBtn = el(
      'button',
      `btn btn-sm ${ticket.status === 'requested' ? 'btn-amber' : 'btn-secondary'}`,
      'Send: Car Ready at Entrance'
    );
    entBtn.type = 'button';
    entBtn.addEventListener('click', () => triggerAction(ticket.code, 'entrance'));
    actions.appendChild(entBtn);
  }

  if (ticket.status === 'at_entrance') {
    const compBtn = el('button', 'btn btn-sm btn-emerald', 'Mark Picked Up');
    compBtn.type = 'button';
    compBtn.addEventListener('click', () => triggerAction(ticket.code, 'complete'));
    actions.appendChild(compBtn);
  }

  if (ticket.status === 'parked' || ticket.status === 'requested' || ticket.status === 'at_entrance') {
    const chatBtn = el('button', 'btn btn-sm btn-secondary', `Chat (${msgs.length})`);
    chatBtn.type = 'button';
    chatBtn.addEventListener('click', () => openChatModal(ticket));
    actions.appendChild(chatBtn);

    const qrBtn = el('button', 'btn btn-sm btn-secondary', 'Show QR');
    qrBtn.type = 'button';
    qrBtn.addEventListener('click', () => showInlineQr(ticket));
    actions.appendChild(qrBtn);

    const editBtn = el('button', 'btn btn-sm btn-secondary', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openEditModal(ticket));
    actions.appendChild(editBtn);

    const cancelBtn = el('button', 'btn btn-sm btn-danger-outline', 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => openCancelModal(ticket));
    actions.appendChild(cancelBtn);
  }

  card.appendChild(actions);
  return card;
}

function renderList(container, items, emptyText) {
  container.replaceChildren();
  if (items.length === 0) {
    container.appendChild(el('div', 'empty-state', emptyText));
    return;
  }
  for (const item of items) {
    container.appendChild(buildTicketCard(item));
  }
}

function renderAll() {
  const requested = state.active.filter((t) => t.status === 'requested');
  const atEntrance = state.active.filter((t) => t.status === 'at_entrance');
  const parked = state.active.filter((t) => t.status === 'parked');

  requestedCount.textContent = String(requested.length);
  entranceCount.textContent = String(atEntrance.length);
  parkedCount.textContent = String(parked.length);
  historyCount.textContent = String(state.history.length);

  renderList(requestedList, requested, 'No customer leave requests yet.');
  renderList(entranceList, atEntrance, 'No cars placed at the entrance yet.');
  renderList(parkedList, parked, 'No parked cars yet.');
  renderList(historyList, state.history.slice(0, 10), 'No completed or cancelled tickets yet.');

  syncActiveQrCard();
  if (state.chatCode && !chatModal.classList.contains('hidden')) {
    const activeTicket =
      state.active.find((t) => t.code === state.chatCode) ||
      state.history.find((t) => t.code === state.chatCode);
    if (activeTicket) renderChatModalMessages(activeTicket);
  }
}

setInterval(() => {
  if (state.active.some((t) => t.status === 'requested')) {
    renderAll();
  }
}, 1000);

function computeNextValetNumber() {
  const all = [...state.active, ...state.history];
  const maxNum = all.reduce((max, t) => Math.max(max, Number(t.ticket_number) || 100), 100);
  return String(maxNum + 1);
}

function upsertTicketFromSse(ticket) {
  const prev = state.active.find((t) => t.code === ticket.code);
  const isNowRequested = ticket.status === 'requested' && prev?.status !== 'requested';
  const prevMsgCount = prev?.messages?.length || 0;
  const newMsgCount = ticket.messages?.length || 0;
  const latestMsg = newMsgCount > prevMsgCount ? ticket.messages[newMsgCount - 1] : null;
  const newlyScanned = !prev?.scanned_at && Boolean(ticket.scanned_at);

  state.active = state.active.filter((t) => t.code !== ticket.code);
  state.history = state.history.filter((t) => t.code !== ticket.code);

  if (ticket.status === 'completed' || ticket.status === 'cancelled') {
    state.history.unshift(ticket);
  } else {
    state.active.push(ticket);
  }

  renderAll();

  if (isNowRequested) {
    playAlertChime();
    showToast(
      `Valet #${ticket.valet_number} (${ticket.car_number}): ${ticket.customer_name} says "I am ready to leave"`
    );
  } else if (latestMsg && latestMsg.sender === 'customer') {
    playAlertChime();
    showToast(`Message from ${ticket.customer_name}: ${latestMsg.body}`);
  } else if (newlyScanned) {
    showToast(`${ticket.customer_name} scanned QR for Valet #${ticket.valet_number}`);
  }
}

async function loadTicketsAndSettings() {
  const [ticketsRes, settingsRes] = await Promise.all([
    fetch('/api/tickets'),
    fetch('/api/settings'),
  ]);

  if (ticketsRes.status === 401 || settingsRes.status === 401) {
    showLockScreen();
    return;
  }

  const ticketsData = await ticketsRes.json();
  const settingsData = await settingsRes.json();

  state.active = ticketsData.active || [];
  state.history = ticketsData.history || [];
  state.baseUrl = settingsData.baseUrl || window.location.origin;
  state.hotelName = settingsData.hotel_name || 'Grand Valet';

  podiumHotelName.textContent = `${state.hotelName} · Worker Side`;
  lanInfo.textContent = `QR Base: ${state.baseUrl}`;
  if (!valetNumberInput.value.trim()) {
    valetNumberInput.value = ticketsData.next_valet_number || computeNextValetNumber();
  }

  renderAll();
  if (state.active.length > 0 && !state.activeQrCode) {
    showInlineQr(state.active[0]);
  }
  if (settingsData.realtimeMode === 'poll') {
    startValetPolling();
  } else {
    connectValetSse();
  }
}

function applyPolledTickets(data) {
  const prevByCode = new Map(
    [...state.active, ...state.history].map((t) => [t.code, JSON.stringify(t)])
  );
  const incoming = [...(data.active || []), ...(data.history || [])];
  for (const ticket of incoming) {
    if (prevByCode.get(ticket.code) !== JSON.stringify(ticket)) {
      upsertTicketFromSse(ticket);
    }
  }
  state.active = data.active || [];
  state.history = data.history || [];
  renderAll();
}

function startValetPolling() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  sseStatusText.textContent = 'Live';
  state.pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/tickets');
      if (res.status === 401) {
        showLockScreen();
        return;
      }
      if (res.ok) {
        sseStatusText.textContent = 'Live';
        applyPolledTickets(await res.json());
      }
    } catch {
      sseStatusText.textContent = 'Reconnecting…';
    }
  }, 2000);
}

function connectValetSse() {
  if (state.sse) state.sse.close();
  const sse = new EventSource('/api/events');
  state.sse = sse;
  let openedOnce = false;

  sse.onopen = async () => {
    sseStatusText.textContent = 'Live';
    if (openedOnce) {
      try {
        const res = await fetch('/api/tickets');
        if (res.ok) {
          const data = await res.json();
          state.active = data.active || [];
          state.history = data.history || [];
          renderAll();
        }
      } catch {
        // Retry on next reconnect
      }
    }
    openedOnce = true;
  };

  sse.onerror = () => {
    sseStatusText.textContent = 'Reconnecting…';
  };

  sse.addEventListener('ticket', (evt) => {
    upsertTicketFromSse(JSON.parse(evt.data));
  });

  sse.addEventListener('settings', (evt) => {
    const s = JSON.parse(evt.data);
    if (s.hotel_name) {
      state.hotelName = s.hotel_name;
      podiumHotelName.textContent = `${s.hotel_name} · Worker Side`;
    }
  });
}

async function triggerAction(code, action) {
  const res = await fetch(`/api/tickets/${encodeURIComponent(code)}/${action}`, {
    method: 'POST',
  });
  if (res.status === 401) {
    showLockScreen();
    return;
  }
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || 'Action failed');
    return;
  }
  upsertTicketFromSse(data.ticket);
  if (data.alreadyUpdated) {
    showToast(data.message);
  } else if (action === 'entrance') {
    showToast(`Sent "Car ready at entrance" to ${data.ticket.customer_name}`);
  }
}

function openChatModal(ticket) {
  state.chatCode = ticket.code;
  renderChatModalMessages(ticket);
  chatModal.classList.remove('hidden');
  workerReplyInput.focus();
}

function renderChatModalMessages(ticket) {
  chatModalTitle.textContent = `Valet #${ticket.valet_number} · ${ticket.customer_name}`;
  chatModalSub.textContent = `Car ${ticket.car_number}${ticket.parking_spot ? ` · Spot ${ticket.parking_spot}` : ''}`;

  workerChatFeed.replaceChildren();
  for (const m of ticket.messages || []) {
    const row = el('div', `msg-row ${m.sender}`);
    const bubble = el('div', 'msg-bubble');
    bubble.appendChild(el('div', '', m.body));
    const meta = el('div', 'msg-time', `${m.sender === 'customer' ? ticket.customer_name : m.sender === 'worker' ? 'Worker' : 'System'} · ${formatTime(m.created_at)}`);
    bubble.appendChild(meta);
    row.appendChild(bubble);
    workerChatFeed.appendChild(row);
  }
  workerChatFeed.scrollTop = workerChatFeed.scrollHeight;

  const canMoveToEntrance = ticket.status === 'parked' || ticket.status === 'requested';
  modalEntranceBtn.classList.toggle('hidden', !canMoveToEntrance);
  modalCompleteBtn.classList.toggle('hidden', ticket.status !== 'at_entrance');
}

closeChatModal.addEventListener('click', () => {
  chatModal.classList.add('hidden');
  state.chatCode = null;
});

workerReplyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = workerReplyInput.value.trim();
  if (!body || !state.chatCode) return;
  const res = await fetch(`/api/tickets/${encodeURIComponent(state.chatCode)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || 'Could not send message');
    return;
  }
  workerReplyInput.value = '';
  upsertTicketFromSse(data.ticket);
});

modalEntranceBtn.addEventListener('click', () => {
  if (state.chatCode) triggerAction(state.chatCode, 'entrance');
});

modalCompleteBtn.addEventListener('click', () => {
  if (state.chatCode) triggerAction(state.chatCode, 'complete');
});

function openEditModal(ticket) {
  state.editingCode = ticket.code;
  editModalTitle.textContent = `Edit Valet #${ticket.valet_number}`;
  editCarNumber.value = ticket.car_number;
  editCustomerName.value = ticket.customer_name;
  editValetNumber.value = ticket.valet_number;
  editParkingSpot.value = ticket.parking_spot || '';
  editError.classList.add('hidden');
  editModal.classList.remove('hidden');
}

closeEditModal.addEventListener('click', () => editModal.classList.add('hidden'));

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  editError.classList.add('hidden');
  const res = await fetch(`/api/tickets/${encodeURIComponent(state.editingCode)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      car_number: editCarNumber.value,
      customer_name: editCustomerName.value,
      valet_number: editValetNumber.value,
      parking_spot: editParkingSpot.value,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    editError.textContent = data.error || 'Could not update ticket';
    editError.classList.remove('hidden');
    return;
  }
  editModal.classList.add('hidden');
  upsertTicketFromSse(data.ticket);
  showToast(`Valet #${data.ticket.valet_number} updated`);
});

function openCancelModal(ticket) {
  state.cancellingCode = ticket.code;
  cancelModalTitle.textContent = `Cancel Valet #${ticket.valet_number}`;
  cancelPinInput.value = '';
  cancelError.classList.add('hidden');
  cancelModal.classList.remove('hidden');
  cancelPinInput.focus();
}

closeCancelModal.addEventListener('click', () => cancelModal.classList.add('hidden'));

cancelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  cancelError.classList.add('hidden');
  const res = await fetch(`/api/tickets/${encodeURIComponent(state.cancellingCode)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: cancelPinInput.value }),
  });
  const data = await res.json();
  if (!res.ok) {
    cancelError.textContent = data.error || 'Could not cancel ticket';
    cancelError.classList.remove('hidden');
    return;
  }
  cancelModal.classList.add('hidden');
  upsertTicketFromSse(data.ticket);
  showToast(data.message || 'Ticket cancelled');
});

settingsBtn.addEventListener('click', async () => {
  settingsError.classList.add('hidden');
  settingNewPin.value = '';
  const res = await fetch('/api/settings');
  if (!res.ok) return;
  const s = await res.json();
  settingHotelName.value = s.hotel_name || '';
  settingWaPhone.value = s.valet_whatsapp_phone || '';
  settingsModal.classList.remove('hidden');
});

closeSettingsModal.addEventListener('click', () => settingsModal.classList.add('hidden'));

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  settingsError.classList.add('hidden');
  const payload = {
    hotel_name: settingHotelName.value,
    valet_whatsapp_phone: settingWaPhone.value,
  };
  if (settingNewPin.value.trim()) {
    payload.valet_pin = settingNewPin.value.trim();
  }
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    settingsError.textContent = data.error || 'Could not save settings';
    settingsError.classList.remove('hidden');
    return;
  }
  state.hotelName = data.hotel_name;
  podiumHotelName.textContent = `${data.hotel_name} · Worker Side`;
  settingsModal.classList.add('hidden');
  showToast('Settings saved');
});

checkinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  checkinError.classList.add('hidden');
  const res = await fetch('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      car_number: carNumberInput.value,
      customer_name: customerNameInput.value,
      valet_number: valetNumberInput.value,
      parking_spot: parkingSpotInput.value,
    }),
  });
  if (res.status === 401) {
    showLockScreen();
    return;
  }
  const data = await res.json();
  if (!res.ok) {
    checkinError.textContent = data.error || 'Failed to generate QR';
    checkinError.classList.remove('hidden');
    return;
  }
  checkinForm.reset();
  upsertTicketFromSse(data.ticket);
  valetNumberInput.value = computeNextValetNumber();
  showInlineQr(data.ticket, data.qrDataUrl, data.guestUrl);
  showToast(`QR ready for ${data.ticket.customer_name} (Valet #${data.ticket.valet_number})`);
});

function showLockScreen(sessionInfo = null) {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  podiumApp.classList.add('hidden');
  lockScreen.classList.remove('hidden');
  if (sessionInfo) {
    lockHotelLabel.textContent = `${sessionInfo.hotel_name} · Enter Valet PIN to unlock.`;
    defaultPinHint.classList.toggle('hidden', !sessionInfo.is_default_pin);
  }
  pinInput.value = '';
  pinInput.focus();
}

function showPodium() {
  lockScreen.classList.add('hidden');
  podiumApp.classList.remove('hidden');
  loadTicketsAndSettings();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pinInput.value }),
  });
  const data = await res.json();
  if (!res.ok) {
    loginError.textContent = data.error || 'Invalid PIN';
    loginError.classList.remove('hidden');
    return;
  }
  showPodium();
});

lockBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  const sessionRes = await fetch('/api/auth/session');
  showLockScreen(await sessionRes.json());
});

async function bootstrap() {
  const res = await fetch('/api/auth/session');
  const session = await res.json();
  if (session.authenticated) {
    showPodium();
  } else {
    showLockScreen(session);
  }
}

bootstrap();
