/* === ABICS AMS — Application Logic: Handles configuration, app state, local storage, utilities,
 UI/toasts, routing, events, facilities, reservations, seat management, admin controls, email, QR codes, and app initialization.=== */

/* ===  CONFIGURATION  === */
const CONFIG = {
  // Update the admin PIN (also editable from Admin - Settings).
  DEFAULT_ADMIN_PIN: "0000",

  DEFAULT_SETTINGS: {
    totalRows: 8,
    seatsPerRow: 12,
    maxSeatsPerReservation: 6,
    requireApproval: true,
    holdDurationSeconds: 120,
    adminPin: "0000"
  },

  CLASSES: [
    "XI-A - Pre-Medical + Pre-Engineering", "XI-B - Pre-Medical + Pre-Engineering", "XI-C - Pre-Medical + Pre-Engineering", "XI-D - Pre-Engineering", "XI-E - ICS", "XI-F - ICS", "XI-G - ICS",
    "XII-A - Pre-Medical + Pre-Engineering", "XII-B - Pre-Medical + Pre-Engineering", "XII-C - Pre-Medical + Pre-Engineering", "XII-D - Pre-Engineering", "XII-E - ICS", "XII-F - ICS", "XII-G - ICS", "XII-H - ICS",
  ],

  TEACHERS: [
    "Mr. Zeeshan Malik", "Mrs. Saba Gul", "Mrs. Shamsa Zain",
    "Mrs. Mahnoor Fatima", "Ms. Aiza Wajid", "Ms. Rameen Iqbal",
    "Mrs. Hafsa Lutaf", "Mrs. Areesha Yousaf", "Ms. Hareem Sattar", "Ms. Umm-e-Farwa", "Mrs. Asma Khalid",
    "Mrs. Aisha Sadia", "Ms. Ramla Siddiqui", "Mr. Talha Zubair", "Ms. Sadia Yousaf"
  ],

  // Client-side email delivery (EmailJS). Leave blank to keep email delivery
  // disabled — the app must, and does, keep working without it.
  EMAIL: {
    SERVICE_ID: "service_hvncgqu",    
    TEMPLATE_ID: "template_08b5tf5",    
    PUBLIC_KEY: "0gCQESPHcIFhiMKwF"      
  },

  QR_API: "https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data="
};

/* ===  STATE — in-memory, hydrated from localStorage on load=== */
const STATE = {
  events: [],
  reservations: [],
  facilities: [],
  settings: null,
  holds: [],

  currentPage: "home",
  isAdmin: false,
  adminTab: "dashboard",

  eventFilter: "all",
  eventSearch: "",
  resFilter: "all",
  resSearch: "",

  // Reservation-in-progress draft
  draft: null,
  holdTimerInterval: null,

  editingEventId: null,
  editingFacilityId: null,
  currentPassReservationId: null
};

/* ===  LOCALSTORAGE  === */
const LS_KEYS = {
  events: "ams_events",
  reservations: "ams_reservations",
  facilities: "ams_facilities",
  settings: "ams_settings",
  holds: "ams_holds",
  seeded: "ams_seeded"
};

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error("Storage read failed for", key, e);
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("Storage write failed for", key, e);
    toast("Could not save data locally. Storage may be full.");
  }
}

function persistAll() {
  lsSet(LS_KEYS.events, STATE.events);
  lsSet(LS_KEYS.reservations, STATE.reservations);
  lsSet(LS_KEYS.facilities, STATE.facilities);
  lsSet(LS_KEYS.settings, STATE.settings);
  lsSet(LS_KEYS.holds, STATE.holds);
}

/* ===   UTILITIES  === */
function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pad(n, len) { return String(n).padStart(len, "0"); }

function nextReservationId() {
  const year = new Date().getFullYear();
  const countThisYear = STATE.reservations.filter(r => r.id.includes("AMS-" + year)).length + 1;
  return `AMS-${year}-${pad(countThisYear, 5)}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[s]));
}

function formatDateLong(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
function formatTime12(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m, 2)} ${period}`;
}

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { return /^[0-9+\-\s]{7,15}$/.test(phone); }

function eventDateTime(ev, which) {
  return new Date(`${ev.date}T${which === "end" ? ev.endTime : ev.startTime}:00`);
}

function computeEventStatus(ev) {
  if (ev.status === "closed") return "closed";
  const now = new Date();
  const start = eventDateTime(ev, "start");
  const end = eventDateTime(ev, "end");
  if (now < start) return "upcoming";
  if (now >= start && now <= end) return "live";
  return "completed";
}

function seatsForEvent(ev) {
  // Total addressable seats for this event = min(event maxSeats, auditorium capacity)
  const capacity = STATE.settings.totalRows * STATE.settings.seatsPerRow;
  return Math.min(ev.maxSeats, capacity);
}

function reservedSeatCountForEvent(eventId) {
  return STATE.reservations
    .filter(r => r.eventId === eventId && (r.status === "confirmed" || r.status === "checked-in" || r.status === "pending"))
    .reduce((sum, r) => sum + r.seats.length, 0);
}

function confirmedSeatSetForEvent(eventId) {
  const set = new Set();
  STATE.reservations
    .filter(r => r.eventId === eventId && ["confirmed", "checked-in", "pending"].includes(r.status))
    .forEach(r => r.seats.forEach(s => set.add(s)));
  return set;
}

function heldSeatSetForEvent(eventId, excludeHoldId) {
  cleanExpiredHolds();
  const set = new Set();
  STATE.holds
    .filter(h => h.eventId === eventId && h.id !== excludeHoldId)
    .forEach(h => h.seats.forEach(s => set.add(s)));
  return set;
}

/* ===  UI — Toasts, Modals, Nav  === */
function toast(message) {
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

function confirmDialog(text, onConfirm) {
  document.getElementById("confirm-dialog-text").textContent = text;
  openModal("confirm-dialog-overlay");
  const okBtn = document.getElementById("confirm-dialog-ok");
  const cancelBtn = document.getElementById("confirm-dialog-cancel");
  const cleanup = () => {
    okBtn.replaceWith(okBtn.cloneNode(true));
    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  };
  cleanup();
  document.getElementById("confirm-dialog-ok").addEventListener("click", () => {
    closeModal("confirm-dialog-overlay");
    onConfirm();
  });
  document.getElementById("confirm-dialog-cancel").addEventListener("click", () => {
    closeModal("confirm-dialog-overlay");
  });
}

document.querySelectorAll("[data-close-modal]").forEach(btn => {
  btn.addEventListener("click", e => {
    e.target.closest(".modal-overlay").classList.add("hidden");
  });
});

// --- Gallery lightbox ---
function openLightbox(item) {
  const img = item.querySelector("img");
  const caption = item.querySelector("figcaption");
  const lbImg = document.getElementById("lightbox-img");
  lbImg.src = img.src;
  lbImg.alt = img.alt;
  document.getElementById("lightbox-caption").textContent = caption ? caption.textContent : "";
  openModal("gallery-lightbox-overlay");
}
document.querySelectorAll(".gallery-item").forEach(item => {
  item.addEventListener("click", () => openLightbox(item));
  item.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(item); }
  });
});
document.getElementById("gallery-lightbox-overlay").addEventListener("click", e => {
  if (e.target.id === "gallery-lightbox-overlay") closeModal("gallery-lightbox-overlay");
});

function navigateTo(page) {
  STATE.currentPage = page;
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.dataset.page === page));
  document.querySelectorAll(".main-nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === page));
  document.getElementById("main-nav").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (page === "home") renderHome();
  if (page === "facilities") renderFacilities();
  if (page === "events") renderEvents();
  if (page === "my-reservations") renderMyReservations();
  if (page === "admin-login") { document.getElementById("pin-input").value = ""; document.getElementById("pin-error").classList.add("hidden"); }
  if (page === "admin") { if (!STATE.isAdmin) { navigateTo("admin-login"); return; } renderAdminTab(STATE.adminTab); }
}

document.querySelectorAll("[data-nav]").forEach(el => {
  el.addEventListener("click", e => {
    e.preventDefault();
    navigateTo(el.dataset.nav);
  });
});

document.getElementById("nav-toggle").addEventListener("click", () => {
  document.getElementById("main-nav").classList.toggle("open");
});

