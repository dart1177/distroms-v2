// Imports
import { auth, db, storage } from './firebase-config.js';
import { requireRole, logout } from './auth.js';
import { showToast, openModal, closeModal } from './ui.js';
import {
  collection, query, where, onSnapshot, doc, getDoc, updateDoc,
  serverTimestamp, addDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// State
let currentUser = null;
let currentProfile = null;
let effectiveDriverId = null; // Session impersonated driver or authenticated user
let isTestMode = false;

let challans = [];          // today's assigned challans
let map = null;
let markers = [];
let routeLine = null;
let unsubChallans = null;

let isGpsBroadcasting = true; // User can pause via app bar toggle
let lastLocationPushTime = 0;
let currentPodChallanId = null;
let selectedReceived = null; // true | false | null
let pendingPhotoFile = null;
let currentLang = 'en-IN';

/**
 * Initializes the driver application after authenticating driver role or verifying test mode.
 */
async function init() {
  try {
    // Check for test mode impersonation from Distributor
    if (sessionStorage.__viewAs === "driver" && sessionStorage.__asDriver) {
      isTestMode = true;
      const res = await requireRole("distributor");
      currentUser = res.user;

      effectiveDriverId = sessionStorage.__asDriver;
      const driverDocSnap = await getDoc(doc(db, "users", effectiveDriverId));
      currentProfile = driverDocSnap.exists()
        ? driverDocSnap.data()
        : { name: "Driver", role: "driver" };

      setupTestModeBanner();
    } else {
      // Standard driver authentication
      const res = await requireRole("driver");
      currentUser = res.user;
      currentProfile = res.profile;
      effectiveDriverId = currentUser.uid;
    }

    const driverNameEl = document.getElementById("driverName");
    if (driverNameEl) {
      driverNameEl.textContent = `Hi ${currentProfile.name || "Driver"}`;
    }

    const dot = document.getElementById("statusDot");
    if (dot) dot.classList.add("is-online");
    const statusText = document.getElementById("statusText");
    if (statusText) statusText.textContent = "Online";

    initMap();
    subscribeChallans();
    setupLogout();
    setupPodForm();
    setupVoiceNotes();
    setupStartRoute();
    setupStatusToggle();
    startGpsBroadcast();
    setupLifecycleListeners();
  } catch (err) {
    console.warn("Driver init skipped:", err?.message);
  }
}

/**
 * Wires the test-mode banner with "Return to Distributor" button.
 */
function setupTestModeBanner() {
  const banner = document.getElementById("testModeBanner");
  const label = document.getElementById("testModeBannerLabel");
  const returnBtn = document.getElementById("returnToDistributorBtn");

  if (banner) banner.style.display = "block";
  if (label) label.textContent = `🧪 Test mode: viewing as Driver (${currentProfile.name || "Driver"})`;

  returnBtn?.addEventListener("click", () => {
    delete sessionStorage.__viewAs;
    delete sessionStorage.__asDriver;
    showToast("Returning to Distributor view...", "info");
    setTimeout(() => {
      window.location.href = "distributor.html";
    }, 200);
  });
}

/**
 * Initializes the Leaflet map in #driverMap.
 */
function initMap() {
  const mapEl = document.getElementById("driverMap");
  if (!mapEl) return;
  map = L.map("driverMap").setView([20.5937, 78.9629], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);
}

/**
 * Subscribes in real-time to today's assigned delivery challans for the active driver.
 */
function subscribeChallans() {
  if (!effectiveDriverId) return;
  const q = query(
    collection(db, "delivery_challans"),
    where("driverId", "==", effectiveDriverId)
  );
  unsubChallans = onSnapshot(q, async (snap) => {
    challans = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => c.status === "assigned" || c.status === "out_for_delivery");
    renderSummary();
    await renderMapAndRoute();
    renderDeliveryList();
  }, (err) => console.error("Challan listener error:", err));
}

/**
 * Renders the driver summary card with stop count and total COD amount.
 */
function renderSummary() {
  const count = challans.length;
  const todayCountEl = document.getElementById("todayCount");
  if (todayCountEl) {
    todayCountEl.textContent = `${count} ${count === 1 ? "delivery" : "deliveries"} assigned`;
  }
  const cod = challans.reduce((a, c) => a + (Number(c.total) || 0), 0);
  const todayMetaEl = document.getElementById("todayMeta");
  if (todayMetaEl) {
    todayMetaEl.textContent = count > 0
      ? `Total COD: ₹${cod.toLocaleString("en-IN")}`
      : "All caught up 🎉";
  }
}

