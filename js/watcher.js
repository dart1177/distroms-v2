import { auth, db } from "./firebase-config.js";
import { requireRole, logout } from "./auth.js";
import { showToast } from "./ui.js";
import {
  collection,
  onSnapshot,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// State
let currentUser = null;
let currentProfile = null;
let isTestMode = false;

let map = null;
let driverLocations = {};
let drivers = {};
let challans = [];
let driverMarkers = {};
let selectedDriverId = null;

let unsubLocations = null;
let unsubDrivers = null;
let unsubChallans = null;

/**
 * Initializes the Watcher Live Fleet Monitor.
 */
async function init() {
  try {
    // Check for test mode impersonation from Distributor
    if (sessionStorage.__viewAs === "watcher") {
      isTestMode = true;
      // In test mode, verify current session is distributor
      const res = await requireRole("distributor");
      currentUser = res.user;
      currentProfile = res.profile;

      setupTestModeBanner();
    } else {
      // Standard Watcher authentication
      const res = await requireRole("watcher");
      currentUser = res.user;
      currentProfile = res.profile;
    }

    const userEl = document.getElementById("watcherUser");
    if (userEl) {
      userEl.textContent = `Hi ${currentProfile.name || "Watcher"} 👋`;
    }

    initDarkMap();
    setupControls();
    subscribeData();
  } catch (err) {
    console.warn("Watcher init skipped:", err?.message);
  }
}

/**
 * Configures the test-mode banner with "Return to Distributor" button.
 */
function setupTestModeBanner() {
  const banner = document.getElementById("testModeBanner");
  const returnBtn = document.getElementById("returnToDistributorBtn");
  if (banner) banner.style.display = "block";

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
 * Initializes the Leaflet map with CartoDB Dark tiles.
 */
function initDarkMap() {
  const el = document.getElementById("watcherMap");
  if (!el || map) return;

  try {
    map = L.map("watcherMap", {
      zoomControl: true
    }).setView([20.5937, 78.9629], 5);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      subdomains: "abcd",
      attribution: "&copy; OpenStreetMap &copy; CARTO"
    }).addTo(map);
  } catch (err) {
    console.warn("Dark map init error:", err);
  }
}

/**
 * Wires map controls, search input, and sign out button.
 */
function setupControls() {
  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    delete sessionStorage.__viewAs;
    delete sessionStorage.__asDriver;
    showToast("Signed out", "info");
    setTimeout(() => logout(), 200);
  });

  document.getElementById("watcherFitBoundsBtn")?.addEventListener("click", () => {
    fitAllDrivers();
  });

  const searchInput = document.getElementById("driverSearchInput");
  searchInput?.addEventListener("input", () => {
    renderDriverList();
  });
}

/**
 * Subscribes to driver_locations, users (drivers), and delivery_challans.
 */
function subscribeData() {
  // 1. Subscribe to driver_locations
  unsubLocations = onSnapshot(collection(db, "driver_locations"), (snap) => {
    snap.docs.forEach((d) => {
      driverLocations[d.id] = { id: d.id, ...d.data() };
    });
    updateOnlineCount();
    renderDriverList();
    renderMapMarkers();
  });

  // 2. Subscribe to drivers (users)
  unsubDrivers = onSnapshot(collection(db, "users"), (snap) => {
    snap.docs.forEach((d) => {
      if (d.data().role === "driver") {
        drivers[d.id] = { id: d.id, ...d.data() };
      }
    });
    renderDriverList();
    renderMapMarkers();
  });

  // 3. Subscribe to active challans
  unsubChallans = onSnapshot(collection(db, "delivery_challans"), (snap) => {
    challans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderDriverList();
    renderMapMarkers();
  });
}

/**
 * Computes status category for driver: online, idle, or offline.
 */
function getDriverStatus(loc) {
  if (!loc || !loc.isOnline) return "offline";
  const ageMs = Date.now() - (Number(loc.updatedAt) || 0);
  if (ageMs <= 120000) return "online";       // <2 min: online (green)
  if (ageMs <= 300000) return "idle";         // 2-5 min: idle (yellow)
  return "offline";                          // >5 min: offline (red)
}

function updateOnlineCount() {
  const onlineCount = Object.values(driverLocations).filter(
    (l) => getDriverStatus(l) === "online"
  ).length;

  const countEl = document.getElementById("watcherOnlineCount");
  const badgeEl = document.getElementById("activeFleetBadge");

  if (countEl) countEl.textContent = onlineCount.toString();
  if (badgeEl) badgeEl.textContent = `${onlineCount} live`;
}

/**
 * Renders driver telemetry list in left sidebar.
 */