/* ===  HOME PAGE  === */
function animateCounter(el, target) {
  const start = 0;
  const duration = 900;
  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * eased);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderHome() {
  const totalSeats = STATE.settings.totalRows * STATE.settings.seatsPerRow;
  const upcomingEvents = STATE.events.filter(ev => computeEventStatus(ev) === "upcoming" || computeEventStatus(ev) === "live");
  // Headline stats are based on the nearest upcoming/live event so "Available Seats"
  // stays meaningful (seat capacity is tracked per event, not as one shared pool).
  const focusEvent = upcomingEvents.slice().sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  const focusTotal = focusEvent ? seatsForEvent(focusEvent) : totalSeats;
  const focusReserved = focusEvent ? Math.min(reservedSeatCountForEvent(focusEvent.id), focusTotal) : 0;
  const upcoming = upcomingEvents.length;

  const counters = {
    totalSeats: totalSeats,
    reservedSeats: focusReserved,
    availableSeats: Math.max(focusTotal - focusReserved, 0),
    upcomingEvents: upcoming
  };
  document.querySelectorAll("[data-counter]").forEach(el => {
    animateCounter(el, counters[el.dataset.counter] || 0);
  });

  // Hero seat graphic
  const rowsWrap = document.getElementById("hero-rows");
  rowsWrap.innerHTML = "";
  for (let r = 0; r < 5; r++) {
    const row = document.createElement("div");
    row.className = "row";
    for (let c = 0; c < 16; c++) {
      const span = document.createElement("span");
      if (Math.random() > 0.62) span.classList.add("lit");
      row.appendChild(span);
    }
    rowsWrap.appendChild(row);
  }

  // Facilities preview (first 4)
  const preview = document.getElementById("facilities-preview");
  preview.innerHTML = `
    <div class="page-head">
      <p class="page-eyebrow">Built for every occasion</p>
      <h2>Facilities</h2>
    </div>
    <div class="facility-grid">${STATE.facilities.slice(0, 4).map(facilityCardHtml).join("")}</div>
  `;
}

/* ===  FACILITIES  === */
function facilityCardHtml(f) {
  return `
    <div class="facility-card">
      <span class="facility-icon">${f.icon || "🏛️"}</span>
      <h4>${escapeHtml(f.title)}</h4>
      <p>${escapeHtml(f.description)}</p>
    </div>`;
}

function renderFacilities() {
  document.getElementById("facility-grid").innerHTML = STATE.facilities.map(facilityCardHtml).join("");
}

/* ===  EVENTS  === */
function eventCardHtml(ev) {
  const status = computeEventStatus(ev);
  const total = seatsForEvent(ev);
  const reserved = Math.min(reservedSeatCountForEvent(ev.id), total);
  const available = Math.max(total - reserved, 0);
  const pct = total ? Math.round((reserved / total) * 100) : 0;
  const canReserve = status !== "completed" && ev.status !== "closed" && available > 0;

  return `
    <div class="event-card">
      <div class="event-top">
        <div>
          <span class="event-cat">${escapeHtml(ev.category)}</span>
        </div>
        <span class="event-status-pill ${status}">${status === "live" ? "Happening Now" : status.charAt(0).toUpperCase() + status.slice(1)}</span>
      </div>
      <h4>${escapeHtml(ev.name)}</h4>
      <p>${escapeHtml(ev.description || "")}</p>
      <div class="event-meta">
        <span>📅 ${formatDateLong(ev.date)}</span>
        <span>🕒 ${formatTime12(ev.startTime)} – ${formatTime12(ev.endTime)}</span>
        <span>📍 ${escapeHtml(ev.location)}</span>
        <span>👤 ${escapeHtml(ev.organizer)}</span>
      </div>
      <div class="event-progress-wrap">
        <div class="progress-track"><div class="progress-fill" data-fill="${pct}"></div></div>
        <div class="event-progress-labels">
          <span>${reserved} reserved</span>
          <span>${available} available</span>
        </div>
      </div>
      <div class="event-card-actions">
        <button class="btn btn-primary" ${canReserve ? "" : "disabled style='opacity:.4;cursor:not-allowed'"} onclick="startReservation('${ev.id}')">
          ${ev.status === "closed" ? "Reservations Closed" : available === 0 ? "Sold Out" : "Reserve Seat"}
        </button>
      </div>
    </div>`;
}

function renderEvents() {
  let list = STATE.events.slice();
  if (STATE.eventFilter !== "all") {
    list = list.filter(ev => computeEventStatus(ev) === STATE.eventFilter);
  }
  if (STATE.eventSearch.trim()) {
    const q = STATE.eventSearch.toLowerCase();
    list = list.filter(ev => (ev.name + ev.description + ev.category + ev.organizer).toLowerCase().includes(q));
  }
  list.sort((a, b) => new Date(a.date + "T" + a.startTime) - new Date(b.date + "T" + b.startTime));

  const grid = document.getElementById("event-grid");
  grid.innerHTML = list.length ? list.map(eventCardHtml).join("") : `<div class="empty-state">No events match your filters.</div>`;

  requestAnimationFrame(() => {
    grid.querySelectorAll("[data-fill]").forEach(el => { el.style.width = el.dataset.fill + "%"; });
  });
}

document.getElementById("event-filters").addEventListener("click", e => {
  const btn = e.target.closest(".filter-tab");
  if (!btn) return;
  STATE.eventFilter = btn.dataset.filter;
  document.querySelectorAll("#event-filters .filter-tab").forEach(b => b.classList.toggle("active", b === btn));
  renderEvents();
});
document.getElementById("event-search").addEventListener("input", e => {
  STATE.eventSearch = e.target.value;
  renderEvents();
});

/* ===  RESERVATION FLOW  === */
function populateClassAndTeacherDropdowns() {
  const classOptions = `<option value="">Select class</option>` + CONFIG.CLASSES.map(c => `<option>${c}</option>`).join("");
  document.getElementById("s-class").innerHTML = classOptions;
  document.getElementById("p-student-class").innerHTML = classOptions;
  document.getElementById("s-teacher").innerHTML = `<option value="">Select teacher</option>` + CONFIG.TEACHERS.map(t => `<option>${t}</option>`).join("");
}

function startReservation(eventId) {
  const ev = STATE.events.find(e => e.id === eventId);
  if (!ev) return;
  const status = computeEventStatus(ev);
  if (status === "completed" || ev.status === "closed") { toast("Reservations are not open for this event."); return; }

  STATE.draft = {
    eventId,
    attendeeType: null,
    seatCount: 1,
    preference: "together",
    selectedSeats: [],
    holdId: null,
    form: {}
  };

  document.getElementById("reserve-event-summary").innerHTML = `
    <h4>${escapeHtml(ev.name)}</h4>
    <div class="event-meta">
      <span>📅 ${formatDateLong(ev.date)}</span>
      <span>🕒 ${formatTime12(ev.startTime)} – ${formatTime12(ev.endTime)}</span>
      <span>📍 ${escapeHtml(ev.location)}</span>
    </div>`;

  goToReserveStep(1);
  navigateTo("reserve");
}

function goToReserveStep(step) {
  document.querySelectorAll(".reserve-step").forEach(s => s.classList.toggle("hidden", Number(s.dataset.step) !== step));
  document.querySelectorAll(".rp-step").forEach(s => {
    const n = Number(s.dataset.step);
    s.classList.toggle("active", n === step);
    s.classList.toggle("done", n < step);
  });
  if (step === 3) {
    const ev = STATE.events.find(e => e.id === STATE.draft.eventId);
    const max = Math.min(STATE.settings.maxSeatsPerReservation, seatsForEvent(ev));
    document.getElementById("max-seat-hint").textContent = `You may reserve up to ${max} seat(s) per reservation.`;
    document.getElementById("seat-count").textContent = STATE.draft.seatCount;
  }
  if (step === 4) {
    renderSeatMapForReservation();
  }
}

document.getElementById("choice-student").addEventListener("click", () => {
  STATE.draft.attendeeType = "student";
  document.getElementById("step2-title").textContent = "Student Details";
  document.getElementById("student-form").classList.remove("hidden");
  document.getElementById("parent-form").classList.add("hidden");
  populateClassAndTeacherDropdowns();
  goToReserveStep(2);
});
document.getElementById("choice-parent").addEventListener("click", () => {
  STATE.draft.attendeeType = "parent";
  document.getElementById("step2-title").textContent = "Parent / Guardian Details";
  document.getElementById("parent-form").classList.remove("hidden");
  document.getElementById("student-form").classList.add("hidden");
  populateClassAndTeacherDropdowns();
  goToReserveStep(2);
});

document.querySelectorAll("[data-back]").forEach(btn => {
  btn.addEventListener("click", () => goToReserveStep(Number(btn.dataset.back)));
});