/**
 * Renders numbered markers for each shop on the map and invokes route drawing.
 */
async function renderMapAndRoute() {
  if (!map) return;

  // Clear old markers + route
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

  if (challans.length === 0) return;

  const bounds = [];

  challans.forEach((c, idx) => {
    const lat = Number(c.shopLatitude)  || (20.5937 + (idx * 0.01));
    const lng = Number(c.shopLongitude) || (78.9629 + (idx * 0.01));

    const icon = L.divIcon({
      className: "stop-marker",
      html: `<div style="background:#059669;color:white;width:30px;
             height:30px;border-radius:50%;display:flex;align-items:center;
             justify-content:center;font-weight:700;border:3px solid white;
             box-shadow:0 2px 8px rgba(0,0,0,0.3);">${idx + 1}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    const m = L.marker([lat, lng], { icon })
      .bindPopup(`<strong>${escapeHtml(c.shopName)}</strong><br>
                  ₹${(Number(c.total) || 0).toLocaleString("en-IN")} COD`);
    m.addTo(map);
    markers.push(m);
    bounds.push([lat, lng]);
  });

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }

  await drawRoute();
}

/**
 * Draws the driving route between stops using OSRM with graceful fallback.
 */
async function drawRoute() {
  if (!map) return;
  const pts = challans
    .map((c) => [Number(c.shopLatitude), Number(c.shopLongitude)])
    .filter(([lat, lng]) => lat && lng && !isNaN(lat) && !isNaN(lng));
  if (pts.length < 2) return;

  const coords = pts.map(([lat, lng]) => `${lng},${lat}`).join(";");
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}` +
                `?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) return;

    const line = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    routeLine = L.polyline(line, { color: "#059669", weight: 5, opacity: 0.8 })
      .addTo(map);

    const km = (route.distance / 1000).toFixed(1);
    const min = Math.round(route.duration / 60);
    const metaEl = document.getElementById("todayMeta");
    if (metaEl) {
      metaEl.textContent += ` • ${km} km • ~${min} min`;
    }
  } catch (err) {
    console.warn("OSRM failed, using straight lines:", err);
    routeLine = L.polyline(pts, { color: "#94a3b8", dashArray: "6 8" })
      .addTo(map);
  }
}

/**
 * Renders the delivery cards list with Navigate and Deliver buttons.
 */
function renderDeliveryList() {
  const list = document.getElementById("deliveryList");
  if (!list) return;

  if (challans.length === 0) {
    list.innerHTML = `
      <div class="driver-empty">
        <i class="fa-solid fa-check-circle"></i>
        <div>All caught up!</div>
        <div style="font-size:12px;margin-top:4px;">
          No pending deliveries right now.
        </div>
      </div>`;
    return;
  }

  list.innerHTML = challans.map((c, i) => `
    <div class="delivery-card status-${c.status === "out_for_delivery"
      ? "transit" : "assigned"}">
      <div class="delivery-card__header">
        <div style="display:flex;align-items:flex-start;">
          <div class="delivery-card__stop-num">${i + 1}</div>
          <div>
            <div class="delivery-card__shop">${escapeHtml(c.shopName)}</div>
            <div class="delivery-card__meta">
              <span><i class="fa-solid fa-box"></i>
                ${(c.items || []).length} item(s)</span>
              <span><i class="fa-solid fa-rupee-sign"></i>
                ${(Number(c.total) || 0).toLocaleString("en-IN")}</span>
              <span><i class="fa-solid fa-hashtag"></i>
                ${escapeHtml(c.challanNumber)}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="delivery-card__actions">
        <button class="btn" data-action="navigate"
                data-id="${c.id}"
                style="background:#eff6ff;color:#2563eb;">
          <i class="fa-solid fa-location-arrow"></i> Navigate
        </button>
        <button class="btn btn--primary" data-action="deliver"
                data-id="${c.id}">
          <i class="fa-solid fa-camera"></i> Deliver
        </button>
      </div>
    </div>`).join("");

  list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = challans.find((x) => x.id === btn.dataset.id);
      if (!c) return;
      if (btn.dataset.action === "navigate") {
        if (c.shopLatitude && c.shopLongitude) {
          window.open(
            `https://www.google.com/maps/dir/?api=1&destination=${c.shopLatitude},${c.shopLongitude}`,
            "_blank"
          );
        } else {
          showToast("Shop location not available", "warning");
        }
      } else if (btn.dataset.action === "deliver") {
        openPodModal(c);
      }
    });
  });
}

/**
 * Opens the PoD (Proof of Delivery) modal for a specified challan.
 * @param {object} challan
 */