function renderDriverList() {
  const container = document.getElementById("watcherDriverList");
  const searchInput = document.getElementById("driverSearchInput");
  const queryText = (searchInput?.value || "").toLowerCase().trim();

  if (!container) return;

  const allDriverIds = Array.from(
    new Set([...Object.keys(drivers), ...Object.keys(driverLocations)])
  );

  let filtered = allDriverIds.map((id) => {
    const d = drivers[id] || {};
    const loc = driverLocations[id] || {};
    const name = loc.driverName || d.name || "Driver";
    const vehicle = d.vehicleNumber || "Vehicle";
    const status = getDriverStatus(loc);
    return { id, name, vehicle, loc, status };
  });

  if (queryText) {
    filtered = filtered.filter(
      (x) => x.name.toLowerCase().includes(queryText) || x.vehicle.toLowerCase().includes(queryText)
    );
  }

  // Sort: online first, then idle, then offline
  const priority = { online: 1, idle: 2, offline: 3 };
  filtered.sort((a, b) => (priority[a.status] || 4) - (priority[b.status] || 4));

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="watcher-empty">
        <i class="fa-solid fa-truck"></i>
        <div>No matching drivers</div>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map((item) => {
    const { id, name, vehicle, loc, status } = item;
    const targetChallan = challans.find(
      (c) => c.driverId === id && (c.status === "assigned" || c.status === "out_for_delivery")
    );

    const speed = Math.round(loc.speed || 0);
    const lastPing = loc.updatedAt
      ? `${Math.max(1, Math.round((Date.now() - loc.updatedAt) / 1000))}s ago`
      : "Never";

    const isSelected = selectedDriverId === id ? "is-selected" : "";

    return `
      <div class="watcher-card ${isSelected}" data-driver-id="${id}">
        <div class="watcher-card__top">
          <div class="watcher-card__name">
            <span class="status-dot-sm is-${status}"></span>
            ${esc(name)}
          </div>
          <span class="watcher-card__vehicle">${esc(vehicle)}</span>
        </div>
        <div class="watcher-card__info">
          <span><i class="fa-solid fa-gauge-high"></i> Speed: ${speed} km/h</span>
          <span><i class="fa-solid fa-store"></i> Target: ${targetChallan ? esc(targetChallan.shopName) : "None"}</span>
        </div>
        <div class="watcher-card__bottom">
          <span>Ping: ${lastPing}</span>
          <span style="text-transform:capitalize;font-weight:600;color:${status === 'online' ? '#10b981' : (status === 'idle' ? '#f59e0b' : '#ef4444')};">${status}</span>
        </div>
      </div>`;
  }).join("");

  container.querySelectorAll(".watcher-card").forEach((card) => {
    card.addEventListener("click", () => {
      const driverId = card.dataset.driverId;
      selectedDriverId = driverId;
      container.querySelectorAll(".watcher-card").forEach((c) => c.classList.remove("is-selected"));
      card.classList.add("is-selected");

      zoomToDriver(driverId);
    });
  });
}

/**
 * Updates marker icons and popups on the dark map.
 */
function renderMapMarkers() {
  if (!map) return;

  const validLocations = Object.values(driverLocations).filter(
    (l) => l.lat && l.lng && !isNaN(l.lat) && !isNaN(l.lng)
  );

  validLocations.forEach((loc) => {
    const id = loc.driverId || loc.id;
    const status = getDriverStatus(loc);
    const driver = drivers[id] || {};
    const name = loc.driverName || driver.name || "Driver";
    const vehicle = driver.vehicleNumber || "";
    const speed = Math.round(loc.speed || 0);

    const targetChallan = challans.find(
      (c) => c.driverId === id && (c.status === "assigned" || c.status === "out_for_delivery")
    );

    const popupHtml = `
      <div style="font-size:14px; font-weight:700; color:#f8fafc; margin-bottom:4px;">
        🚚 ${esc(name)} ${vehicle ? `(${esc(vehicle)})` : ""}
      </div>
      <div style="font-size:12px; color:#94a3b8; line-height:1.5;">
        Status: <strong style="color:${status === 'online' ? '#34d399' : (status === 'idle' ? '#fbbf24' : '#f87171')}; text-transform:capitalize;">${status}</strong><br>
        Speed: <strong>${speed} km/h</strong><br>
        Target: <strong style="color:#38bdf8;">${targetChallan ? esc(targetChallan.shopName) : "None"}</strong>
      </div>`;

    const icon = L.divIcon({
      className: "watcher-truck-marker",
      html: `<div class="watcher-pin is-${status}"><i class="fa-solid fa-truck"></i></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });

    if (driverMarkers[id]) {
      driverMarkers[id].setLatLng([loc.lat, loc.lng]);
      driverMarkers[id].setIcon(icon);
      driverMarkers[id].setPopupContent(popupHtml);
    } else {
      const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(map);
      marker.bindPopup(popupHtml);
      driverMarkers[id] = marker;
    }
  });

  // Remove markers for drivers no longer in driverLocations
  Object.keys(driverMarkers).forEach((id) => {
    if (!driverLocations[id]) {
      map.removeLayer(driverMarkers[id]);
      delete driverMarkers[id];
    }
  });
}

function zoomToDriver(driverId) {
  const loc = driverLocations[driverId];
  if (loc && loc.lat && loc.lng && map) {
    map.setView([loc.lat, loc.lng], 16);
    driverMarkers[driverId]?.openPopup();
  }
}

function fitAllDrivers() {
  if (!map) return;
  const markers = Object.values(driverMarkers);
  if (markers.length > 0) {
    const group = L.featureGroup(markers);
    map.fitBounds(group.getBounds().pad(0.2));
    showToast("Map fitted to active fleet", "info");
  } else {
    showToast("No active driver coordinates yet", "info");
  }
}

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