document.getElementById("to-step-3").addEventListener("click", () => {
  const type = STATE.draft.attendeeType;
  if (type === "student") {
    const name = document.getElementById("s-name").value.trim();
    const cls = document.getElementById("s-class").value;
    const teacher = document.getElementById("s-teacher").value;
    const email = document.getElementById("s-email").value.trim();
    if (!name || !cls || !teacher || !email) { toast("Please fill in all required fields."); return; }
    if (!validateEmail(email)) { toast("Please enter a valid email address."); return; }
    STATE.draft.form = { name, class: cls, group: document.getElementById("s-group").value.trim(), teacher, email };
  } else {
    const pname = document.getElementById("p-name").value.trim();
    const pphone = document.getElementById("p-phone").value.trim();
    const pemail = document.getElementById("p-email").value.trim();
    const rel = document.getElementById("p-relationship").value;
    const sname = document.getElementById("p-student-name").value.trim();
    const sclass = document.getElementById("p-student-class").value;
    const semail = document.getElementById("p-student-email").value.trim();
    if (!pname || !pphone || !pemail || !sname || !sclass) { toast("Please fill in all required fields."); return; }
    if (!validateEmail(pemail)) { toast("Please enter a valid email address."); return; }
    if (!validatePhone(pphone)) { toast("Please enter a valid contact number."); return; }
    if (semail && !validateEmail(semail)) { toast("Please enter a valid student email address."); return; }
    STATE.draft.form = { parentName: pname, phone: pphone, email: pemail, relationship: rel, studentName: sname, studentClass: sclass, studentEmail: semail };
  }
  goToReserveStep(3);
});

document.getElementById("seat-minus").addEventListener("click", () => {
  if (STATE.draft.seatCount > 1) { STATE.draft.seatCount--; document.getElementById("seat-count").textContent = STATE.draft.seatCount; }
});
document.getElementById("seat-plus").addEventListener("click", () => {
  const ev = STATE.events.find(e => e.id === STATE.draft.eventId);
  const max = Math.min(STATE.settings.maxSeatsPerReservation, seatsForEvent(ev));
  if (STATE.draft.seatCount < max) { STATE.draft.seatCount++; document.getElementById("seat-count").textContent = STATE.draft.seatCount; }
  else toast(`Maximum ${max} seats allowed per reservation.`);
});

document.querySelectorAll(".pref-choice").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pref-choice").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    STATE.draft.preference = btn.dataset.pref;
  });
});

document.getElementById("to-step-4").addEventListener("click", () => {
  STATE.draft.selectedSeats = [];
  goToReserveStep(4);
});

/* ---- Seat map rendering for the reservation flow ---- */
function seatLabel(rowIndex, colIndex) {
  const rowLetter = String.fromCharCode(65 + rowIndex);
  return `${rowLetter}${pad(colIndex + 1, 2)}`;
}

function getSeatStatus(eventId, label, seatIndexInEvent, totalForEvent, holdIdToExclude) {
  const confirmedSet = confirmedSeatSetForEvent(eventId);
  const heldSet = heldSeatSetForEvent(eventId, holdIdToExclude);
  if (seatIndexInEvent >= totalForEvent) return "unavailable";
  if (confirmedSet.has(label)) return "reserved";
  if (heldSet.has(label)) return "reserved"; // treat other users' active holds as temporarily unavailable
  return "available";
}

function renderSeatMapForReservation() {
  const ev = STATE.events.find(e => e.id === STATE.draft.eventId);
  const total = seatsForEvent(ev);
  const rows = STATE.settings.totalRows;
  const cols = STATE.settings.seatsPerRow;
  const wrap = document.getElementById("seatmap");
  wrap.innerHTML = "";
  let seatCounter = 0;

  for (let r = 0; r < rows; r++) {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = String.fromCharCode(65 + r);
    rowEl.appendChild(label);

    for (let c = 0; c < cols; c++) {
      if (c === Math.floor(cols / 2) && c !== 0) {
        const gap = document.createElement("span");
        gap.className = "seat-gap";
        rowEl.appendChild(gap);
      }
      const seatId = seatLabel(r, c);
      const idxInEvent = seatCounter;
      const status = getSeatStatus(ev.id, seatId, idxInEvent, total, STATE.draft.holdId);
      const seatEl = document.createElement("div");
      seatEl.className = "seat " + (STATE.draft.selectedSeats.includes(seatId) ? "selected" : status);
      seatEl.textContent = seatId;
      seatEl.title = seatId;
      if (status === "available") {
        seatEl.addEventListener("click", () => toggleSeatSelection(seatId));
      }
      rowEl.appendChild(seatEl);
      seatCounter++;
    }
    wrap.appendChild(rowEl);
  }
  updateSeatSelectedSummary();
}

function toggleSeatSelection(seatId) {
  const draft = STATE.draft;
  const idx = draft.selectedSeats.indexOf(seatId);
  if (idx > -1) {
    draft.selectedSeats.splice(idx, 1);
  } else {
    if (draft.selectedSeats.length >= draft.seatCount) {
      toast(`You selected ${draft.seatCount} seat(s). Deselect one to change your pick.`);
      return;
    }
    draft.selectedSeats.push(seatId);
    toast(`Seat ${seatId} has been selected.`);
  }
  renderSeatMapForReservation();
  syncHoldForSelection();
}

function updateSeatSelectedSummary() {
  const el = document.getElementById("seat-selected-summary");
  const draft = STATE.draft;
  el.textContent = draft.selectedSeats.length
    ? `Selected seats: ${draft.selectedSeats.slice().sort().join(", ")} (${draft.selectedSeats.length}/${draft.seatCount})`
    : "No seats selected yet. Click available seats above.";
}

/* ---- Temporary seat hold ---- */
function cleanExpiredHolds() {
  const now = Date.now();
  const before = STATE.holds.length;
  STATE.holds = STATE.holds.filter(h => h.expiresAt > now);
  if (STATE.holds.length !== before) lsSet(LS_KEYS.holds, STATE.holds);
}

function syncHoldForSelection() {
  cleanExpiredHolds();
  const draft = STATE.draft;
  if (!draft.selectedSeats.length) {
    if (draft.holdId) {
      STATE.holds = STATE.holds.filter(h => h.id !== draft.holdId);
      lsSet(LS_KEYS.holds, STATE.holds);
      draft.holdId = null;
    }
    stopHoldTimer();
    return;
  }
  const expiresAt = Date.now() + STATE.settings.holdDurationSeconds * 1000;
  if (!draft.holdId) draft.holdId = uid("hold");
  STATE.holds = STATE.holds.filter(h => h.id !== draft.holdId);
  STATE.holds.push({ id: draft.holdId, eventId: draft.eventId, seats: draft.selectedSeats.slice(), expiresAt });
  lsSet(LS_KEYS.holds, STATE.holds);
  startHoldTimer(expiresAt);
}

function startHoldTimer(expiresAt) {
  stopHoldTimer();
  const timerEl = document.getElementById("hold-timer");
  const clockEl = document.getElementById("hold-clock");
  timerEl.classList.remove("hidden");
  function tick() {
    const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const m = pad(Math.floor(remaining / 60), 2);
    const s = pad(remaining % 60, 2);
    clockEl.textContent = `${m}:${s}`;
    if (remaining <= 0) {
      stopHoldTimer();
      toast("Your seat hold expired and has been released.");
      STATE.draft.selectedSeats = [];
      STATE.draft.holdId = null;
      if (STATE.currentPage === "reserve") renderSeatMapForReservation();
    }
  }
  tick();
  STATE.holdTimerInterval = setInterval(tick, 1000);
}
function stopHoldTimer() {
  if (STATE.holdTimerInterval) clearInterval(STATE.holdTimerInterval);
  STATE.holdTimerInterval = null;
  document.getElementById("hold-timer").classList.add("hidden");
}

/* ---- Auto-select seats based on preference ---- */
function autoSelectSeats() {
  const ev = STATE.events.find(e => e.id === STATE.draft.eventId);
  const total = seatsForEvent(ev);
  const rows = STATE.settings.totalRows, cols = STATE.settings.seatsPerRow;
  const confirmedSet = confirmedSeatSetForEvent(ev.id);
  const heldSet = heldSeatSetForEvent(ev.id, STATE.draft.holdId);
  const need = STATE.draft.seatCount;

  // Build ordered list of all seat labels with availability, respecting per-event cap
  const allSeats = [];
  let counter = 0;
  for (let r = 0; r < rows; r++) {
    const rowSeats = [];
    for (let c = 0; c < cols; c++) {
      const label = seatLabel(r, c);
      const available = counter < total && !confirmedSet.has(label) && !heldSet.has(label);
      rowSeats.push({ label, available });
      counter++;
    }
    allSeats.push(rowSeats);
  }

  if (STATE.draft.preference === "together") {
    for (const row of allSeats) {
      for (let start = 0; start <= row.length - need; start++) {
        const slice = row.slice(start, start + need);
        if (slice.every(s => s.available)) {
          return slice.map(s => s.label);
        }
      }
    }
    return null; // not enough consecutive seats
  } else {
    const flat = allSeats.flat().filter(s => s.available);
    if (flat.length < need) return null;
    return flat.slice(0, need).map(s => s.label);
  }
}