function openPodModal(challan) {
  currentPodChallanId = challan.id;
  selectedReceived = null;
  pendingPhotoFile = null;

  document.getElementById("podShopName").textContent = challan.shopName;
  document.getElementById("podChallanId").value = challan.id;
  document.getElementById("notReceivedReason").value = "";
  document.getElementById("podNotes").value = "";
  document.getElementById("podCash").value = Number(challan.total) || 0;

  const preview = document.getElementById("photoPreview");
  if (preview) {
    preview.src = "";
    preview.classList.remove("is-visible");
  }

  document.getElementById("reasonField").style.display = "none";
  document.getElementById("cashField").style.display = "";

  document.querySelectorAll("#receivedToggle button")
    .forEach((b) => b.classList.remove("is-selected"));

  openModal("podModal");
}

function setupReceivedToggle() {
  document.querySelectorAll("#receivedToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#receivedToggle button")
        .forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
      selectedReceived = btn.dataset.value === "true";
      document.getElementById("reasonField").style.display =
        selectedReceived ? "none" : "";
      document.getElementById("cashField").style.display =
        selectedReceived ? "" : "none";
    });
  });
}

function setupPhotoCapture() {
  document.getElementById("takePhotoBtn")?.addEventListener("click", () => {
    document.getElementById("podPhoto").click();
  });
  document.getElementById("podPhoto")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingPhotoFile = file;
    const preview = document.getElementById("photoPreview");
    preview.src = URL.createObjectURL(file);
    preview.classList.add("is-visible");
  });
}

function setupVoiceNotes() {
  const btn = document.getElementById("voiceNotesBtn");
  const label = document.getElementById("voiceNotesLabel");
  const textarea = document.getElementById("notReceivedReason");
  const langToggle = document.getElementById("voiceLangToggle");
  const langLabel = document.getElementById("voiceLangLabel");
  const hintEl = document.getElementById("voiceHint");

  if (!btn || !textarea) return;

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    btn.disabled = true;
    if (label) label.textContent = "Unsupported";
    if (hintEl) hintEl.textContent = "Voice input not supported in this browser";
    return;
  }

  let recognition = null;
  let listening = false;

  function start() {
    recognition = new SpeechRecognition();
    recognition.lang = currentLang;
    recognition.continuous = true;
    recognition.interimResults = true;

    let baseText = textarea.value;

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].final) finalText += t;
        else interimText += t;
      }
      textarea.value = (baseText + " " + finalText).trim();
      if (hintEl) {
        hintEl.textContent = interimText ? `Listening… "${interimText}"` : "Listening…";
      }
    };

    recognition.onerror = (e) => {
      console.warn("Speech error:", e.error);
      if (e.error === "not-allowed") {
        showToast("Microphone permission denied", "error");
      }
      stop();
    };

    recognition.onend = () => {
      if (listening) {
        try { recognition.start(); } catch (_) { stop(); }
      }
    };

    try {
      recognition.start();
      listening = true;
      btn.classList.add("is-listening");
      if (label) label.textContent = "Stop";
      if (hintEl) hintEl.textContent = "Listening…";
    } catch (err) {
      console.warn("Start recognition error:", err);
      stop();
    }
  }

  function stop() {
    listening = false;
    if (recognition) { try { recognition.stop(); } catch (_) {} }
    btn.classList.remove("is-listening");
    if (label) label.textContent = "Speak";
    if (hintEl) hintEl.textContent = "Tap Speak to dictate";
  }

  btn.addEventListener("click", () => listening ? stop() : start());

  langToggle?.addEventListener("click", () => {
    currentLang = currentLang === "en-IN" ? "hi-IN" : "en-IN";
    if (langLabel) langLabel.textContent = currentLang === "en-IN" ? "EN" : "हि";
    if (listening) { stop(); setTimeout(start, 250); }
  });
}

function setupStartRoute() {
  document.getElementById("startRouteBtn")?.addEventListener("click", () => {
    if (challans.length === 0) {
      showToast("No deliveries assigned", "info");
      return;
    }
    challans.filter((c) => c.status === "assigned").forEach(async (c) => {
      try {
        await updateDoc(doc(db, "delivery_challans", c.id), {
          status: "out_for_delivery",
          updatedAt: serverTimestamp()
        });
      } catch (e) { console.warn(e); }
    });
    showToast("Route started — good luck! 🚚", "success");
  });
}