document.getElementById("to-step-5").addEventListener("click", () => {
  const draft = STATE.draft;
  if (draft.selectedSeats.length !== draft.seatCount) {
    // Try to auto-fill remaining based on preference
    const auto = autoSelectSeats();
    if (!auto) {
      if (draft.preference === "together") {
        toast("Adjacent seats are not currently available for your group. Try “Any available seats”.");
      } else {
        toast("Not enough seats are currently available.");
      }
      return;
    }
    draft.selectedSeats = auto;
    syncHoldForSelection();
    renderSeatMapForReservation();
  }
  submitReservation();
});

/* ---- Submit reservation ---- */
function submitReservation() {
  const draft = STATE.draft;
  const ev = STATE.events.find(e => e.id === draft.eventId);
  const status = STATE.settings.requireApproval ? "pending" : "confirmed";

  const reservation = {
    id: nextReservationId(),
    eventId: ev.id,
    attendeeType: draft.attendeeType,
    seats: draft.selectedSeats.slice(),
    preference: draft.preference,
    status,
    createdAt: new Date().toISOString(),
    checkedInAt: null
  };

  if (draft.attendeeType === "student") {
    Object.assign(reservation, {
      attendeeName: draft.form.name,
      class: draft.form.class,
      group: draft.form.group,
      teacher: draft.form.teacher,
      email: draft.form.email
    });
  } else {
    Object.assign(reservation, {
      attendeeName: draft.form.parentName,
      phone: draft.form.phone,
      email: draft.form.email,
      relationship: draft.form.relationship,
      studentName: draft.form.studentName,
      studentClass: draft.form.studentClass,
      studentEmail: draft.form.studentEmail
    });
  }

  STATE.reservations.push(reservation);
  // release the hold — seats are now either pending or confirmed, so they occupy the map directly
  STATE.holds = STATE.holds.filter(h => h.id !== draft.holdId);
  lsSet(LS_KEYS.holds, STATE.holds);
  lsSet(LS_KEYS.reservations, STATE.reservations);
  stopHoldTimer();

  toast("Reservation created successfully.");
  renderConfirmationScreen(reservation, ev);
  goToReserveStep(5);

  // Automatically email the attendee.
  // If approval is enabled, this sends the initial
  // "Pending Approval" notification.
  sendEntryPassEmail(reservation, ev, {
    silent: true
  });
}

function renderConfirmationScreen(res, ev) {
  const statusLabel = res.status === "pending" ? "Pending Approval" : "Confirmed";
  document.getElementById("confirm-screen").innerHTML = `
    <div class="confirm-badge">✓</div>
    <h3>Reservation ${res.status === "pending" ? "Received" : "Confirmed"}</h3>
    <p>A digital entry pass has been generated for your reservation.</p>
    <div class="confirm-details">
      <div class="row"><span>Reservation ID</span><span>${res.id}</span></div>
      <div class="row"><span>Event</span><span>${escapeHtml(ev.name)}</span></div>
      <div class="row"><span>Attendee</span><span>${escapeHtml(res.attendeeName)}</span></div>
      <div class="row"><span>Attendee Type</span><span>${res.attendeeType === "student" ? "Student" : "Parent / Guardian"}</span></div>
      <div class="row"><span>Seats</span><span>${res.seats.join(", ")}</span></div>
      <div class="row"><span>Date</span><span>${formatDateLong(ev.date)}</span></div>
      <div class="row"><span>Time</span><span>${formatTime12(ev.startTime)}</span></div>
      <div class="row"><span>Status</span><span class="status-pill ${res.status}">${statusLabel}</span></div>
    </div>
    <div class="confirm-actions">
      <button class="btn btn-primary" onclick="openEntryPass('${res.id}')">View Entry Pass</button>
      <button class="btn btn-ghost" data-nav="my-reservations">View My Reservations</button>
    </div>
  `;
  document.querySelectorAll("#confirm-screen [data-nav]").forEach(el => {
    el.addEventListener("click", e => { e.preventDefault(); navigateTo(el.dataset.nav); });
  });
}

/* ===   ENTRY PASS + QR  === */
function buildQrPayload(res, ev) {
  return `AMS-PASS|${res.id}|EVENT:${ev.name}|DATE:${ev.date}|SEATS:${res.seats.join("-")}`;
}

function entryPassHtml(res, ev) {
  const qrUrl = CONFIG.QR_API + encodeURIComponent(buildQrPayload(res, ev));
  return `
    <div class="entry-pass">
      <div class="pass-brand">ABICS</div>
      <div class="pass-title">Auditorium Entry Pass</div>
      <div class="pass-row"><span>Event</span><span>${escapeHtml(ev.name)}</span></div>
      <div class="pass-row"><span>Attendee</span><span>${escapeHtml(res.attendeeName)}</span></div>
      <div class="pass-row"><span>Type</span><span>${res.attendeeType === "student" ? "Student" : "Parent / Guardian"}</span></div>
      ${res.attendeeType === "student" ? `<div class="pass-row"><span>Class</span><span>${escapeHtml(res.class)}</span></div>` : `<div class="pass-row"><span>Student Class</span><span>${escapeHtml(res.studentClass)}</span></div>`}
      <div class="pass-row"><span>Seats</span><span>${res.seats.join(", ")}</span></div>
      <div class="pass-row"><span>Date</span><span>${formatDateLong(ev.date)}</span></div>
      <div class="pass-row"><span>Time</span><span>${formatTime12(ev.startTime)}</span></div>
      <div class="pass-row"><span>Status</span><span>${res.status.charAt(0).toUpperCase() + res.status.slice(1)}</span></div>
      <div class="pass-qr"><img src="${qrUrl}" alt="QR code for reservation ${res.id}" width="140" height="140" /></div>
      <div class="pass-id">${res.id}</div>
    </div>`;
}

function openEntryPass(resId) {
  const res = STATE.reservations.find(r => r.id === resId);
  const ev = STATE.events.find(e => e.id === res.eventId);
  STATE.currentPassReservationId = resId;
  document.getElementById("pass-content").innerHTML = entryPassHtml(res, ev);
  openModal("pass-modal-overlay");
  toast("Entry pass generated.");
}
document.getElementById("pass-print-btn").addEventListener("click", () => window.print());
document.getElementById("pass-email-btn").addEventListener("click", () => {
  const res = STATE.reservations.find(r => r.id === STATE.currentPassReservationId);
  const ev = STATE.events.find(e => e.id === res.eventId);
  sendEntryPassEmail(res, ev);
});

/* ===  EMAIL DELIVERY (EmailJS)  === */
let emailSending = false;
const emailState = new Map();

function initEmail() {
  if (!window.emailjs) {
    console.warn("[ABICS AMS] EmailJS script did not load — check the <script src> tag in index.html and your internet connection.");
    return;
  }
  if (!CONFIG.EMAIL.PUBLIC_KEY) {
    console.warn("[ABICS AMS] CONFIG.EMAIL.PUBLIC_KEY is empty — email sending is disabled until it's set.");
    return;
  }
  emailjs.init({ publicKey: CONFIG.EMAIL.PUBLIC_KEY });
  console.log("[ABICS AMS] EmailJS initialized.");
}

function sendEntryPassEmail(res, ev, options = {}) {
  const { SERVICE_ID, TEMPLATE_ID, PUBLIC_KEY } = CONFIG.EMAIL;

  if (!SERVICE_ID || !TEMPLATE_ID || !PUBLIC_KEY) {
    console.warn("[ABICS AMS] Email not sent — CONFIG.EMAIL is incomplete:", CONFIG.EMAIL);
    if (!options.silent) toast("Email service is not configured. Your reservation has still been saved.");
    return Promise.resolve(false);
  }

  if (!window.emailjs) {
    console.error("[ABICS AMS] Email not sent — the EmailJS SDK is not loaded on this page.");
    if (!options.silent) toast("Email service failed to load. Check your internet connection and reload.");
    return Promise.resolve(false);
  }

  if (!res?.email || !ev) {
    if (!options.silent) {
      toast("A valid email address is required.");
    }
    return Promise.resolve(false);
  }

  const sendKey = `${res.id}:${res.status}`;

  if (emailState.get(sendKey) === "sent") {
    if (!options.silent) {
      toast("This reservation email has already been sent.");
    }
    return Promise.resolve(true);
  }

  const toEmail = res.email;
  const qrUrl =
    CONFIG.QR_API +
    encodeURIComponent(buildQrPayload(res, ev));

  const isStudent = res.attendeeType === "student";
  const statusLabel = res.status.charAt(0).toUpperCase() + res.status.slice(1);

  const params = {
    to_email: toEmail,
    to_name: res.attendeeName,

    subject:
      res.status === "confirmed"
        ? "ABICS AMS — Reservation Confirmed"
        : res.status === "rejected"
          ? "ABICS AMS — Reservation Rejected"
          : res.status === "cancelled"
            ? "ABICS AMS — Reservation Cancelled"
            : "ABICS AMS — Reservation Received",

    // Pass header
    brand_name: "ABICS",
    pass_title: "Auditorium Entry Pass",

    // Event details
    event_name: ev.name,
    event_date: formatDateLong(ev.date),
    event_time: formatTime12(ev.startTime),
    event_location: ev.location || "",

    // Attendee details
    attendee_name: res.attendeeName,
    attendee_type_label: isStudent ? "Student" : "Parent / Guardian",
    class_row_label: isStudent ? "Class" : "Student Class",
    class_row_value: isStudent ? (res.class || "") : (res.studentClass || ""),

    // Reservation details
    seats: res.seats.join(", "),
    reservation_id: res.id,
    status: res.status,
    status_label: statusLabel,

    // QR / pass image — embedded directly in the email template as an <img>
    qr_code_url: qrUrl
  };

  console.log("[ABICS AMS] Sending email via EmailJS…", { SERVICE_ID, TEMPLATE_ID, to: toEmail });

  // Pass the public key directly on the send call too (belt-and-suspenders —
  // works even if init() above ran before the SDK was ready).
  return emailjs
    .send(SERVICE_ID, TEMPLATE_ID, params, { publicKey: PUBLIC_KEY })
    .then(response => {
      console.log("[ABICS AMS] Email sent:", response.status, response.text);
      emailState.set(sendKey, "sent");

      if (!options.silent) {
        toast("Email sent successfully.");
      }

      return true;
    })
    .catch(err => {
      // Surface the real reason instead of swallowing it — this is almost
      // always an EmailJS dashboard config issue (see console for details).
      console.error("[ABICS AMS] EmailJS send failed:", err);
      const reason = (err && (err.text || err.message)) || "unknown error";

      if (!options.silent) {
        toast(`Email could not be sent: ${reason}`);
      }

      return false;
    });
}

/* ===  MY RESERVATION  === */
function renderMyReservations() {
  const list = document.getElementById("my-res-list");
  if (!STATE.reservations.length) {
    list.innerHTML = `<div class="empty-state">You haven't made any reservations yet. <br><a href="#events" data-nav="events" class="btn btn-primary" style="margin-top:16px;display:inline-flex;">Browse Events</a></div>`;
    list.querySelector("[data-nav]").addEventListener("click", e => { e.preventDefault(); navigateTo("events"); });
    return;
  }
  const sorted = STATE.reservations.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  list.innerHTML = sorted.map(res => {
    const ev = STATE.events.find(e => e.id === res.eventId) || {};
    const canCancel = res.status === "pending" || res.status === "confirmed";
    return `
      <div class="res-row">
        <div>
          <div class="res-id">${res.id}</div>
          <h5>${escapeHtml(ev.name || "Event removed")}</h5>
        </div>
        <div>${formatDateLong(ev.date || "")}</div>
        <div>Seats: ${res.seats.join(", ")}</div>
        <div><span class="status-pill ${res.status}">${res.status.replace("-", " ")}</span></div>
        <div class="res-actions">
          <button class="btn btn-ghost" onclick="openEntryPass('${res.id}')">View Pass</button>
          ${canCancel ? `<button class="btn btn-danger" onclick="cancelReservation('${res.id}')">Cancel</button>` : ""}
        </div>
      </div>`;
  }).join("");
}

function cancelReservation(resId) {
  confirmDialog("Cancel this reservation? Your seats will be released.", () => {
    const res = STATE.reservations.find(r => r.id === resId);
    if (!res) return;
    res.status = "cancelled";
    lsSet(LS_KEYS.reservations, STATE.reservations);
    toast("Reservation cancelled.");
    renderMyReservations();
    if (STATE.isAdmin) renderAdminTab(STATE.adminTab);
  });
}

/* ===  ADMIN — LOGIN  === */
document.getElementById("pin-form").addEventListener("submit", e => {
  e.preventDefault();
  const val = document.getElementById("pin-input").value.trim();
  if (val === STATE.settings.adminPin) {
    STATE.isAdmin = true;
    sessionStorage.setItem("ams_admin_session", "1");
    navigateTo("admin");
  } else {
    document.getElementById("pin-error").classList.remove("hidden");
  }
});
document.getElementById("admin-logout").addEventListener("click", () => {
  STATE.isAdmin = false;
  sessionStorage.removeItem("ams_admin_session");
  navigateTo("home");
});

/* ===  ADMIN — TAB ROUTING  === */
document.getElementById("admin-nav").addEventListener("click", e => {
  const btn = e.target.closest(".admin-nav-item");
  if (!btn) return;
  STATE.adminTab = btn.dataset.adminTab;
  document.querySelectorAll(".admin-nav-item").forEach(b => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".admin-tab").forEach(t => t.classList.toggle("hidden", t.dataset.adminTab !== STATE.adminTab));
  renderAdminTab(STATE.adminTab);
});

function renderAdminTab(tab) {
  if (tab === "dashboard") renderAdminDashboard();
  if (tab === "events") renderAdminEvents();
  if (tab === "reservations") renderAdminReservations();
  if (tab === "seats") renderAdminSeats();
  if (tab === "facilities") renderAdminFacilities();
  if (tab === "checkin") { /* rendered on demand */ }
  if (tab === "analytics") renderAdminAnalytics();
  if (tab === "settings") renderAdminSettings();
}

/* ---- Dashboard ---- */
function renderAdminDashboard() {
  const totalSeats = STATE.settings.totalRows * STATE.settings.seatsPerRow;
  const reservedAcross = STATE.reservations.filter(r => ["confirmed", "checked-in"].includes(r.status)).reduce((s, r) => s + r.seats.length, 0);
  const pending = STATE.reservations.filter(r => r.status === "pending").length;
  const confirmed = STATE.reservations.filter(r => r.status === "confirmed" || r.status === "checked-in").length;
  const upcoming = STATE.events.filter(ev => computeEventStatus(ev) === "upcoming").length;

  document.getElementById("admin-stats").innerHTML = [
    ["Total Seats", totalSeats], ["Reserved Seats", reservedAcross], ["Available Seats", Math.max(totalSeats - reservedAcross, 0)],
    ["Upcoming Events", upcoming], ["Pending Reservations", pending], ["Confirmed Reservations", confirmed]
  ].map(([label, val]) => `<div class="stat-card"><span class="stat-value">${val}</span><span class="stat-label">${label}</span></div>`).join("");

  const recent = STATE.reservations.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8);
  document.getElementById("admin-recent-table").innerHTML = tableHtml(
    ["ID", "Attendee", "Event", "Seats", "Status"],
    recent.map(r => {
      const ev = STATE.events.find(e => e.id === r.eventId) || {};
      return [r.id, escapeHtml(r.attendeeName), escapeHtml(ev.name || "—"), r.seats.join(", "), statusPillHtml(r.status)];
    })
  );
}