function setupPodForm() {
  setupReceivedToggle();
  setupPhotoCapture();

  document.getElementById("podForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("podSubmitBtn");
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
      if (selectedReceived === null) {
        showToast("Please select Received or Not received", "warning");
        btn.disabled = false;
        btn.innerHTML = "Confirm & Complete";
        return;
      }
      if (!pendingPhotoFile) {
        showToast("Please take a photo proof", "warning");
        btn.disabled = false;
        btn.innerHTML = "Confirm & Complete";
        return;
      }
      const reason = document.getElementById("notReceivedReason").value.trim();
      if (!selectedReceived && !reason) {
        showToast("Please state why not received", "warning");
        btn.disabled = false;
        btn.innerHTML = "Confirm & Complete";
        return;
      }

      const path = `pod/${currentPodChallanId}/${Date.now()}.jpg`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, pendingPhotoFile);
      const photoUrl = await getDownloadURL(storageRef);

      const pod = {
        photoUrl,
        photoPath: path,
        received: selectedReceived,
        reason: selectedReceived ? null : reason,
        notes: document.getElementById("podNotes").value.trim() || null,
        collectedAmount: selectedReceived ? (Number(document.getElementById("podCash").value) || 0) : 0,
        method: "Cash",
        timestamp: Date.now()
      };

      await updateDoc(doc(db, "delivery_challans", currentPodChallanId), {
        status: selectedReceived ? "delivered" : "not_received",
        pod,
        deliveredAt: selectedReceived ? serverTimestamp() : null,
        updatedAt: serverTimestamp()
      });

      showToast(selectedReceived ? "✅ Delivery recorded!" : "Marked not received", "success");
      closeModal("podModal");
    } catch (err) {
      console.error("PoD submit error:", err);
      showToast("Could not save delivery", "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = "Confirm & Complete";
    }
  });
}

// ── GPS Broadcast (Section D) ──────────────────────────────────────

/**
 * Broadcasts driver location via navigator.geolocation.watchPosition every position update to driver_locations/{effectiveDriverId}.
 */
function startGpsBroadcast() {
  if (!navigator.geolocation) {
    console.warn("Geolocation not supported by device");
    return;
  }
  if (window.__watchId != null) return;

  isGpsBroadcasting = true;

  window.__watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      if (!isGpsBroadcasting || !effectiveDriverId) return;

      const now = Date.now();
      // Throttle broadcast pushes to ~10-15s to keep Firestore responsive
      if (now - lastLocationPushTime < 10000) return;
      lastLocationPushTime = now;

      const { latitude, longitude, heading, speed } = pos.coords;
      try {
        await setDoc(doc(db, "driver_locations", effectiveDriverId), {
          driverId: effectiveDriverId,
          driverName: currentProfile?.name || "Driver",
          lat: latitude,
          lng: longitude,
          heading: heading || 0,
          speed: speed || 0,
          isOnline: true,
          updatedAt: Date.now()
        }, { merge: true });
      } catch (e) {
        console.warn("GPS push failed:", e);
      }
    },
    (err) => console.warn("GPS watch error:", err),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 }
  );
}

function stopGpsBroadcast() {
  if (window.__watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(window.__watchId);
    window.__watchId = null;
  }
}

async function markOffline() {
  if (!effectiveDriverId) return;
  try {
    await setDoc(doc(db, "driver_locations", effectiveDriverId), {
      isOnline: false,
      updatedAt: Date.now()
    }, { merge: true });
  } catch (err) {
    console.warn("Mark offline failed:", err);
  }
}

function setupStatusToggle() {
  const toggleBtn = document.getElementById("gpsToggleBtn");
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");

  if (!toggleBtn) return;

  toggleBtn.addEventListener("click", async () => {
    isGpsBroadcasting = !isGpsBroadcasting;

    if (isGpsBroadcasting) {
      if (dot) dot.classList.add("is-online");
      if (text) text.textContent = "Online";
      startGpsBroadcast();
      showToast("GPS broadcast resumed (Online)", "success");
    } else {
      if (dot) dot.classList.remove("is-online");
      if (text) text.textContent = "Offline";
      stopGpsBroadcast();
      await markOffline();
      showToast("GPS broadcast paused (Offline)", "info");
    }
  });
}

function setupLifecycleListeners() {
  window.addEventListener("beforeunload", () => {
    markOffline();
  });

  window.addEventListener("pagehide", () => {
    markOffline();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      markOffline();
    } else if (document.visibilityState === "visible" && isGpsBroadcasting) {
      startGpsBroadcast();
    }
  });
}

function setupLogout() {
  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    stopGpsBroadcast();
    await markOffline();
    delete sessionStorage.__viewAs;
    delete sessionStorage.__asDriver;
    showToast("Signed out", "info");
    setTimeout(() => logout(), 200);
  });
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