function tableHtml(headers, rows) {
  return `<thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.length ? rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}" style="color:var(--text-faint)">No records yet.</td></tr>`}</tbody>`;
}
function statusPillHtml(status) {
  return `<span class="status-pill ${status}">${status.replace("-", " ")}</span>`;
}

/* ---- Events management ---- */
function renderAdminEvents() {
  const rows = STATE.events.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).map(ev => {
    const status = computeEventStatus(ev);
    return [
      escapeHtml(ev.name), escapeHtml(ev.category), formatDateLong(ev.date),
      `${formatTime12(ev.startTime)}–${formatTime12(ev.endTime)}`,
      `${reservedSeatCountForEvent(ev.id)}/${seatsForEvent(ev)}`,
      `<span class="event-status-pill ${status}">${status}</span>` + (ev.status === "closed" ? ` <span class="event-status-pill closed">closed</span>` : ""),
      `<div class="table-actions">
        <button class="btn btn-ghost" onclick="editEvent('${ev.id}')">Edit</button>
        <button class="btn btn-ghost" onclick="duplicateEvent('${ev.id}')">Duplicate</button>
        <button class="btn btn-ghost" onclick="toggleEventClosed('${ev.id}')">${ev.status === "closed" ? "Reopen" : "Close"}</button>
        <button class="btn btn-danger" onclick="deleteEvent('${ev.id}')">Delete</button>
      </div>`
    ];
  });
  document.getElementById("admin-events-table").innerHTML = tableHtml(
    ["Name", "Category", "Date", "Time", "Seats", "Status", "Actions"], rows
  );
}

document.getElementById("new-event-btn").addEventListener("click", () => openEventModal(null));

function openEventModal(eventId) {
  STATE.editingEventId = eventId;
  const isEdit = !!eventId;
  document.getElementById("event-modal-title").textContent = isEdit ? "Edit Event" : "New Event";
  const form = document.getElementById("event-form");
  form.reset();
  if (isEdit) {
    const ev = STATE.events.find(e => e.id === eventId);
    document.getElementById("ev-id").value = ev.id;
    document.getElementById("ev-name").value = ev.name;
    document.getElementById("ev-category").value = ev.category;
    document.getElementById("ev-desc").value = ev.description;
    document.getElementById("ev-date").value = ev.date;
    document.getElementById("ev-location").value = ev.location;
    document.getElementById("ev-start").value = ev.startTime;
    document.getElementById("ev-end").value = ev.endTime;
    document.getElementById("ev-organizer").value = ev.organizer;
    document.getElementById("ev-maxseats").value = ev.maxSeats;
    document.getElementById("ev-status").value = ev.status;
  } else {
    document.getElementById("ev-id").value = "";
    document.getElementById("ev-maxseats").value = STATE.settings.totalRows * STATE.settings.seatsPerRow;
  }
  openModal("event-modal-overlay");
}
window.editEvent = id => openEventModal(id);
window.duplicateEvent = id => {
  const ev = STATE.events.find(e => e.id === id);
  const copy = { ...ev, id: uid("ev"), name: ev.name + " (Copy)", createdAt: new Date().toISOString() };
  STATE.events.push(copy);
  lsSet(LS_KEYS.events, STATE.events);
  toast("Event duplicated.");
  renderAdminEvents();
};
window.toggleEventClosed = id => {
  const ev = STATE.events.find(e => e.id === id);
  ev.status = ev.status === "closed" ? "open" : "closed";
  lsSet(LS_KEYS.events, STATE.events);
  toast(ev.status === "closed" ? "Reservations closed for this event." : "Reservations reopened.");
  renderAdminEvents();
};
window.deleteEvent = id => {
  confirmDialog("Delete this event? This cannot be undone.", () => {
    STATE.events = STATE.events.filter(e => e.id !== id);
    lsSet(LS_KEYS.events, STATE.events);
    toast("Event deleted.");
    renderAdminEvents();
  });
};

document.getElementById("event-form").addEventListener("submit", e => {
  e.preventDefault();
  const id = document.getElementById("ev-id").value;
  const maxSeats = Number(document.getElementById("ev-maxseats").value);
  const capacity = STATE.settings.totalRows * STATE.settings.seatsPerRow;
  if (maxSeats > capacity) { toast(`Maximum seats cannot exceed auditorium capacity (${capacity}).`); return; }
  if (id) {
    const reservedNow = reservedSeatCountForEvent(id);
    if (maxSeats < reservedNow) { toast(`Cannot reduce below the ${reservedNow} seat(s) already reserved.`); return; }
  }
  const data = {
    name: document.getElementById("ev-name").value.trim(),
    category: document.getElementById("ev-category").value,
    description: document.getElementById("ev-desc").value.trim(),
    date: document.getElementById("ev-date").value,
    location: document.getElementById("ev-location").value.trim(),
    startTime: document.getElementById("ev-start").value,
    endTime: document.getElementById("ev-end").value,
    organizer: document.getElementById("ev-organizer").value.trim(),
    maxSeats,
    status: document.getElementById("ev-status").value
  };
  if (data.endTime <= data.startTime) { toast("End time must be after start time."); return; }

  if (id) {
    Object.assign(STATE.events.find(e => e.id === id), data);
    toast("Event updated.");
  } else {
    STATE.events.push({ id: uid("ev"), createdAt: new Date().toISOString(), ...data });
    toast("Event created.");
  }
  lsSet(LS_KEYS.events, STATE.events);
  closeModal("event-modal-overlay");
  renderAdminEvents();
});

/* ---- Reservations management ---- */
function renderAdminReservations() {
  let list = STATE.reservations.slice();
  if (STATE.resFilter === "student" || STATE.resFilter === "parent") list = list.filter(r => r.attendeeType === STATE.resFilter);
  else if (STATE.resFilter !== "all") list = list.filter(r => r.status === STATE.resFilter);
  if (STATE.resSearch.trim()) {
    const q = STATE.resSearch.toLowerCase();
    list = list.filter(r => (r.id + r.attendeeName + (r.email || "")).toLowerCase().includes(q));
  }
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const rows = list.map(r => {
    const ev = STATE.events.find(e => e.id === r.eventId) || {};
    return [
      r.id, escapeHtml(r.attendeeName), r.attendeeType,
      r.attendeeType === "parent" ? escapeHtml(r.studentName || "—") : "—",
      escapeHtml(r.email || "—"), r.attendeeType === "parent" ? escapeHtml(r.phone || "—") : "—",
      escapeHtml(ev.name || "—"), r.seats.join(", "), formatDateLong(ev.date || ""),
      statusPillHtml(r.status),
      `<div class="table-actions">
        <button class="btn btn-ghost" onclick="viewReservation('${r.id}')">View</button>
        ${r.status === "pending" ? `<button class="btn btn-ghost" onclick="setReservationStatus('${r.id}','confirmed')">Approve</button><button class="btn btn-danger" onclick="setReservationStatus('${r.id}','rejected')">Reject</button>` : ""}
        ${["confirmed", "pending"].includes(r.status) ? `<button class="btn btn-danger" onclick="setReservationStatus('${r.id}','cancelled')">Cancel</button>` : ""}
      </div>`
    ];
  });
  document.getElementById("admin-res-table").innerHTML = tableHtml(
    ["ID", "Attendee", "Type", "Student", "Email", "Phone", "Event", "Seats", "Date", "Status", "Actions"], rows
  );
}
document.getElementById("res-filters").addEventListener("click", e => {
  const btn = e.target.closest(".filter-tab");
  if (!btn) return;
  STATE.resFilter = btn.dataset.resfilter;
  document.querySelectorAll("#res-filters .filter-tab").forEach(b => b.classList.toggle("active", b === btn));
  renderAdminReservations();
});
document.getElementById("res-search").addEventListener("input", e => { STATE.resSearch = e.target.value; renderAdminReservations(); });

window.setReservationStatus = (id, status) => {
  const doIt = () => {
    const r = STATE.reservations.find(x => x.id === id);
    r.status = status;
    lsSet(LS_KEYS.reservations, STATE.reservations);

    const ev = STATE.events.find(
      e => e.id === r.eventId
    );

    if (ev && r.email) {
      sendEntryPassEmail(r, ev, {
        silent: true
      });
    }

    toast(status === "confirmed" ? "Reservation approved." : status === "rejected" ? "Reservation rejected." : "Reservation cancelled.");
    renderAdminReservations();
    renderAdminDashboard();
  };
  if (status === "cancelled" || status === "rejected") confirmDialog(`Mark reservation ${id} as ${status}?`, doIt);
  else doIt();
};

window.viewReservation = id => {
  const r = STATE.reservations.find(x => x.id === id);
  const ev = STATE.events.find(e => e.id === r.eventId) || {};
  document.getElementById("res-modal-body").innerHTML = `
    <div class="confirm-details">
      <div class="row"><span>Reservation ID</span><span>${r.id}</span></div>
      <div class="row"><span>Event</span><span>${escapeHtml(ev.name || "—")}</span></div>
      <div class="row"><span>Attendee</span><span>${escapeHtml(r.attendeeName)}</span></div>
      <div class="row"><span>Type</span><span>${r.attendeeType}</span></div>
      <div class="row"><span>Email</span><span>${escapeHtml(r.email || "—")}</span></div>
      ${r.attendeeType === "parent" ? `<div class="row"><span>Phone</span><span>${escapeHtml(r.phone || "—")}</span></div><div class="row"><span>Student</span><span>${escapeHtml(r.studentName || "—")}</span></div>` : `<div class="row"><span>Class</span><span>${escapeHtml(r.class || "—")}</span></div>`}
      <div class="row"><span>Seats</span><span>${r.seats.join(", ")}</span></div>
      <div class="row"><span>Status</span><span>${statusPillHtml(r.status)}</span></div>
      <div class="row"><span>Created</span><span>${new Date(r.createdAt).toLocaleString()}</span></div>
    </div>
    <div class="step-nav"><button class="btn btn-primary" onclick="openEntryPass('${r.id}')">View Entry Pass</button></div>
  `;
  openModal("res-modal-overlay");
};

/* ---- Seats config ---- */
function renderAdminSeats() {
  document.getElementById("cfg-rows").value = STATE.settings.totalRows;
  document.getElementById("cfg-cols").value = STATE.settings.seatsPerRow;
  const wrap = document.getElementById("admin-seatmap");
  wrap.innerHTML = "";
  for (let r = 0; r < STATE.settings.totalRows; r++) {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = String.fromCharCode(65 + r);
    rowEl.appendChild(label);
    for (let c = 0; c < STATE.settings.seatsPerRow; c++) {
      if (c === Math.floor(STATE.settings.seatsPerRow / 2) && c !== 0) {
        const gap = document.createElement("span"); gap.className = "seat-gap"; rowEl.appendChild(gap);
      }
      const seatEl = document.createElement("div");
      seatEl.className = "seat available";
      seatEl.textContent = seatLabel(r, c);
      rowEl.appendChild(seatEl);
    }
    wrap.appendChild(rowEl);
  }
}
document.getElementById("apply-seat-config").addEventListener("click", () => {
  const rows = Number(document.getElementById("cfg-rows").value);
  const cols = Number(document.getElementById("cfg-cols").value);
  const newCapacity = rows * cols;
  const maxReservedAnywhere = Math.max(0, ...STATE.events.map(ev => reservedSeatCountForEvent(ev.id)));
  if (newCapacity < maxReservedAnywhere) {
    toast(`Cannot reduce capacity below ${maxReservedAnywhere} seats already reserved for an event.`);
    return;
  }
  STATE.settings.totalRows = rows;
  STATE.settings.seatsPerRow = cols;
  lsSet(LS_KEYS.settings, STATE.settings);
  toast("Auditorium layout updated.");
  renderAdminSeats();
});

/* ---- Facilities management ---- */
function renderAdminFacilities() {
  document.getElementById("admin-facility-grid").innerHTML = STATE.facilities.map(f => `
    <div class="facility-card">
      <span class="facility-icon">${f.icon || "🏛️"}</span>
      <h4>${escapeHtml(f.title)}</h4>
      <p>${escapeHtml(f.description)}</p>
      <div class="facility-admin-actions">
        <button class="btn btn-ghost" onclick="editFacility('${f.id}')">Edit</button>
        <button class="btn btn-danger" onclick="deleteFacility('${f.id}')">Delete</button>
      </div>
    </div>`).join("");
}
document.getElementById("new-facility-btn").addEventListener("click", () => openFacilityModal(null));
function openFacilityModal(id) {
  STATE.editingFacilityId = id;
  document.getElementById("facility-form").reset();
  document.getElementById("facility-modal-title").textContent = id ? "Edit Facility" : "New Facility";
  if (id) {
    const f = STATE.facilities.find(x => x.id === id);
    document.getElementById("fac-id").value = f.id;
    document.getElementById("fac-title").value = f.title;
    document.getElementById("fac-desc").value = f.description;
    document.getElementById("fac-icon").value = f.icon;
  } else {
    document.getElementById("fac-id").value = "";
  }
  openModal("facility-modal-overlay");
}
window.editFacility = id => openFacilityModal(id);
window.deleteFacility = id => {
  confirmDialog("Delete this facility?", () => {
    STATE.facilities = STATE.facilities.filter(f => f.id !== id);
    lsSet(LS_KEYS.facilities, STATE.facilities);
    toast("Facility deleted.");
    renderAdminFacilities();
  });
};
document.getElementById("facility-form").addEventListener("submit", e => {
  e.preventDefault();
  const id = document.getElementById("fac-id").value;
  const data = {
    title: document.getElementById("fac-title").value.trim(),
    description: document.getElementById("fac-desc").value.trim(),
    icon: document.getElementById("fac-icon").value.trim() || "🏛️"
  };
  if (!data.title) { toast("Please enter a facility title."); return; }
  if (id) Object.assign(STATE.facilities.find(f => f.id === id), data);
  else STATE.facilities.push({ id: uid("fac"), ...data });
  lsSet(LS_KEYS.facilities, STATE.facilities);
  toast("Facility saved.");
  closeModal("facility-modal-overlay");
  renderAdminFacilities();
});

/* ---- Check-in ---- */
document.getElementById("checkin-btn").addEventListener("click", performCheckin);
document.getElementById("checkin-input").addEventListener("keydown", e => { if (e.key === "Enter") performCheckin(); });
function performCheckin() {
  const val = document.getElementById("checkin-input").value.trim().toUpperCase();
  const result = document.getElementById("checkin-result");
  const r = STATE.reservations.find(x => x.id.toUpperCase() === val);
  if (!r) { result.innerHTML = `<p style="color:var(--danger)">No reservation found with that ID.</p>`; return; }
  const ev = STATE.events.find(e => e.id === r.eventId) || {};
  const alreadyIn = r.status === "checked-in";
  result.innerHTML = `
    <div class="confirm-details">
      <div class="row"><span>${alreadyIn ? "⚠ Already Checked In" : "✓ Valid Reservation"}</span><span></span></div>
      <div class="row"><span>Attendee</span><span>${escapeHtml(r.attendeeName)}</span></div>
      <div class="row"><span>Event</span><span>${escapeHtml(ev.name || "—")}</span></div>
      <div class="row"><span>Seats</span><span>${r.seats.join(", ")}</span></div>
      <div class="row"><span>Status</span><span>${statusPillHtml(r.status)}</span></div>
    </div>
    ${!alreadyIn && r.status === "confirmed" ? `<button class="btn btn-primary" id="do-checkin-btn">CHECK IN</button>` : ""}
    ${r.status === "pending" ? `<p style="color:var(--warn)">This reservation is still pending approval.</p>` : ""}
  `;
  const doBtn = document.getElementById("do-checkin-btn");
  if (doBtn) doBtn.addEventListener("click", () => {
    r.status = "checked-in";
    r.checkedInAt = new Date().toISOString();
    lsSet(LS_KEYS.reservations, STATE.reservations);
    toast("Attendee checked in.");
    performCheckin();
  });
}

/* ---- Analytics ---- */
function renderAdminAnalytics() {
  const totalSeats = STATE.settings.totalRows * STATE.settings.seatsPerRow;
  const reservedAcross = STATE.reservations.filter(r => ["confirmed", "checked-in"].includes(r.status)).reduce((s, r) => s + r.seats.length, 0);
  const occupancy = totalSeats ? Math.round((reservedAcross / totalSeats) * 100) : 0;
  const students = STATE.reservations.filter(r => r.attendeeType === "student").length;
  const parents = STATE.reservations.filter(r => r.attendeeType === "parent").length;
  const cancellations = STATE.reservations.filter(r => r.status === "cancelled" || r.status === "rejected").length;
  const checkedIn = STATE.reservations.filter(r => r.status === "checked-in").length;
  const confirmedCount = STATE.reservations.filter(r => r.status === "confirmed" || r.status === "checked-in").length;

  document.getElementById("analytics-stats").innerHTML = [
    ["Occupancy", occupancy + "%"], ["Confirmed", confirmedCount], ["Cancellations", cancellations],
    ["Checked In", checkedIn], ["Student Reservations", students], ["Parent Reservations", parents]
  ].map(([label, val]) => `<div class="stat-card"><span class="stat-value">${val}</span><span class="stat-label">${label}</span></div>`).join("");

  const perEvent = STATE.events.map(ev => ({ name: ev.name, count: reservedSeatCountForEvent(ev.id), total: seatsForEvent(ev) }));
  const maxCount = Math.max(1, ...perEvent.map(e => e.total));

  document.getElementById("analytics-charts").innerHTML = `
    <div class="chart-card">
      <h4>Reservations per Event</h4>
      ${perEvent.map(e => `
        <div class="bar-chart-row">
          <span class="label">${escapeHtml(e.name)}</span>
          <span class="track"><span class="fill" style="width:${Math.round((e.count / maxCount) * 100)}%"></span></span>
          <span class="val">${e.count}</span>
        </div>`).join("") || "<p>No events yet.</p>"}
    </div>
    <div class="chart-card">
      <h4>Student vs Parent Reservations</h4>
      <div class="bar-chart-row"><span class="label">Students</span><span class="track"><span class="fill" style="width:${students + parents ? Math.round(students / (students + parents) * 100) : 0}%"></span></span><span class="val">${students}</span></div>
      <div class="bar-chart-row"><span class="label">Parents</span><span class="track"><span class="fill" style="width:${students + parents ? Math.round(parents / (students + parents) * 100) : 0}%"></span></span><span class="val">${parents}</span></div>
    </div>
  `;
}

/* ---- Settings ---- */
function renderAdminSettings() {
  document.getElementById("cfg-max-seats").value = STATE.settings.maxSeatsPerReservation;
  document.getElementById("cfg-require-approval").value = String(STATE.settings.requireApproval);
  document.getElementById("cfg-hold-duration").value = STATE.settings.holdDurationSeconds;
  document.getElementById("cfg-admin-pin").value = STATE.settings.adminPin;
}
document.getElementById("save-settings-btn").addEventListener("click", () => {
  const pin = document.getElementById("cfg-admin-pin").value.trim();
  if (!/^\d{4,8}$/.test(pin)) { toast("PIN must be 4–8 digits."); return; }
  STATE.settings.maxSeatsPerReservation = Math.max(1, Number(document.getElementById("cfg-max-seats").value));
  STATE.settings.requireApproval = document.getElementById("cfg-require-approval").value === "true";
  STATE.settings.holdDurationSeconds = Math.max(30, Number(document.getElementById("cfg-hold-duration").value));
  STATE.settings.adminPin = pin;
  lsSet(LS_KEYS.settings, STATE.settings);
  toast("Settings saved.");
});

document.getElementById("export-data-btn").addEventListener("click", () => {
  const data = { events: STATE.events, reservations: STATE.reservations, facilities: STATE.facilities, settings: STATE.settings };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ams-data-export.json";
  a.click();
  toast("Data exported.");
});
document.getElementById("import-data-input").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.events) STATE.events = data.events;
      if (data.reservations) STATE.reservations = data.reservations;
      if (data.facilities) STATE.facilities = data.facilities;
      if (data.settings) STATE.settings = data.settings;
      persistAll();
      toast("Data imported successfully.");
      renderAdminTab(STATE.adminTab);
    } catch (err) {
      toast("Import failed: invalid JSON file.");
    }
  };
  reader.readAsText(file);
});
document.getElementById("reset-data-btn").addEventListener("click", () => {
  confirmDialog("Reset all demo data? This will erase all events, reservations and settings on this device.", () => {
    localStorage.removeItem(LS_KEYS.events);
    localStorage.removeItem(LS_KEYS.reservations);
    localStorage.removeItem(LS_KEYS.facilities);
    localStorage.removeItem(LS_KEYS.settings);
    localStorage.removeItem(LS_KEYS.holds);
    localStorage.removeItem(LS_KEYS.seeded);
    toast("Demo data reset.");
    setTimeout(() => location.reload(), 700);
  });
});

/* ===  DEMO DATA SEEDING  === */
function seedDemoData() {
  const today = new Date();
  const iso = (daysFromNow) => {
    const d = new Date(today);
    d.setDate(d.getDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
  };

  const events = [
    { id: uid("ev"), name: "Parent Orientation Seminar", category: "Seminar",
      description: "Briefing session for parents on the upcoming academic term.",
      date: iso(3), startTime: "09:00", endTime: "11:00", location: "Syed Muntajibuddin Ahmed Auditorium",
      organizer: "Admissions Office", maxSeats: 80, status: "open", createdAt: new Date().toISOString() },
    { id: uid("ev"), name: "Quiz Competition", category: "Competition",
      description: "Inter-class quiz competition testing general knowledge and academic subjects.",
      date: iso(12), startTime: "11:00", endTime: "13:00", location: "Syed Muntajibuddin Ahmed Auditorium",
      organizer: "Academics Office", maxSeats: 96, status: "open", createdAt: new Date().toISOString() },
    { id: uid("ev"), name: "Inter-Class Competition", category: "Competition",
      description: "Quiz and debate finals between senior classes.",
      date: iso(20), startTime: "11:00", endTime: "13:30", location: "Syed Muntajibuddin Ahmed Auditorium",
      organizer: "Academics Office", maxSeats: 96, status: "open", createdAt: new Date().toISOString() },
    { id: uid("ev"), name: "Zonal Competition", category: "Competition",
      description: "Zonal-level competition representing the college against other institutions in the zone.",
      date: iso(30), startTime: "10:00", endTime: "14:00", location: "Syed Muntajibuddin Ahmed Auditorium",
      organizer: "Academics Office", maxSeats: 96, status: "open", createdAt: new Date().toISOString() },
    { id: uid("ev"), name: "Annual Prize Distribution Ceremony", category: "Academic",
      description: "Recognition of outstanding students for academic and co-curricular achievement over the year.",
      date: iso(45), startTime: "10:00", endTime: "13:00", location: "Syed Muntajibuddin Ahmed Auditorium",
      organizer: "College Administration", maxSeats: 96, status: "open", createdAt: new Date().toISOString() },
    { id: uid("ev"), name: "Iqbal Day", category: "Cultural",
      description: "A commemorative programme of speeches and poetry marking the birth anniversary of Allama Iqbal.",
      date: "2026-11-09", startTime: "10:00", endTime: "12:00", location: "Syed Muntajibuddin Ahmed Auditorium",
      organizer: "College Administration", maxSeats: 96, status: "open", createdAt: new Date().toISOString() },
    { id: uid("ev"), name: "Independence Day", category: "Cultural",
      description: "A celebration of the academic year with performances and awards.",
      date: "2027-08-14", startTime: "16:00", endTime: "19:00", location: "Syed Muntajibuddin Ahmed Auditorium",
      organizer: "College Administration", maxSeats: 96, status: "open", createdAt: new Date().toISOString() }
  ];

  const facilities = [
    { id: uid("fac"), title: "Stage & Presentations", icon: "🎤", description: "A raised stage suited for speeches, ceremonies and formal presentations." },
    { id: uid("fac"), title: "Multimedia", icon: "🖥️", description: "Projection and sound equipment supporting slides, video and audio playback." },
    { id: uid("fac"), title: "Academic Events", icon: "📘", description: "Space for lectures, seminars and academic ceremonies." },
    { id: uid("fac"), title: "Cultural Activities", icon: "🎭", description: "A flexible setting for performances, showcases and celebrations." },
    { id: uid("fac"), title: "Assemblies", icon: "🏫", description: "Accommodates full-college assemblies and briefings." },
    { id: uid("fac"), title: "Auditorium Seating", icon: "💺", description: "Tiered rows of seating configurable by the administration." },
    { id: uid("fac"), title: "Seminars", icon: "🗂️", description: "A suitable venue for guest lectures and orientation sessions." },
    { id: uid("fac"), title: "Student Activities", icon: "🙌", description: "Hosts student council events, competitions and club activities." }
  ];

  STATE.events = events;
  STATE.facilities = facilities;
  STATE.reservations = [];
  STATE.settings = { ...CONFIG.DEFAULT_SETTINGS };
  STATE.holds = [];
  persistAll();

  // A few demo reservations so the seat map and dashboards aren't empty.
  const ev1 = events[0];
  STATE.reservations.push({
    id: nextReservationId(), eventId: ev1.id, attendeeType: "student",
    attendeeName: "Zainab Farooq", class: "11th - Pre-Medical", group: "Biology", teacher: "Ms. Ayesha Noor",
    email: "zainab.demo@example.com", seats: ["A01", "A02"], preference: "together",
    status: "confirmed", createdAt: new Date().toISOString(), checkedInAt: null
  });
  STATE.reservations.push({
    id: nextReservationId(), eventId: ev1.id, attendeeType: "parent",
    attendeeName: "Muhammad Asif", phone: "0321-1234567", email: "asif.demo@example.com",
    relationship: "Father", studentName: "Bilal Asif", studentClass: "9th - Science A", studentEmail: "",
    seats: ["B05"], preference: "any", status: "pending", createdAt: new Date().toISOString(), checkedInAt: null
  });
  lsSet(LS_KEYS.reservations, STATE.reservations);
  localStorage.setItem(LS_KEYS.seeded, "1");
}

/* ===  INIT  === */
function loadState() {
  STATE.settings = lsGet(LS_KEYS.settings, null);
  STATE.events = lsGet(LS_KEYS.events, null);
  STATE.facilities = lsGet(LS_KEYS.facilities, null);
  STATE.reservations = lsGet(LS_KEYS.reservations, null);
  STATE.holds = lsGet(LS_KEYS.holds, []);

  const seeded = localStorage.getItem(LS_KEYS.seeded);
  if (!seeded || !STATE.settings || !STATE.events || !STATE.facilities || !STATE.reservations) {
    seedDemoData();
  }
  STATE.isAdmin = sessionStorage.getItem("ams_admin_session") === "1";
}

function init() {
  loadState();
  initEmail();
  cleanExpiredHolds();
  const startPage = (location.hash || "#home").replace("#", "");
  navigateTo(["home","facilities","events","gallery","my-reservations","about","admin-login","admin"].includes(startPage) ? startPage : "home");

  // periodic hold cleanup so stale holds free up seats even if no one is on the seat step
  setInterval(() => { cleanExpiredHolds(); }, 5000);
}

document.addEventListener("DOMContentLoaded", init);
