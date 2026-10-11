import { auth, db } from "./firebase-config.js";
import { requireRole, logout } from "./auth.js";
import { showToast, openModal, closeModal } from "./ui.js";
import {
  collection,
  getDocs,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  onSnapshot,
  writeBatch,
  increment
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signOut as secondarySignOut
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// ── State ──────────────────────────────────────────────────────────
let currentUser     = null;
let currentProfile  = null;
let shops           = [];
let products        = [];
let challans        = [];
let drivers         = [];
let sales           = [];
let payments        = [];
let driverLocations = {}; // driverId -> location doc

let unsubShops      = null;
let unsubProducts   = null;
let unsubChallans   = null;
let unsubDrivers    = null;
let unsubSales      = null;
let unsubPayments   = null;
let unsubLocations  = null;

/** Current challan or sale ID open in modal (for print/PDF) */
let currentChallanId = null;
let currentSaleId    = null;

/** Map picker state for Shop modal */
let shopMapPicker  = null;
let shopMapMarker  = null;
let pendingShopLat = null;
let pendingShopLng = null;

/** Dashboard map state */
let dashboardMap          = null;
let dashboardMarkers      = [];
let dashboardMarkerMap    = {}; // shopId -> L.marker
let lastRecentShopId      = null;
let shouldFocusRecentShop = true; // Focuses on recent shop area on boot or when new shop is added
let selectedDashShopId    = null;
let dashShopFilter        = "all"; // 'all' | 'recent' | 'pending' | 'gps'
let dashShopSearch        = "";

/** Live Tracking map state */
let trackingMap            = null;
let trackingDriverMarkers  = {};
let trackingShopMarkers    = {};
let trackingRouteLines     = {};
let selectedTrackingDriver = null;

/** Arrival detection */
const firedAlerts = new Set(); // Key: `${driverId}-${challanId}`
let arrivalCheckInterval = null;

/** Reports charts instances */
let chartSales7Days = null;
let chartTopPending = null;
let chartTopProducts = null;

// ── Distance & Audio Utilities ─────────────────────────────────────

/**
 * Calculates Great Circle distance between two points in meters using Haversine formula.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} Distance in meters
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Plays a clean alert beep using Web AudioContext (no external audio files required).
 */
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.value = 0.15;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    setTimeout(() => ctx.close(), 300);
  } catch (_) {}
}

// ── Bootstrapping ──────────────────────────────────────────────────

/**
 * Bootstraps the distributor dashboard after role validation.
 */
async function init() {
  try {
    const { user, profile } = await requireRole("distributor");
    currentUser    = user;
    currentProfile = profile;

    const userInfoEl = document.getElementById("userInfo");
    if (userInfoEl) {
      userInfoEl.textContent = `Hi ${profile.name || "Distributor"} 👋`;
    }

    setupNav();
    setupModals();
    setupShopForm();
    setupProductForm();
    setupDriverForm();
    setupChallanForm();
    setupAssignDriverForm();
    setupSaleForm();
    setupPaymentForm();
    setupShopMapPickerHandlers();
    setupMobileMenu();
    setupDashboardMapControls();
    setupTrackingControls();
    setupLogout();

    initDashboardMap();
    initTrackingMap();

    loadDashboardKPIs();
    subscribeShops();
    subscribeProducts();
    subscribeDrivers();
    subscribeChallans();
    subscribeSales();
    subscribePayments();
    subscribeDriverLocations();

    startArrivalDetection();
  } catch (err) {
    console.warn("Init skipped:", err?.message);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ── Navigation ─────────────────────────────────────────────────────

/**
 * Wires sidebar and bottom nav tab switching with preventDefault.
 */
function setupNav() {
  const navItems = document.querySelectorAll(".sidebar__nav .nav-item");
  const sections = document.querySelectorAll(".content-section");
  const titleEl  = document.getElementById("pageTitle");

  const titles = {
    dashboard: "Dashboard",
    shops:     "Shops",
    products:  "Products",
    drivers:   "Drivers",
    challans:  "Challans",
    sales:     "Sales & Invoices",
    payments:  "Payments",
    reports:   "Reports",
    tracking:  "Live Tracking"
  };

  navItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (item.disabled) return;
      const target = item.dataset.target;
      if (!target) return;

      // Close mobile menu if open
      const menu = document.getElementById("mobileMenu");
      if (menu?.classList.contains("is-open")) {
        menu.classList.remove("is-open");
        document.body.style.overflow = "";
      }

      navItems.forEach((n) => n.classList.remove("is-active"));
      item.classList.add("is-active");

      sections.forEach((s) => s.classList.remove("is-active"));
      const active = document.getElementById(`section-${target}`);
      if (active) active.classList.add("is-active");

      if (titleEl) {
        titleEl.textContent = titles[target] || "Distributor";
      }

      // Handle map invalidations and chart renders on section switch
      if (target === "dashboard" && dashboardMap) {
        setTimeout(() => dashboardMap.invalidateSize(), 150);
      } else if (target === "tracking") {
        setTimeout(() => {
          if (trackingMap) {
            trackingMap.invalidateSize();
            refreshTrackingMap();
          }
        }, 150);
      } else if (target === "reports") {
        renderReports();
      }
    });
  });
}

/**
 * Programmatically switches the active section from mobile menu buttons.
 * @param {string} target - Section target ID
 */
function switchSection(target) {
  const desktopBtn = document.querySelector(`.sidebar__nav .nav-item[data-target="${target}"]`);
  if (desktopBtn) {
    desktopBtn.click();
    return;
  }

  const sections = document.querySelectorAll(".content-section");
  const titleEl  = document.getElementById("pageTitle");
  const titles = {
    dashboard: "Dashboard",
    shops:     "Shops",
    products:  "Products",
    drivers:   "Drivers",
    challans:  "Challans",
    sales:     "Sales & Invoices",
    payments:  "Payments",
    reports:   "Reports",
    tracking:  "Live Tracking"
  };

  sections.forEach((s) => s.classList.remove("is-active"));
  const active = document.getElementById(`section-${target}`);
  if (active) active.classList.add("is-active");

  if (titleEl) titleEl.textContent = titles[target] || "Distributor";

  if (target === "tracking") {
    setTimeout(() => {
      if (trackingMap) {
        trackingMap.invalidateSize();
        refreshTrackingMap();
      }
    }, 150);
  } else if (target === "reports") {
    renderReports();
  }
}

// ── Dashboard KPIs ─────────────────────────────────────────────────

/**
 * Fetches dashboard KPI counts for Total Shops, Pending Fees, and Active Deliveries.
 */
async function loadDashboardKPIs() {
  try {
    const [shopsSnap, challansSnap] = await Promise.all([
      getDocs(collection(db, "shops")),
      getDocs(collection(db, "delivery_challans"))
    ]);

    const kpiShopsEl = document.getElementById("kpiShops");
    if (kpiShopsEl) kpiShopsEl.textContent = shopsSnap.size.toString();

    let totalPending = 0;
    shopsSnap.forEach((d) => {
      totalPending += Number(d.data().pending_fees) || 0;
    });
    const kpiPendingEl = document.getElementById("kpiPending");
    if (kpiPendingEl) kpiPendingEl.textContent = "₹" + totalPending.toLocaleString("en-IN");

    let activeDeliveries = 0;
    challansSnap.forEach((d) => {
      const s = d.data().status;
      if (s === "assigned" || s === "out_for_delivery") activeDeliveries++;
    });
    const kpiActiveEl = document.getElementById("kpiActive");
    if (kpiActiveEl) kpiActiveEl.textContent = activeDeliveries.toString();
  } catch (err) {
    console.error("Dashboard load failed:", err);
  }
}

// ── Dashboard Map ──────────────────────────────────────────────────

function initDashboardMap() {
  const el = document.getElementById("dashboardMap");
  if (!el || dashboardMap) return;
  dashboardMap = L.map("dashboardMap").setView([20.5937, 78.9629], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(dashboardMap);
}

/**
 * Resolves the most recently added or updated shop.
 * Checks lastRecentShopId first, then createdAt / updatedAt timestamp, then array order.
 * @returns {object|null}
 */
function getRecentShop() {
  if (lastRecentShopId) {
    const s = shops.find((x) => x.id === lastRecentShopId);
    if (s) return s;
  }
  const withTime = [...shops].filter((s) => s.createdAt || s.updatedAt);
  if (withTime.length > 0) {
    withTime.sort((a, b) => {
      const tA = (a.createdAt?.seconds || a.createdAt?._seconds || a.updatedAt?.seconds || 0);
      const tB = (b.createdAt?.seconds || b.createdAt?._seconds || b.updatedAt?.seconds || 0);
      return tB - tA;
    });
    return withTime[0];
  }
  return shops.length > 0 ? shops[shops.length - 1] : null;
}

function refreshDashboardMapMarkers() {
  if (!dashboardMap) return;

  dashboardMarkers.forEach((m) => dashboardMap.removeLayer(m));
  dashboardMarkers = [];
  dashboardMarkerMap = {};

  const valid = shops.filter((s) => s.latitude && s.longitude);
  const countEl = document.getElementById("dashMapCount");
  if (countEl) {
    countEl.textContent = `${valid.length}/${shops.length} mapped`;
  }

  const recentShop = getRecentShop();

  valid.forEach((s) => {
    const lat = Number(s.latitude);
    const lng = Number(s.longitude);
    const pending = Number(s.pending_fees) || 0;
    const isRecent = recentShop && s.id === recentShop.id;

    // Create custom pin icon
    const icon = L.divIcon({
      className: "dash-shop-marker",
      html: isRecent
        ? `<div class="dash-shop-pin dash-shop-pin--recent" title="${esc(s.name)} (Recent)">
             <div class="dash-pin-pulse"></div>
             <i class="fa-solid fa-sparkles"></i>
           </div>`
        : `<div class="dash-shop-pin" title="${esc(s.name)}">
             <i class="fa-solid fa-store"></i>
           </div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 34],
      popupAnchor: [0, -34]
    });

    const marker = L.marker([lat, lng], {
      icon,
      zIndexOffset: isRecent ? 1000 : 0
    }).addTo(dashboardMap);

    marker.bindPopup(`
      <div class="shop-popup__name">
        ${isRecent ? "✨ " : "🏪 "}${esc(s.name)}
        ${isRecent ? '<span class="badge badge--recent" style="margin-left:6px;font-size:10px;">Recent</span>' : ""}
      </div>
      <div class="shop-popup__row">
        <i class="fa-solid fa-tag"></i> <span>${esc(s.shop_type || "Retailer")}</span>
      </div>
      <div class="shop-popup__row">
        <i class="fa-solid fa-user"></i> <span>${esc(s.owner_name) || "—"}</span>
      </div>
      <div class="shop-popup__row">
        <i class="fa-solid fa-phone"></i> <span>${esc(s.phone) || "—"}</span>
      </div>
      <div class="shop-popup__row">
        <i class="fa-solid fa-location-dot"></i>
        <span>${esc(s.address) || "—"}</span>
      </div>
      <div class="shop-popup__pending ${pending === 0 ? "is-clear" : ""}">
        ${pending > 0
          ? "₹" + pending.toLocaleString("en-IN") + " pending"
          : "✓ No dues"}
      </div>
      <button class="shop-popup__btn"
              onclick="window.__dashOpenShop('${s.id}')">
        View in Shops
      </button>
    `);

    marker.on("click", () => {
      highlightShopCard(s.id, true);
    });

    dashboardMarkers.push(marker);
    dashboardMarkerMap[s.id] = marker;
  });

  // Floating recent shop area reflection banner
  const recentBanner = document.getElementById("dashMapRecentBadge");
  const recentBadgeText = document.getElementById("dashMapRecentBadgeText");
  if (recentBanner && recentBadgeText) {
    if (recentShop) {
      recentBadgeText.textContent = `Recent: ${recentShop.name} (${recentShop.address || "Area"})`;
      recentBanner.style.display = "inline-flex";
    } else {
      recentBanner.style.display = "none";
    }
  }

  // Camera handling: focus recent shop area if flag is set, otherwise fit bounds
  if (shouldFocusRecentShop && recentShop && recentShop.latitude && recentShop.longitude) {
    shouldFocusRecentShop = false;
    selectedDashShopId = recentShop.id;
    const rLat = Number(recentShop.latitude);
    const rLng = Number(recentShop.longitude);
    dashboardMap.setView([rLat, rLng], 15);
    const marker = dashboardMarkerMap[recentShop.id];
    if (marker) {
      setTimeout(() => marker.openPopup(), 400);
    }
  } else if (dashboardMarkers.length > 0 && !selectedDashShopId) {
    const group = L.featureGroup(dashboardMarkers);
    dashboardMap.fitBounds(group.getBounds().pad(0.2));
  }

  renderDashboardShopsList();
}

/**
 * Renders the interactive directory of shops situated right under the map.
 */
function renderDashboardShopsList() {
  const container = document.getElementById("dashShopsList");
  const countEl = document.getElementById("dashShopsCountText");
  if (!container) return;

  const recentShop = getRecentShop();

  let list = [...shops];

  // Apply search filter
  if (dashShopSearch) {
    const q = dashShopSearch.toLowerCase().trim();
    list = list.filter((s) => {
      return (
        (s.name && s.name.toLowerCase().includes(q)) ||
        (s.address && s.address.toLowerCase().includes(q)) ||
        (s.owner_name && s.owner_name.toLowerCase().includes(q)) ||
        (s.phone && s.phone.toLowerCase().includes(q))
      );
    });
  }

  // Apply chip filter
  if (dashShopFilter === "recent") {
    if (recentShop) {
      list = list.filter((s) => s.id === recentShop.id);
    }
  } else if (dashShopFilter === "pending") {
    list = list.filter((s) => (Number(s.pending_fees) || 0) > 0);
  } else if (dashShopFilter === "gps") {
    list = list.filter((s) => s.latitude && s.longitude);
  }

  if (countEl) countEl.textContent = list.length.toString();

  if (list.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 28px 16px; color: var(--text-muted);">
        <i class="fa-solid fa-store-slash" style="font-size: 28px; margin-bottom: 8px; display: block; opacity: 0.5;"></i>
        <div>No matching shops found under map</div>
      </div>`;
    return;
  }

  container.innerHTML = list.map((s) => {
    const hasGps = Boolean(s.latitude && s.longitude);
    const isRecent = recentShop && s.id === recentShop.id;
    const isSelected = selectedDashShopId === s.id;
    const pending = Number(s.pending_fees) || 0;
    const typeClass =
      { Retailer: "badge--retailer", Wholesaler: "badge--wholesaler", Both: "badge--both" }[s.shop_type] ||
      "badge--retailer";

    return `
      <div class="dash-shop-card ${isRecent ? "is-recent" : ""} ${isSelected ? "is-selected" : ""} ${hasGps ? "has-gps" : "no-gps"}"
           data-dash-shop-id="${s.id}">
        <div class="dash-shop-card__header">
          <div class="dash-shop-card__title-wrap">
            <span class="dash-shop-card__icon">${isRecent ? "✨" : (hasGps ? "📍" : "🏪")}</span>
            <span class="dash-shop-card__name">${esc(s.name)}</span>
            ${isRecent ? '<span class="badge badge--recent"><i class="fa-solid fa-sparkles"></i> Recent Added</span>' : ""}
          </div>
          <span class="badge ${typeClass}">${esc(s.shop_type || "Retailer")}</span>
        </div>

        <div class="dash-shop-card__body">
          <div class="dash-shop-card__meta-item" title="Address / Area">
            <i class="fa-solid fa-location-dot"></i>
            <span>${esc(s.address) || "No address specified"}</span>
          </div>
          ${s.owner_name ? `
            <div class="dash-shop-card__meta-item" title="Owner">
              <i class="fa-solid fa-user"></i>
              <span>${esc(s.owner_name)}</span>
            </div>` : ""}
          ${s.phone ? `
            <div class="dash-shop-card__meta-item" title="Phone">
              <i class="fa-solid fa-phone"></i>
              <span>${esc(s.phone)}</span>
            </div>` : ""}
        </div>

        <div class="dash-shop-card__footer">
          <div class="dash-shop-card__due">
            ${pending > 0
              ? `<span class="badge badge--danger">₹${pending.toLocaleString("en-IN")} due</span>`
              : `<span class="badge badge--success">✓ No dues</span>`}
          </div>
          <button type="button" class="dash-shop-card__action-btn">
            ${hasGps
              ? '<i class="fa-solid fa-location-crosshairs"></i> Locate on Map'
              : '<i class="fa-solid fa-triangle-exclamation"></i> No GPS'}
          </button>
        </div>
      </div>`;
  }).join("");

  container.querySelectorAll("[data-dash-shop-id]").forEach((card) => {
    card.addEventListener("click", () => {
      const shopId = card.getAttribute("data-dash-shop-id");
      goToShopOnMap(shopId);
    });
  });
}

/**
 * Flies the dashboard map to the specified shop and highlights its card.
 * @param {string} shopId
 */
window.goToShopOnMap = function (shopId) {
  const shop = shops.find((s) => s.id === shopId);
  if (!shop) return;

  selectedDashShopId = shopId;
  highlightShopCard(shopId, false);

  if (!shop.latitude || !shop.longitude) {
    showToast(`"${shop.name}" has no GPS coordinates. Edit in Shops to add location.`, "warning");
    return;
  }

  const lat = Number(shop.latitude);
  const lng = Number(shop.longitude);

  if (dashboardMap) {
    dashboardMap.flyTo([lat, lng], 16, { duration: 1.0 });

    const marker = dashboardMarkerMap[shopId];
    if (marker) {
      setTimeout(() => marker.openPopup(), 400);
    }

    const mapEl = document.getElementById("dashboardMap");
    if (mapEl) {
      mapEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
};

/**
 * Highlights a shop card in the list under the map.
 * @param {string} shopId
 * @param {boolean} scrollIntoView
 */
function highlightShopCard(shopId, scrollIntoView = false) {
  selectedDashShopId = shopId;
  const cards = document.querySelectorAll(".dash-shop-card");
  cards.forEach((card) => {
    if (card.getAttribute("data-dash-shop-id") === shopId) {
      card.classList.add("is-selected");
      if (scrollIntoView) {
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } else {
      card.classList.remove("is-selected");
    }
  });
}

window.__dashOpenShop = function (shopId) {
  document.querySelectorAll(".sidebar__nav .nav-item")
    .forEach((n) => n.classList.remove("is-active"));
  document.querySelector('[data-target="shops"]')
    ?.classList.add("is-active");

  document.querySelectorAll(".content-section")
    .forEach((s) => s.classList.remove("is-active"));
  document.getElementById("section-shops")?.classList.add("is-active");

  const titleEl = document.getElementById("pageTitle");
  if (titleEl) titleEl.textContent = "Shops";

  if (dashboardMap) dashboardMap.closePopup();
};

function setupDashboardMapControls() {
  document.getElementById("dashMapCenterBtn")?.addEventListener("click", () => {
    if (!navigator.geolocation || !dashboardMap) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      dashboardMap.flyTo([pos.coords.latitude, pos.coords.longitude], 15, { duration: 1.0 });
      showToast("Centered on your location", "info");
    }, () => {
      showToast("Could not get your location", "warning");
    }, { enableHighAccuracy: true });
  });

  document.getElementById("dashMapRecentBtn")?.addEventListener("click", () => {
    const recent = getRecentShop();
    if (recent && recent.latitude && recent.longitude) {
      goToShopOnMap(recent.id);
      showToast(`Zoomed to recent area: ${recent.name}`, "info");
    } else if (recent) {
      showToast(`Recent shop "${recent.name}" has no GPS coordinates`, "warning");
      highlightShopCard(recent.id, true);
    } else {
      showToast("No shops added yet", "warning");
    }
  });

  document.getElementById("dashMapFitBtn")?.addEventListener("click", () => {
    if (dashboardMarkers.length > 0 && dashboardMap) {
      const group = L.featureGroup(dashboardMarkers);
      dashboardMap.fitBounds(group.getBounds().pad(0.2));
      showToast("Fit all shops on map", "info");
    } else {
      showToast("No shops with GPS coordinates to fit", "warning");
    }
  });

  const searchInput = document.getElementById("dashShopSearchInput");
  searchInput?.addEventListener("input", (e) => {
    dashShopSearch = e.target.value;
    renderDashboardShopsList();
  });

  document.querySelectorAll(".dash-shops-filter-chips .dash-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".dash-shops-filter-chips .dash-chip")
        .forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      dashShopFilter = chip.getAttribute("data-filter") || "all";
      renderDashboardShopsList();
    });
  });
}

// ── Mobile Menu & Role Switcher (Section A & B) ────────────────────

function setupMobileMenu() {
  const menu = document.getElementById("mobileMenu");
  const openBtn = document.getElementById("mobileMenuBtn");
  const closeBtn = document.getElementById("mobileMenuClose");
  const signOutBtn = document.getElementById("mobileMenuSignOut");
  const backdrop = menu?.querySelector(".mobile-menu__backdrop");

  const viewWatcherBtn = document.getElementById("menuViewWatcher");
  const viewDriverBtn = document.getElementById("menuViewDriverBtn");
  const driverSublist = document.getElementById("menuDriverSublist");
  const driverCaret = document.getElementById("menuDriverCaret");

  if (!menu || !openBtn) return;

  const open = () => {
    document.getElementById("menuUserName").textContent =
      currentProfile?.name || "User";
    document.getElementById("menuUserEmail").textContent =
      currentProfile?.email || currentUser?.email || "";
    populateDriverRoleSubmenu();
    menu.classList.add("is-open");
    document.body.style.overflow = "hidden";
  };

  const close = () => {
    menu.classList.remove("is-open");
    document.body.style.overflow = "";
  };

  openBtn.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);

  // Role Switcher: View as Watcher
  viewWatcherBtn?.addEventListener("click", () => {
    sessionStorage.__viewAs = "watcher";
    close();
    showToast("Switching to Watcher view...", "info");
    setTimeout(() => {
      window.location.href = "watcher.html";
    }, 200);
  });

  // Toggle Driver Submenu
  viewDriverBtn?.addEventListener("click", () => {
    if (!driverSublist) return;
    const isExpanded = driverSublist.style.display !== "none";
    driverSublist.style.display = isExpanded ? "none" : "block";
    if (driverCaret) {
      driverCaret.className = isExpanded ? "fa-solid fa-chevron-down" : "fa-solid fa-chevron-up";
    }
  });

  // Mobile menu navigation items
  document.querySelectorAll("[data-mobile-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.mobileNav;
      close();
      switchSection(target);
    });
  });

  signOutBtn?.addEventListener("click", () => {
    close();
    showToast("Signed out", "info");
    setTimeout(() => logout(), 200);
  });
}

/**
 * Populates active drivers inside the mobile menu role switcher submenu.
 */
function populateDriverRoleSubmenu() {
  const container = document.getElementById("menuDriverSublist");
  if (!container) return;

  const activeDrivers = drivers.filter((d) => d.active !== false);

  if (activeDrivers.length === 0) {
    container.innerHTML = `
      <div style="padding:8px 14px; font-size:12px; color:var(--text-muted);">
        No registered drivers available
      </div>`;
    return;
  }

  container.innerHTML = activeDrivers.map((d) => {
    const online = isDriverOnline(d.id);
    const dot = online ? "is-online" : "is-offline";
    return `
      <div class="mobile-menu__subitem" data-impersonate-driver="${d.id}">
        <span><span class="status-dot-sm ${dot}" style="margin-right:6px;"></span>${esc(d.name)}</span>
        <span style="font-size:10px; color:var(--text-muted);">${esc(d.vehicleNumber || "")}</span>
      </div>`;
  }).join("");

  container.querySelectorAll("[data-impersonate-driver]").forEach((el) => {
    el.addEventListener("click", () => {
      const driverId = el.dataset.impersonateDriver;
      sessionStorage.__viewAs = "driver";
      sessionStorage.__asDriver = driverId;

      const menu = document.getElementById("mobileMenu");
      menu?.classList.remove("is-open");
      document.body.style.overflow = "";

      showToast(`Switching to Driver view...`, "info");
      setTimeout(() => {
        window.location.href = "driver.html";
      }, 200);
    });
  });
}

// ── Shops ──────────────────────────────────────────────────────────

function subscribeShops() {
  if (unsubShops) unsubShops();
  const q = query(collection(db, "shops"), orderBy("name", "asc"));
  unsubShops = onSnapshot(q,
    (snap) => {
      shops = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderShopsTable();
      updateShopsKPIs();
      refreshDashboardMapMarkers();
      refreshTrackingMap();
      renderReports();
    },
    (err) => { console.error("Shops listener error:", err); }
  );
}

function updateShopsKPIs() {
  const countEl   = document.getElementById("kpiShops");
  const pendingEl = document.getElementById("kpiPending");
  const payPendingEl = document.getElementById("statPaymentsPendingAcrossShops");

  if (countEl) countEl.textContent = shops.length.toString();
  const sum = shops.reduce((a, s) => a + (Number(s.pending_fees) || 0), 0);
  const formatted = "₹" + sum.toLocaleString("en-IN");
  if (pendingEl) pendingEl.textContent = formatted;
  if (payPendingEl) payPendingEl.textContent = formatted;
}

function renderShopsTable() {
  const tbody = document.getElementById("shopsTableBody");
  if (!tbody) return;

  if (shops.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <div class="empty-state__icon">🏪</div>
          <div class="empty-state__title">No shops yet</div>
          <div class="empty-state__text">Click "Add Shop" to add your first shop.</div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = shops.map((s) => {
    const typeClass =
      { Retailer: "badge--retailer", Wholesaler: "badge--wholesaler", Both: "badge--both" }[s.shop_type] ||
      "badge--retailer";
    const pending = Number(s.pending_fees) || 0;
    return `
      <tr>
        <td data-label="Name"><strong>${esc(s.name)}</strong></td>
        <td data-label="Owner" class="muted">${esc(s.owner_name) || "—"}</td>
        <td data-label="Phone" class="muted">${esc(s.phone) || "—"}</td>
        <td data-label="Address" class="muted">${esc(s.address) || "—"}</td>
        <td data-label="Type"><span class="badge ${typeClass}">${esc(s.shop_type) || "Retailer"}</span></td>
        <td data-label="Pending ₹" class="money">
          ${pending > 0
            ? `<span class="badge badge--danger">₹${pending.toLocaleString("en-IN")}</span>`
            : "₹0"}
        </td>
        <td data-label="Actions" class="actions">
          <button class="row-btn row-btn--edit" data-action="edit-shop"  data-id="${s.id}">Edit</button>
          <button class="row-btn row-btn--del"  data-action="del-shop"   data-id="${s.id}">Delete</button>
        </td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "edit-shop") editShop(btn.dataset.id);
      if (btn.dataset.action === "del-shop")  deleteShop(btn.dataset.id);
    });
  });
}

// ── Products ───────────────────────────────────────────────────────

function subscribeProducts() {
  if (unsubProducts) unsubProducts();
  const q = query(collection(db, "products"), orderBy("name", "asc"));
  unsubProducts = onSnapshot(q,
    (snap) => {
      products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderProductsTable();
      renderReports();
    },
    (err) => { console.error("Products listener error:", err); }
  );
}

function renderProductsTable() {
  const tbody = document.getElementById("productsTableBody");
  if (!tbody) return;

  if (products.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">
          <div class="empty-state__icon">📦</div>
          <div class="empty-state__title">No products yet</div>
          <div class="empty-state__text">Click "Add Product" to add your first product.</div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = products.map((p) => {
    const cost   = Number(p.cost_price)    || 0;
    const sell   = Number(p.selling_price) || 0;
    const stock  = Number(p.stock)         || 0;
    const margin = cost > 0 ? Math.round(((sell - cost) / cost) * 100) : 0;
    return `
      <tr>
        <td data-label="Name"><strong>${esc(p.name)}</strong></td>
        <td data-label="Category" class="muted">${esc(p.category) || "—"}</td>
        <td data-label="Unit" class="muted">${esc(p.unit) || "pc"}</td>
        <td data-label="Cost" class="money">₹${cost.toLocaleString("en-IN")}</td>
        <td data-label="Sell" class="money">₹${sell.toLocaleString("en-IN")}</td>
        <td data-label="Margin"><span class="badge ${margin >= 0 ? "badge--success" : "badge--danger"}">${margin}%</span></td>
        <td data-label="Stock"><span class="badge ${stock < 10  ? "badge--danger"  : "badge--success"}">${stock}</span></td>
        <td data-label="Actions" class="actions">
          <button class="row-btn row-btn--edit" data-action="edit-product" data-id="${p.id}">Edit</button>
          <button class="row-btn row-btn--del"  data-action="del-product"  data-id="${p.id}">Delete</button>
        </td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "edit-product") editProduct(btn.dataset.id);
      if (btn.dataset.action === "del-product")  deleteProduct(btn.dataset.id);
    });
  });
}

// ── Drivers Section (Section G) ────────────────────────────────────

function subscribeDrivers() {
  if (unsubDrivers) unsubDrivers();
  const q = query(collection(db, "users"), where("role", "==", "driver"));
  unsubDrivers = onSnapshot(q, (snap) => {
    drivers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderDriversTable();
    updateDriversStats();
    refreshTrackingDriversList();
    populateDriverRoleSubmenu();
  }, (err) => {
    console.error("Drivers listener error:", err);
  });
}

function updateDriversStats() {
  const totalEl = document.getElementById("statTotalDrivers");
  const onlineEl = document.getElementById("statOnlineDrivers");
  const assignedEl = document.getElementById("statAssignedTodayDrivers");

  if (totalEl) totalEl.textContent = drivers.length.toString();
  const onlineCount = drivers.filter((d) => isDriverOnline(d.id)).length;
  if (onlineEl) onlineEl.textContent = onlineCount.toString();

  const assignedCount = challans.filter(
    (c) => (c.status === "assigned" || c.status === "out_for_delivery") && c.driverId
  ).length;
  if (assignedEl) assignedEl.textContent = assignedCount.toString();
}

function isDriverOnline(driverId) {
  const loc = driverLocations[driverId];
  if (!loc) return false;
  const isRecentlyActive = Date.now() - (Number(loc.updatedAt) || 0) < 120000;
  return Boolean(loc.isOnline && isRecentlyActive);
}

function renderDriversTable() {
  const tbody = document.getElementById("driversTableBody");
  if (!tbody) return;

  if (drivers.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="5">
        <div class="empty-state">
          <div class="empty-state__icon">🚚</div>
          <div class="empty-state__title">No drivers added yet</div>
          <div class="empty-state__text">Click "Add Driver" to register your first delivery driver.</div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = drivers.map((d) => {
    const online = isDriverOnline(d.id);
    const statusBadge = online
      ? `<span class="badge badge--success"><span class="status-dot-sm is-online"></span> Online</span>`
      : `<span class="badge badge--offline"><span class="status-dot-sm is-offline"></span> Offline</span>`;

    const activeToggleText = d.active !== false ? "Deactivate" : "Activate";
    const activeToggleStyle = d.active !== false ? "color:#dc2626;" : "color:#059669;";

    return `
      <tr>
        <td data-label="Name">
          <strong>${esc(d.name)}</strong>
          ${d.active === false ? '<span class="badge badge--danger" style="margin-left:6px;font-size:10px;">Inactive</span>' : ''}
        </td>
        <td data-label="Phone" class="muted">${esc(d.phone) || "—"}</td>
        <td data-label="Vehicle">${esc(d.vehicleNumber) || "—"}</td>
        <td data-label="Status">${statusBadge}</td>
        <td data-label="Actions" class="actions">
          <button class="row-btn row-btn--view" data-action="view-driver-challans" data-id="${d.id}">
            View Challans
          </button>
          <button class="row-btn" data-action="toggle-driver-active" data-id="${d.id}" style="${activeToggleStyle}">
            ${activeToggleText}
          </button>
        </td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { action, id } = btn.dataset;
      if (action === "view-driver-challans") viewDriverChallans(id);
      if (action === "toggle-driver-active") toggleDriverActive(id);
    });
  });
}

function viewDriverChallans(driverId) {
  const driver = drivers.find((d) => d.id === driverId);
  const driverChallans = challans.filter((c) => c.driverId === driverId);
  showToast(
    `${driver?.name || "Driver"}: ${driverChallans.length} assigned challan(s). Switched to Challans tab.`,
    "info"
  );
  switchSection("challans");
}

async function toggleDriverActive(driverId) {
  const driver = drivers.find((d) => d.id === driverId);
  if (!driver) return;
  const newActive = !(driver.active !== false);
  try {
    await updateDoc(doc(db, "users", driverId), {
      active: newActive,
      updatedAt: serverTimestamp()
    });
    showToast(`Driver ${driver.name} ${newActive ? "activated" : "deactivated"}.`, "success");
  } catch (err) {
    console.error("Toggle driver error:", err);
    showToast("Could not update driver status", "error");
  }
}

function setupDriverForm() {
  const form = document.getElementById("driverForm");
  const saveBtn = document.getElementById("saveDriverBtn");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!saveBtn) return;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating Driver...';

    const name          = document.getElementById("driverNameInput").value.trim();
    const email         = document.getElementById("driverEmailInput").value.trim();
    const password      = document.getElementById("driverPasswordInput").value;
    const phone         = document.getElementById("driverPhoneInput").value.trim();
    const vehicleNumber = document.getElementById("driverVehicleInput").value.trim();

    let secondaryApp = null;
    try {
      secondaryApp = initializeApp(auth.app.options, "secondary-" + Date.now());
      const secondaryAuth = getAuth(secondaryApp);
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      const newUid = cred.user.uid;
      await secondarySignOut(secondaryAuth);
      await deleteApp(secondaryApp);
      secondaryApp = null;

      await setDoc(doc(db, "users", newUid), {
        name,
        email,
        phone,
        vehicleNumber,
        role: "driver",
        active: true,
        createdAt: serverTimestamp()
      });

      showToast(`Driver account created for ${name}!`, "success");
      form.reset();
      closeModal("driverModal");
    } catch (err) {
      console.error("Driver creation failed:", err);
      if (secondaryApp) {
        try { await deleteApp(secondaryApp); } catch (_) {}
      }
      showToast(err.message || "Failed to create driver account", "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = "Create Driver Account";
    }
  });
}

// ── Challans ───────────────────────────────────────────────────────

function subscribeChallans() {
  if (unsubChallans) unsubChallans();
  const q = query(collection(db, "delivery_challans"), orderBy("createdAt", "desc"));
  unsubChallans = onSnapshot(q,
    (snap) => {
      challans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderChallansTable();
      updateActiveDeliveriesKPI();
      updateDriversStats();
      refreshTrackingMap();
      renderReports();
    },
    (err) => { console.error("Challans listener error:", err); }
  );
}

function updateActiveDeliveriesKPI() {
  const el = document.getElementById("kpiActive");
  if (!el) return;
  const active = challans.filter(
    (c) => c.status === "assigned" || c.status === "out_for_delivery"
  ).length;
  el.textContent = active.toString();
}

function statusBadgeClass(status) {
  return {
    draft:            "badge--draft",
    assigned:         "badge--assigned",
    out_for_delivery: "badge--transit",
    delivered:        "badge--delivered",
    not_received:     "badge--danger",
    converted:        "badge--converted"
  }[status] || "badge--draft";
}

function statusLabel(status) {
  return {
    draft:            "Draft",
    assigned:         "Assigned",
    out_for_delivery: "Out for delivery",
    delivered:        "Delivered",
    not_received:     "Not received",
    converted:        "Converted"
  }[status] || status;
}

function renderChallansTable() {
  const tbody = document.getElementById("challansTableBody");
  if (!tbody) return;

  if (challans.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <div class="empty-state__icon">📋</div>
          <div class="empty-state__title">No challans yet</div>
          <div class="empty-state__text">Click "New Challan" to create one.</div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = challans.map((c) => {
    const total    = Number(c.total) || 0;
    const badge    = statusBadgeClass(c.status);
    const label    = statusLabel(c.status);
    const itemList = Array.isArray(c.items) ? c.items : [];
    const assignBtn = c.status === "draft"
      ? `<button class="row-btn" style="background:#eff6ff;color:#2563eb;"
                data-action="assign-challan" data-id="${c.id}">Assign</button>`
      : "";
    return `
      <tr>
        <td data-label="Challan #"><strong>${esc(c.challanNumber)}</strong></td>
        <td data-label="Shop">${esc(c.shopName)}</td>
        <td data-label="Items">${itemList.length} item${itemList.length !== 1 ? "s" : ""}</td>
        <td data-label="Total" class="money">₹${total.toLocaleString("en-IN")}</td>
        <td data-label="Driver">${c.driverName ? esc(c.driverName) : '<span class="muted">—</span>'}</td>
        <td data-label="Status"><span class="badge ${badge}">${label}</span></td>
        <td data-label="Actions" class="actions">
          <button class="row-btn row-btn--view" data-action="view-challan"   data-id="${c.id}">View</button>
          ${assignBtn}
          <button class="row-btn row-btn--del"  data-action="del-challan"    data-id="${c.id}">Delete</button>
        </td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { action, id } = btn.dataset;
      if (action === "view-challan")   viewChallan(id);
      if (action === "assign-challan") openAssignDriverModal(id);
      if (action === "del-challan")    deleteChallan(id);
    });
  });
}

function addChallanItemRow() {
  const row = document.createElement("div");
  row.className = "item-row";

  const sel = document.createElement("select");
  sel.className = "field__input item-row__select";
  sel.dataset.role = "product";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "— Product —";
  sel.appendChild(defaultOpt);
  products.forEach((p) => {
    const opt = document.createElement("option");
    opt.value        = p.id;
    opt.textContent  = p.name;
    opt.dataset.price = String(p.selling_price || 0);
    opt.dataset.unit  = p.unit || "pc";
    sel.appendChild(opt);
  });

  const qtyInput = document.createElement("input");
  qtyInput.type      = "number";
  qtyInput.className = "field__input item-row__qty";
  qtyInput.dataset.role = "qty";
  qtyInput.min   = "1";
  qtyInput.value = "1";

  const priceDiv = document.createElement("div");
  priceDiv.className    = "item-row__price";
  priceDiv.dataset.role = "price";
  priceDiv.textContent  = "₹0";

  const removeBtn = document.createElement("button");
  removeBtn.type          = "button";
  removeBtn.className     = "item-row__remove";
  removeBtn.dataset.role  = "remove";
  removeBtn.textContent   = "×";

  function updateRowPrice() {
    const selectedOpt = sel.options[sel.selectedIndex];
    const price = parseFloat(selectedOpt?.dataset?.price || 0);
    const qty   = parseInt(qtyInput.value, 10) || 0;
    const lineTotal = price * qty;
    priceDiv.textContent = `₹${lineTotal.toLocaleString("en-IN")}`;
    recalcChallanTotal();
  }

  sel.addEventListener("change", updateRowPrice);
  qtyInput.addEventListener("input", updateRowPrice);

  removeBtn.addEventListener("click", () => {
    const container = document.getElementById("challanItems");
    if (container && container.children.length <= 1) {
      showToast("At least one item is required.", "warning");
      return;
    }
    row.remove();
    recalcChallanTotal();
  });

  row.appendChild(sel);
  row.appendChild(qtyInput);
  row.appendChild(priceDiv);
  row.appendChild(removeBtn);
  return row;
}

function recalcChallanTotal() {
  const container = document.getElementById("challanItems");
  if (!container) return;
  let grand = 0;
  container.querySelectorAll(".item-row").forEach((row) => {
    const sel   = row.querySelector("[data-role='product']");
    const qty   = row.querySelector("[data-role='qty']");
    const price = parseFloat(sel?.options[sel.selectedIndex]?.dataset?.price || 0);
    const q     = parseInt(qty?.value, 10) || 0;
    grand += price * q;
  });
  const el = document.getElementById("challanTotalValue");
  if (el) el.textContent = grand.toLocaleString("en-IN");
}

function openChallanModal() {
  document.getElementById("challanForm").reset();
  document.getElementById("challanTotalValue").textContent = "0";

  const shopSel = document.getElementById("challanShop");
  shopSel.innerHTML = '<option value="">— Select shop —</option>';
  shops.forEach((s) => {
    const opt = document.createElement("option");
    opt.value       = s.id;
    opt.textContent = s.name;
    shopSel.appendChild(opt);
  });

  const container = document.getElementById("challanItems");
  container.innerHTML = "";
  container.appendChild(addChallanItemRow());

  openModal("challanModal");
}

function setupChallanForm() {
  document.getElementById("addChallanItemBtn")
    ?.addEventListener("click", () => {
      const container = document.getElementById("challanItems");
      if (container) container.appendChild(addChallanItemRow());
      recalcChallanTotal();
    });

  document.getElementById("challanForm")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;

      try {
        const shopId = document.getElementById("challanShop").value;
        if (!shopId) {
          showToast("Please select a shop.", "warning");
          return;
        }

        const container = document.getElementById("challanItems");
        const itemRows  = container.querySelectorAll(".item-row");
        const items = [];
        let valid = true;

        itemRows.forEach((row) => {
          const sel       = row.querySelector("[data-role='product']");
          const qtyInput  = row.querySelector("[data-role='qty']");
          const productId = sel.value;
          const qty       = parseInt(qtyInput.value, 10) || 0;
          if (!productId || qty < 1) { valid = false; return; }

          const product = products.find((p) => p.id === productId);
          if (!product) { valid = false; return; }

          const unitPrice = Number(product.selling_price) || 0;
          items.push({
            productId,
            productName: product.name,
            unit:        product.unit || "pc",
            quantity:    qty,
            unitPrice,
            total:       unitPrice * qty
          });
        });

        if (!valid || items.length === 0) {
          showToast("Please fill all items with a product and quantity ≥ 1.", "warning");
          return;
        }

        const grandTotal = items.reduce((sum, it) => sum + it.total, 0);
        const shop = shops.find((s) => s.id === shopId);
        if (!shop) { showToast("Shop not found.", "error"); return; }

        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const seqQuery = query(
          collection(db, "delivery_challans"),
          where("dateStr", "==", todayStr),
          limit(100)
        );
        const seqSnap    = await getDocs(seqQuery);
        const seqNum     = seqSnap.size + 1;
        const challanNumber = `DC-${todayStr}-${String(seqNum).padStart(3, "0")}`;
        const otp = String(Math.floor(1000 + Math.random() * 9000));

        await addDoc(collection(db, "delivery_challans"), {
          challanNumber,
          dateStr:       todayStr,
          shopId,
          shopName:      shop.name,
          shopAddress:   shop.address || "",
          shopPhone:     shop.phone   || "",
          shopLatitude:  shop.latitude != null ? Number(shop.latitude) : null,
          shopLongitude: shop.longitude != null ? Number(shop.longitude) : null,
          items,
          total:         grandTotal,
          driverId:      null,
          driverName:    null,
          vehicleNumber: null,
          status:        "draft",
          otp,
          pod:           null,
          assignedAt:    null,
          deliveredAt:   null,
          createdAt:     serverTimestamp(),
          updatedAt:     serverTimestamp()
        });

        closeModal("challanModal");
        showToast(`Draft ${challanNumber} created. OTP: ${otp}`, "success", 6000);
      } catch (err) {
        console.error("Create challan failed:", err);
        showToast("Could not create challan", "error");
      } finally {
        btn.disabled = false;
      }
    });
}

function openAssignDriverModal(id) {
  const challan = challans.find((c) => c.id === id);
  if (!challan) return;

  document.getElementById("assignChallanId").value = id;
  document.getElementById("assignChallanLabel").textContent = challan.challanNumber;

  const driverSel = document.getElementById("assignDriverSelect");
  driverSel.innerHTML = '<option value="">— Select driver —</option>';
  drivers.filter(d => d.active !== false).forEach((d) => {
    const opt = document.createElement("option");
    opt.value       = d.id;
    opt.textContent = `${d.name} (${d.vehicleNumber || "—"})`;
    driverSel.appendChild(opt);
  });

  openModal("assignDriverModal");
}

function setupAssignDriverForm() {
  document.getElementById("assignDriverForm")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn      = e.target.querySelector('button[type="submit"]');
      btn.disabled   = true;

      const challanId = document.getElementById("assignChallanId").value;
      const driverId  = document.getElementById("assignDriverSelect").value;

      if (!driverId) {
        showToast("Please select a driver.", "warning");
        btn.disabled = false;
        return;
      }

      const driver = drivers.find((d) => d.id === driverId);
      if (!driver) {
        showToast("Driver not found.", "error");
        btn.disabled = false;
        return;
      }

      try {
        await updateDoc(doc(db, "delivery_challans", challanId), {
          driverId,
          driverName:    driver.name,
          vehicleNumber: driver.vehicleNumber || null,
          status:        "assigned",
          assignedAt:    serverTimestamp(),
          updatedAt:     serverTimestamp()
        });
        showToast(`Driver ${driver.name} assigned.`, "success");
        closeModal("assignDriverModal");
      } catch (err) {
        console.error("Assign driver failed:", err);
        showToast("Could not assign driver", "error");
      } finally {
        btn.disabled = false;
      }
    });
}

function viewChallan(id) {
  const c = challans.find((ch) => ch.id === id);
  if (!c) return;
  currentChallanId = id;

  const date = c.createdAt?.toDate
    ? c.createdAt.toDate().toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric"
      })
    : "—";

  const total    = Number(c.total) || 0;
  const badge    = statusBadgeClass(c.status);
  const label    = statusLabel(c.status);
  const itemList = Array.isArray(c.items) ? c.items : [];

  const itemRows = itemList.map((it) => `
    <tr>
      <td>${esc(it.productName)}</td>
      <td>${it.quantity} ${esc(it.unit || "")}</td>
      <td>₹${Number(it.unitPrice).toLocaleString("en-IN")}</td>
      <td>₹${Number(it.total).toLocaleString("en-IN")}</td>
    </tr>`).join("");

  let podHtml = "";
  if (c.pod) {
    const podDate = c.pod.timestamp
      ? new Date(c.pod.timestamp).toLocaleString("en-IN")
      : "—";
    podHtml = `
      <div style="background:#f9fafb; border:1.5px solid var(--border); border-radius:10px; padding:14px; margin-bottom:16px;">
        <div class="challan-doc__section-title" style="margin-bottom:8px;">Proof of Delivery (PoD)</div>
        <div style="font-size:13px; line-height:1.6;">
          ${c.pod.received
            ? `<div style="color:#047857; font-weight:700;"><i class="fa-solid fa-circle-check"></i> ✅ Received on ${podDate}</div>`
            : `<div style="color:#b91c1c; font-weight:700;"><i class="fa-solid fa-circle-xmark"></i> ❌ Not received — Reason: ${esc(c.pod.reason || "Not specified")}</div>`}
          ${c.pod.notes ? `<div style="color:var(--text-muted); margin-top:4px;">Notes: ${esc(c.pod.notes)}</div>` : ""}
          ${c.pod.collectedAmount ? `<div style="margin-top:4px;"><strong>Collected: ₹${Number(c.pod.collectedAmount).toLocaleString("en-IN")} (${esc(c.pod.method || "Cash")})</strong></div>` : ""}
        </div>
        ${c.pod.photoUrl ? `
          <div style="margin-top:10px;">
            <a href="${c.pod.photoUrl}" target="_blank" rel="noopener">
              <img src="${c.pod.photoUrl}" alt="Proof of delivery"
                   style="max-width:200px; max-height:140px; border-radius:8px; border:1px solid var(--border); object-fit:cover; display:block;">
            </a>
          </div>` : ""}
      </div>`;
  } else {
    podHtml = `
      <div style="background:#f9fafb; border:1px dashed var(--border); border-radius:8px; padding:10px; margin-bottom:16px; font-size:12px; color:var(--text-muted); text-align:center;">
        Pending delivery (No proof of delivery recorded yet)
      </div>`;
  }

  document.getElementById("challanViewBody").innerHTML = `
    <div class="challan-doc">
      <div class="challan-doc__header">
        <div>
          <div class="challan-doc__brand">DistroMS</div>
          <div class="challan-doc__tagline">Distribution &amp; Delivery Tracking</div>
        </div>
        <div class="challan-doc__number">
          <div class="challan-doc__number-label">Challan No.</div>
          <div class="challan-doc__number-value">${esc(c.challanNumber)}</div>
          <div class="challan-doc__tagline">${date}</div>
        </div>
      </div>

      <div class="challan-doc__grid">
        <div>
          <div class="challan-doc__section-title">Deliver To</div>
          <div class="challan-doc__value">
            <strong>${esc(c.shopName)}</strong><br>
            ${c.shopAddress ? esc(c.shopAddress) + "<br>" : ""}
            ${c.shopPhone ? "Phone: " + esc(c.shopPhone) : ""}
          </div>
        </div>
        <div>
          <div class="challan-doc__section-title">Delivery</div>
          <div class="challan-doc__value">
            Driver: ${c.driverName ? esc(c.driverName) : "—"}<br>
            Vehicle: ${c.vehicleNumber ? esc(c.vehicleNumber) : "—"}<br>
            Status: <span class="badge ${badge}">${label}</span>
          </div>
        </div>
      </div>

      ${podHtml}

      <div class="challan-doc__otp-box">
        <div class="challan-doc__otp-label">Shop OTP</div>
        <div class="challan-doc__otp-value">${esc(c.otp)}</div>
        <div class="challan-doc__otp-hint">
          Share with shopkeeper — they give it to the driver on delivery.
        </div>
      </div>

      <table class="challan-doc__table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Qty</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <div class="challan-doc__total-row">
        <div class="challan-doc__total-label">Grand Total</div>
        <div class="challan-doc__total-value">₹${total.toLocaleString("en-IN")}</div>
      </div>

      <div class="challan-doc__footer">
        This is a system generated delivery challan. — DistroMS v2
      </div>
    </div>`;

  openModal("challanViewModal");
}

function printChallan() {
  if (!currentChallanId) return;
  window.print();
}

async function downloadChallanPDF() {
  if (!currentChallanId) return;
  const challan = challans.find((c) => c.id === currentChallanId);
  const element = document.querySelector("#challanViewBody .challan-doc");
  if (!element) { showToast("Nothing to export.", "warning"); return; }

  showToast("Generating PDF…", "info");
  try {
    const canvas  = await window.html2canvas(element, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const imgW = 190;
    const imgH = (canvas.height * imgW) / canvas.width;
    pdf.addImage(imgData, "PNG", 10, 10, imgW, imgH);
    pdf.save(`${challan?.challanNumber || "challan"}.pdf`);
    showToast("PDF downloaded.", "success");
  } catch (err) {
    console.error("PDF generation failed:", err);
    showToast("PDF generation failed.", "error");
  }
}

async function deleteChallan(id) {
  const challan = challans.find((c) => c.id === id);
  if (!challan) return;
  if (!confirm(`Delete challan "${challan.challanNumber}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "delivery_challans", id));
    showToast("Challan deleted.", "success");
  } catch (err) {
    console.error(err);
    showToast("Could not delete challan.", "error");
  }
}

// ── Sales Section (Section H) ──────────────────────────────────────

function subscribeSales() {
  if (unsubSales) unsubSales();
  const q = query(collection(db, "sales"), orderBy("createdAt", "desc"));
  unsubSales = onSnapshot(q, (snap) => {
    sales = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSalesTable();
    updateSalesStats();
    renderReports();
  }, (err) => {
    console.error("Sales listener error:", err);
  });
}

function updateSalesStats() {
  const totalSales = sales.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const totalCollected = sales.reduce((a, s) => a + (Number(s.amountPaid) || 0), 0);
  const totalPending = sales.reduce((a, s) => a + (Number(s.pendingAmount) || 0), 0);

  const tEl = document.getElementById("statTotalSales");
  const cEl = document.getElementById("statCollectedSales");
  const pEl = document.getElementById("statPendingSales");

  if (tEl) tEl.textContent = "₹" + totalSales.toLocaleString("en-IN");
  if (cEl) cEl.textContent = "₹" + totalCollected.toLocaleString("en-IN");
  if (pEl) pEl.textContent = "₹" + totalPending.toLocaleString("en-IN");
}

function renderSalesTable() {
  const tbody = document.getElementById("salesTableBody");
  if (!tbody) return;

  if (sales.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty-state">
          <div class="empty-state__icon">🧾</div>
          <div class="empty-state__title">No sales recorded</div>
          <div class="empty-state__text">Click "New Sale" to record a direct counter or invoice sale.</div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = sales.map((s) => {
    const total   = Number(s.total) || 0;
    const paid    = Number(s.amountPaid) || 0;
    const pending = Number(s.pendingAmount) || 0;
    const items   = Array.isArray(s.items) ? s.items : [];

    let statusBadge = `<span class="badge badge--success">Paid</span>`;
    if (s.paymentStatus === "Partial") {
      statusBadge = `<span class="badge badge--warning">Partial</span>`;
    } else if (s.paymentStatus === "Pending") {
      statusBadge = `<span class="badge badge--danger">Pending</span>`;
    }

    const dateDisplay = s.dateStr || (s.createdAt?.toDate ? s.createdAt.toDate().toISOString().slice(0,10) : "—");

    return `
      <tr>
        <td data-label="Invoice #"><strong>${esc(s.invoiceNumber)}</strong></td>
        <td data-label="Shop">${esc(s.shopName)}</td>
        <td data-label="Items">${items.length} item(s)</td>
        <td data-label="Total" class="money">₹${total.toLocaleString("en-IN")}</td>
        <td data-label="Paid" class="money" style="color:#059669;">₹${paid.toLocaleString("en-IN")}</td>
        <td data-label="Pending" class="money" style="${pending > 0 ? 'color:#dc2626;font-weight:700;' : ''}">₹${pending.toLocaleString("en-IN")}</td>
        <td data-label="Status">${statusBadge}</td>
        <td data-label="Date" class="muted">${dateDisplay}</td>
        <td data-label="Actions" class="actions">
          <button class="row-btn row-btn--view" data-action="view-invoice" data-id="${s.id}">
            View Invoice
          </button>
          <button class="row-btn row-btn--del" data-action="del-sale" data-id="${s.id}">
            Delete
          </button>
        </td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action='view-invoice']").forEach((btn) => {
    btn.addEventListener("click", () => viewSaleInvoice(btn.dataset.id));
  });

  tbody.querySelectorAll("[data-action='del-sale']").forEach((btn) => {
    btn.addEventListener("click", () => deleteSale(btn.dataset.id));
  });
}

/**
 * Deletes a sale, reversing product stock decrements and shop pending fees.
 * @param {string} id - Firestore sale ID
 */
async function deleteSale(id) {
  const s = sales.find((x) => x.id === id);
  if (!s) return;

  if (!confirm(`Delete invoice "${s.invoiceNumber}"? This will restore product inventory and reverse pending balance.`)) {
    return;
  }

  try {
    const batch = writeBatch(db);

    // Restore stock for each product in items
    (s.items || []).forEach((it) => {
      if (it.productId && it.quantity) {
        const prodRef = doc(db, "products", it.productId);
        batch.update(prodRef, {
          stock: increment(it.quantity),
          updatedAt: serverTimestamp()
        });
      }
    });

    // Reverse pending fees on shop
    const pendingToReverse = Number(s.pendingAmount) || 0;
    if (pendingToReverse > 0 && s.shopId) {
      const shopRef = doc(db, "shops", s.shopId);
      batch.update(shopRef, {
        pending_fees: increment(-pendingToReverse),
        updatedAt: serverTimestamp()
      });
    }

    // Delete sale document
    const saleRef = doc(db, "sales", id);
    batch.delete(saleRef);

    await batch.commit();

    showToast(`Invoice ${s.invoiceNumber} deleted and stock/pending reversed!`, "success");
  } catch (err) {
    console.error("Delete sale error:", err);
    showToast("Failed to delete invoice: " + err.message, "error");
  }
}

function addSaleItemRow() {
  const row = document.createElement("div");
  row.className = "item-row";

  const sel = document.createElement("select");
  sel.className = "field__input item-row__select";
  sel.dataset.role = "product";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "— Product —";
  sel.appendChild(defaultOpt);
  products.forEach((p) => {
    const opt = document.createElement("option");
    opt.value        = p.id;
    opt.textContent  = `${p.name} (Stock: ${p.stock ?? 0})`;
    opt.dataset.price = String(p.selling_price || 0);
    opt.dataset.unit  = p.unit || "pc";
    opt.dataset.stock = String(p.stock ?? 0);
    sel.appendChild(opt);
  });

  const qtyInput = document.createElement("input");
  qtyInput.type      = "number";
  qtyInput.className = "field__input item-row__qty";
  qtyInput.dataset.role = "qty";
  qtyInput.min   = "1";
  qtyInput.value = "1";

  const priceDiv = document.createElement("div");
  priceDiv.className    = "item-row__price";
  priceDiv.dataset.role = "price";
  priceDiv.textContent  = "₹0";

  const removeBtn = document.createElement("button");
  removeBtn.type          = "button";
  removeBtn.className     = "item-row__remove";
  removeBtn.dataset.role  = "remove";
  removeBtn.textContent   = "×";

  function updateRowPrice() {
    const selectedOpt = sel.options[sel.selectedIndex];
    const price = parseFloat(selectedOpt?.dataset?.price || 0);
    const qty   = parseInt(qtyInput.value, 10) || 0;
    const lineTotal = price * qty;
    priceDiv.textContent = `₹${lineTotal.toLocaleString("en-IN")}`;
    recalcSaleTotal();
  }

  sel.addEventListener("change", updateRowPrice);
  qtyInput.addEventListener("input", updateRowPrice);

  removeBtn.addEventListener("click", () => {
    const container = document.getElementById("saleItems");
    if (container && container.children.length <= 1) {
      showToast("At least one item is required.", "warning");
      return;
    }
    row.remove();
    recalcSaleTotal();
  });

  row.appendChild(sel);
  row.appendChild(qtyInput);
  row.appendChild(priceDiv);
  row.appendChild(removeBtn);
  return row;
}

function recalcSaleTotal() {
  const container = document.getElementById("saleItems");
  if (!container) return;
  let grand = 0;
  container.querySelectorAll(".item-row").forEach((row) => {
    const sel   = row.querySelector("[data-role='product']");
    const qty   = row.querySelector("[data-role='qty']");
    const price = parseFloat(sel?.options[sel.selectedIndex]?.dataset?.price || 0);
    const q     = parseInt(qty?.value, 10) || 0;
    grand += price * q;
  });

  const paidInput = document.getElementById("salePaid");
  const paidVal = Math.max(0, Number(paidInput?.value) || 0);
  const pending = Math.max(0, grand - paidVal);

  const totalEl = document.getElementById("saleTotalValue");
  const pendEl  = document.getElementById("salePendingValue");
  if (totalEl) totalEl.textContent = grand.toLocaleString("en-IN");
  if (pendEl)  pendEl.textContent  = pending.toLocaleString("en-IN");
}

function openSaleModal() {
  const form = document.getElementById("saleForm");
  if (form) form.reset();

  const shopSel = document.getElementById("saleShop");
  shopSel.innerHTML = '<option value="">— Select shop —</option>';
  shops.forEach((s) => {
    const opt = document.createElement("option");
    opt.value       = s.id;
    opt.textContent = `${s.name} (Pending: ₹${(Number(s.pending_fees) || 0).toLocaleString("en-IN")})`;
    shopSel.appendChild(opt);
  });

  const container = document.getElementById("saleItems");
  container.innerHTML = "";
  container.appendChild(addSaleItemRow());

  document.getElementById("salePaid").value = "0";
  recalcSaleTotal();

  openModal("saleModal");
}

function setupSaleForm() {
  document.getElementById("addSaleItemBtn")?.addEventListener("click", () => {
    const container = document.getElementById("saleItems");
    if (container) container.appendChild(addSaleItemRow());
    recalcSaleTotal();
  });

  document.getElementById("salePaid")?.addEventListener("input", recalcSaleTotal);

  document.getElementById("saleForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("saveSaleBtn");
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';

    try {
      const shopId = document.getElementById("saleShop").value;
      if (!shopId) {
        showToast("Please select a shop.", "warning");
        btn.disabled = false;
        btn.innerHTML = "Create Sale & Invoice";
        return;
      }

      const shop = shops.find((s) => s.id === shopId);
      if (!shop) {
        showToast("Shop not found.", "error");
        btn.disabled = false;
        btn.innerHTML = "Create Sale & Invoice";
        return;
      }

      const container = document.getElementById("saleItems");
      const rows = container.querySelectorAll(".item-row");
      const items = [];
      let valid = true;

      rows.forEach((row) => {
        const sel = row.querySelector("[data-role='product']");
        const qtyInput = row.querySelector("[data-role='qty']");
        const productId = sel.value;
        const qty = parseInt(qtyInput.value, 10) || 0;
        if (!productId || qty < 1) { valid = false; return; }

        const product = products.find((p) => p.id === productId);
        if (!product) { valid = false; return; }

        const unitPrice = Number(product.selling_price) || 0;
        items.push({
          productId,
          productName: product.name,
          unit: product.unit || "pc",
          quantity: qty,
          unitPrice,
          total: unitPrice * qty
        });
      });

      if (!valid || items.length === 0) {
        showToast("Please select valid products with quantity ≥ 1", "warning");
        btn.disabled = false;
        btn.innerHTML = "Create Sale & Invoice";
        return;
      }

      const grandTotal = items.reduce((sum, it) => sum + it.total, 0);
      const paid = Math.max(0, Number(document.getElementById("salePaid").value) || 0);
      const pendingAmount = Math.max(0, grandTotal - paid);
      const paymentMethod = document.getElementById("salePaymentMethod").value || "Cash";
      const paymentStatus = pendingAmount <= 0 ? "Paid" : (paid > 0 ? "Partial" : "Pending");

      const todayStr = new Date().toISOString().slice(0, 10);
      const dateStrNum = todayStr.replace(/-/g, "");

      const seqQuery = query(
        collection(db, "sales"),
        where("dateStr", "==", todayStr),
        limit(100)
      );
      const seqSnap = await getDocs(seqQuery);
      const seqNum = seqSnap.size + 1;
      const invoiceNumber = `INV-${dateStrNum}-${String(seqNum).padStart(3, "0")}`;

      const batch = writeBatch(db);
      const saleRef = doc(collection(db, "sales"));

      batch.set(saleRef, {
        invoiceNumber,
        shopId,
        shopName: shop.name,
        items,
        total: grandTotal,
        amountPaid: paid,
        pendingAmount,
        paymentStatus,
        paymentMethod,
        dateStr: todayStr,
        date: todayStr,
        createdAt: serverTimestamp(),
        timestamp: serverTimestamp()
      });

      items.forEach((it) => {
        const prodRef = doc(db, "products", it.productId);
        batch.update(prodRef, {
          stock: increment(-it.quantity),
          updatedAt: serverTimestamp()
        });
      });

      if (pendingAmount !== 0) {
        const shopRef = doc(db, "shops", shopId);
        batch.update(shopRef, {
          pending_fees: increment(pendingAmount),
          updatedAt: serverTimestamp()
        });
      }

      if (paid > 0) {
        const payRef = doc(collection(db, "payments"));
        const prevPending = Number(shop.pending_fees) || 0;
        batch.set(payRef, {
          shopId,
          shopName: shop.name,
          amountCollected: paid,
          previousPending: prevPending,
          newPending: prevPending + pendingAmount,
          paymentMethod,
          note: `Upfront payment for ${invoiceNumber}`,
          collectedBy: currentUser.email,
          date: todayStr,
          timestamp: serverTimestamp()
        });
      }

      await batch.commit();

      showToast(`Sale recorded! Invoice #${invoiceNumber}`, "success");
      closeModal("saleModal");
    } catch (err) {
      console.error("Sale commit error:", err);
      showToast("Failed to create sale: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = "Create Sale & Invoice";
    }
  });
}

function viewSaleInvoice(id) {
  const s = sales.find((x) => x.id === id);
  if (!s) return;
  currentSaleId = id;

  const date = s.dateStr || (s.createdAt?.toDate ? s.createdAt.toDate().toISOString().slice(0,10) : "—");
  const total = Number(s.total) || 0;
  const paid = Number(s.amountPaid) || 0;
  const pending = Number(s.pendingAmount) || 0;

  const itemRows = (s.items || []).map((it) => `
    <tr>
      <td>${esc(it.productName)}</td>
      <td>${it.quantity} ${esc(it.unit || "")}</td>
      <td>₹${Number(it.unitPrice).toLocaleString("en-IN")}</td>
      <td>₹${Number(it.total).toLocaleString("en-IN")}</td>
    </tr>`).join("");

  document.getElementById("saleInvoiceBody").innerHTML = `
    <div class="challan-doc">
      <div class="challan-doc__header">
        <div>
          <div class="challan-doc__brand">DistroMS</div>
          <div class="challan-doc__tagline">Official Tax Invoice</div>
        </div>
        <div class="challan-doc__number">
          <div class="challan-doc__number-label">Invoice No.</div>
          <div class="challan-doc__number-value">${esc(s.invoiceNumber)}</div>
          <div class="challan-doc__tagline">${date}</div>
        </div>
      </div>

      <div class="challan-doc__grid">
        <div>
          <div class="challan-doc__section-title">Billed To</div>
          <div class="challan-doc__value">
            <strong>${esc(s.shopName)}</strong>
          </div>
        </div>
        <div>
          <div class="challan-doc__section-title">Payment Info</div>
          <div class="challan-doc__value">
            Status: <strong>${esc(s.paymentStatus || "Paid")}</strong><br>
            Method: ${esc(s.paymentMethod || "Cash")}
          </div>
        </div>
      </div>

      <table class="challan-doc__table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Qty</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <div style="background:#f9fafb; border-radius:10px; padding:12px; margin-top:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span>Grand Total:</span>
          <strong>₹${total.toLocaleString("en-IN")}</strong>
        </div>
        <div style="display:flex; justify-content:space-between; margin-bottom:6px; color:#059669;">
          <span>Amount Paid:</span>
          <strong>₹${paid.toLocaleString("en-IN")}</strong>
        </div>
        <div style="display:flex; justify-content:space-between; border-top:1px dashed var(--border); padding-top:6px; font-size:16px; font-weight:800; color:${pending > 0 ? '#dc2626' : '#059669'};">
          <span>Pending Due:</span>
          <span>₹${pending.toLocaleString("en-IN")}</span>
        </div>
      </div>

      <div class="challan-doc__footer">
        Thank you for your business! — DistroMS Distribution Network
      </div>
    </div>`;

  openModal("saleInvoiceModal");
}

function printInvoice() {
  window.print();
}

async function downloadInvoicePDF() {
  if (!currentSaleId) return;
  const s = sales.find((x) => x.id === currentSaleId);
  const element = document.querySelector("#saleInvoiceBody .challan-doc");
  if (!element) return;

  showToast("Generating PDF…", "info");
  try {
    const canvas  = await window.html2canvas(element, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const imgW = 190;
    const imgH = (canvas.height * imgW) / canvas.width;
    pdf.addImage(imgData, "PNG", 10, 10, imgW, imgH);
    pdf.save(`${s?.invoiceNumber || "invoice"}.pdf`);
    showToast("Invoice downloaded.", "success");
  } catch (err) {
    console.error("PDF generation failed:", err);
    showToast("PDF generation failed.", "error");
  }
}

// ── Payments Section (Section I) ───────────────────────────────────

function subscribePayments() {
  if (unsubPayments) unsubPayments();
  const q = query(collection(db, "payments"), orderBy("timestamp", "desc"));
  unsubPayments = onSnapshot(q, (snap) => {
    payments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPaymentsTable();
    updatePaymentsStats();
    renderReports();
  }, (err) => {
    console.error("Payments listener error:", err);
  });
}

function updatePaymentsStats() {
  const totalCollected = payments.reduce((a, p) => a + (Number(p.amountCollected) || 0), 0);
  const totalAcrossShops = shops.reduce((a, s) => a + (Number(s.pending_fees) || 0), 0);

  const cEl = document.getElementById("statTotalPaymentsCollected");
  const pEl = document.getElementById("statPaymentsPendingAcrossShops");

  if (cEl) cEl.textContent = "₹" + totalCollected.toLocaleString("en-IN");
  if (pEl) pEl.textContent = "₹" + totalAcrossShops.toLocaleString("en-IN");
}

function renderPaymentsTable() {
  const tbody = document.getElementById("paymentsTableBody");
  if (!tbody) return;

  if (payments.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <div class="empty-state__icon">💰</div>
          <div class="empty-state__title">No payment collections yet</div>
          <div class="empty-state__text">Click "Collect Payment" to record a payment from any shop.</div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = payments.map((p) => {
    const amount = Number(p.amountCollected) || 0;
    const newPending = Number(p.newPending) || 0;
    const date = p.date || (p.timestamp?.toDate ? p.timestamp.toDate().toISOString().slice(0,10) : "—");

    return `
      <tr>
        <td data-label="Date" class="muted">${esc(date)}</td>
        <td data-label="Shop"><strong>${esc(p.shopName)}</strong></td>
        <td data-label="Amount" class="money" style="color:#059669;font-weight:700;">₹${amount.toLocaleString("en-IN")}</td>
        <td data-label="Method"><span class="badge badge--wholesaler">${esc(p.paymentMethod || "Cash")}</span></td>
        <td data-label="Note" class="muted">${esc(p.note) || "—"}</td>
        <td data-label="Collected By" class="muted">${esc(p.collectedBy) || "Admin"}</td>
        <td data-label="Remaining Pending" class="money">₹${newPending.toLocaleString("en-IN")}</td>
      </tr>`;
  }).join("");
}

function openPaymentModal() {
  const form = document.getElementById("paymentForm");
  if (form) form.reset();

  const shopSel = document.getElementById("paymentShop");
  shopSel.innerHTML = '<option value="">— Select shop —</option>';
  shops.forEach((s) => {
    const opt = document.createElement("option");
    opt.value       = s.id;
    opt.textContent = `${s.name} (Pending: ₹${(Number(s.pending_fees) || 0).toLocaleString("en-IN")})`;
    opt.dataset.pending = String(s.pending_fees || 0);
    shopSel.appendChild(opt);
  });

  const preview = document.getElementById("paymentShopPendingDisplay");
  if (preview) preview.style.display = "none";

  openModal("paymentModal");
}

function setupPaymentForm() {
  const shopSel = document.getElementById("paymentShop");
  const pendingDisplay = document.getElementById("paymentShopPendingDisplay");
  const pendingVal = document.getElementById("paymentCurrentPendingVal");
  const amountInput = document.getElementById("paymentAmount");
  const collectFullBtn = document.getElementById("collectFullBtn");

  shopSel?.addEventListener("change", () => {
    const selectedOpt = shopSel.options[shopSel.selectedIndex];
    const pending = parseFloat(selectedOpt?.dataset?.pending || 0);
    if (selectedOpt.value) {
      pendingDisplay.style.display = "block";
      pendingVal.textContent = pending.toLocaleString("en-IN");
      amountInput.value = pending > 0 ? pending : "";
    } else {
      pendingDisplay.style.display = "none";
    }
  });

  collectFullBtn?.addEventListener("click", () => {
    const selectedOpt = shopSel.options[shopSel.selectedIndex];
    const pending = parseFloat(selectedOpt?.dataset?.pending || 0);
    if (pending > 0) {
      amountInput.value = pending;
    }
  });

  document.getElementById("paymentForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("savePaymentBtn");
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';

    try {
      const shopId = shopSel.value;
      if (!shopId) {
        showToast("Please select a shop", "warning");
        btn.disabled = false;
        btn.innerHTML = "Confirm Payment";
        return;
      }

      const shop = shops.find((s) => s.id === shopId);
      if (!shop) {
        showToast("Shop not found", "error");
        btn.disabled = false;
        btn.innerHTML = "Confirm Payment";
        return;
      }

      const amount = Number(amountInput.value) || 0;
      if (amount <= 0) {
        showToast("Amount must be greater than zero", "warning");
        btn.disabled = false;
        btn.innerHTML = "Confirm Payment";
        return;
      }

      const paymentMethod = document.getElementById("paymentMethodSelect").value || "Cash";
      const note = document.getElementById("paymentNote").value.trim();
      const prevPending = Number(shop.pending_fees) || 0;
      const newPending = Math.max(0, prevPending - amount);
      const todayStr = new Date().toISOString().slice(0, 10);

      const batch = writeBatch(db);
      const shopRef = doc(db, "shops", shopId);
      batch.update(shopRef, {
        pending_fees: increment(-amount),
        updatedAt: serverTimestamp()
      });

      const payRef = doc(collection(db, "payments"));
      batch.set(payRef, {
        shopId,
        shopName: shop.name,
        amountCollected: amount,
        previousPending: prevPending,
        newPending,
        paymentMethod,
        note,
        collectedBy: currentUser.email,
        date: todayStr,
        timestamp: serverTimestamp()
      });

      await batch.commit();

      showToast(`Collected ₹${amount.toLocaleString("en-IN")} from ${shop.name}!`, "success");
      closeModal("paymentModal");
    } catch (err) {
      console.error("Payment commit error:", err);
      showToast("Payment failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = "Confirm Payment";
    }
  });
}

// ── Reports & Analytics (Section J) ────────────────────────────────

function renderReports() {
  const totalSales = sales.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const totalCollected = payments.reduce((a, p) => a + (Number(p.amountCollected) || 0), 0);
  const totalPending = shops.reduce((a, s) => a + (Number(s.pending_fees) || 0), 0);
  const totalChallansCount = challans.length;

  const repSalesEl = document.getElementById("reportTotalSales");
  const repCollEl  = document.getElementById("reportTotalCollected");
  const repPendEl  = document.getElementById("reportTotalPending");
  const repChalEl  = document.getElementById("reportTotalChallans");

  if (repSalesEl) repSalesEl.textContent = "₹" + totalSales.toLocaleString("en-IN");
  if (repCollEl)  repCollEl.textContent  = "₹" + totalCollected.toLocaleString("en-IN");
  if (repPendEl)  repPendEl.textContent  = "₹" + totalPending.toLocaleString("en-IN");
  if (repChalEl)  repChalEl.textContent  = totalChallansCount.toString();

  if (typeof Chart === "undefined") return;

  renderChartSales7Days();
  renderChartTopPending();
  renderChartTopProducts();
}

function renderChartSales7Days() {
  const canvas = document.getElementById("sales7DaysChart");
  if (!canvas) return;

  const days = [];
  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    days.push(iso);
    labels.push(d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }));
  }

  const totals = days.map((dayStr) => {
    return sales
      .filter((s) => (s.dateStr || s.date) === dayStr)
      .reduce((a, s) => a + (Number(s.total) || 0), 0);
  });

  if (chartSales7Days) chartSales7Days.destroy();

  chartSales7Days = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Sales (₹)",
        data: totals,
        backgroundColor: "rgba(102, 126, 234, 0.75)",
        borderColor: "#667eea",
        borderWidth: 1.5,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => "₹" + v.toLocaleString("en-IN") }
        }
      }
    }
  });
}

function renderChartTopPending() {
  const canvas = document.getElementById("topPendingShopsChart");
  if (!canvas) return;

  const topShops = [...shops]
    .filter((s) => (Number(s.pending_fees) || 0) > 0)
    .sort((a, b) => (Number(b.pending_fees) || 0) - (Number(a.pending_fees) || 0))
    .slice(0, 5);

  const labels = topShops.map((s) => s.name);
  const data = topShops.map((s) => Number(s.pending_fees) || 0);

  if (chartTopPending) chartTopPending.destroy();

  chartTopPending = new Chart(canvas, {
    type: "bar",
    data: {
      labels: labels.length ? labels : ["No dues"],
      datasets: [{
        label: "Pending Fees (₹)",
        data: data.length ? data : [0],
        backgroundColor: "rgba(220, 38, 38, 0.75)",
        borderColor: "#dc2626",
        borderWidth: 1.5,
        borderRadius: 6
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { callback: (v) => "₹" + v.toLocaleString("en-IN") }
        }
      }
    }
  });
}

function renderChartTopProducts() {
  const canvas = document.getElementById("topProductsChart");
  if (!canvas) return;

  const productQtys = {};
  sales.forEach((s) => {
    (s.items || []).forEach((it) => {
      const name = it.productName || "Unknown";
      productQtys[name] = (productQtys[name] || 0) + (Number(it.quantity) || 0);
    });
  });

  const sorted = Object.entries(productQtys)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const labels = sorted.map((x) => x[0]);
  const data = sorted.map((x) => x[1]);

  if (chartTopProducts) chartTopProducts.destroy();

  chartTopProducts = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: labels.length ? labels : ["No sales yet"],
      datasets: [{
        label: "Units Sold",
        data: data.length ? data : [0],
        backgroundColor: [
          "#3b82f6",
          "#10b981",
          "#f59e0b",
          "#8b5cf6",
          "#ec4899"
        ],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" }
      }
    }
  });
}

// ── Live Tracking & Arrival Detection (Section E & F) ──────────────

function initTrackingMap() {
  const el = document.getElementById("trackingMap");
  if (!el || trackingMap) return;

  try {
    trackingMap = L.map("trackingMap").setView([20.5937, 78.9629], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(trackingMap);
  } catch (err) {
    console.warn("Tracking map init failed:", err);
  }
}

function setupTrackingControls() {
  document.getElementById("trackingCenterBtn")?.addEventListener("click", () => {
    if (!trackingMap) return;
    const markers = Object.values(trackingDriverMarkers);
    if (markers.length > 0) {
      const group = L.featureGroup(markers);
      trackingMap.fitBounds(group.getBounds().pad(0.2));
      showToast("Fitted map to active drivers", "info");
    } else {
      showToast("No active driver markers on map", "info");
    }
  });
}

function subscribeDriverLocations() {
  if (unsubLocations) unsubLocations();
  const q = collection(db, "driver_locations");
  unsubLocations = onSnapshot(q, (snap) => {
    snap.docs.forEach((d) => {
      driverLocations[d.id] = { id: d.id, ...d.data() };
    });
    renderDriversTable();
    updateDriversStats();
    refreshTrackingDriversList();
    refreshTrackingMap();
    populateDriverRoleSubmenu();
  }, (err) => {
    console.error("driver_locations listener error:", err);
  });
}

function getDriverTargetChallan(driverId) {
  return challans.find(
    (c) => c.driverId === driverId && (c.status === "assigned" || c.status === "out_for_delivery")
  );
}

function refreshTrackingDriversList() {
  const container = document.getElementById("trackingDriversList");
  const countEl = document.getElementById("activeDriversCount");
  if (!container) return;

  const activeDrivers = drivers.filter((d) => isDriverOnline(d.id));
  if (countEl) {
    countEl.textContent = `${activeDrivers.length} Active`;
  }

  if (activeDrivers.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:30px 10px;">
        <div class="empty-state__icon">📡</div>
        <div class="empty-state__title">No active drivers</div>
        <div class="empty-state__text">Drivers will appear here when their app is open and broadcasting GPS.</div>
      </div>`;
    return;
  }

  container.innerHTML = activeDrivers.map((d) => {
    const loc = driverLocations[d.id] || {};
    const targetChallan = getDriverTargetChallan(d.id);

    let distanceText = "No target shop";
    if (targetChallan && targetChallan.shopLatitude && targetChallan.shopLongitude && loc.lat && loc.lng) {
      const dist = distanceMeters(loc.lat, loc.lng, targetChallan.shopLatitude, targetChallan.shopLongitude);
      distanceText = dist < 1000
        ? `~${Math.round(dist)} m to shop`
        : `~${(dist / 1000).toFixed(1)} km to shop`;
    }

    const lastPingAgo = loc.updatedAt
      ? `${Math.max(1, Math.round((Date.now() - loc.updatedAt) / 1000))}s ago`
      : "Just now";

    const isSelected = selectedTrackingDriver === d.id ? "is-selected" : "";

    return `
      <div class="driver-status-card ${isSelected}" data-driver-id="${d.id}">
        <div class="driver-status-card__header">
          <div class="driver-status-card__name">
            <span class="status-dot-sm is-online"></span>
            ${esc(d.name)}
          </div>
          <span class="driver-status-card__vehicle">${esc(d.vehicleNumber || "Vehicle")}</span>
        </div>
        <div class="driver-status-card__row">
          <i class="fa-solid fa-store"></i>
          <span class="driver-status-card__target">
            ${targetChallan ? esc(targetChallan.shopName) : "Idle (No assigned route)"}
          </span>
        </div>
        <div class="driver-status-card__distance">
          <span><i class="fa-solid fa-clock"></i> Ping: ${lastPingAgo}</span>
          <strong style="color:var(--primary);">${distanceText}</strong>
        </div>
      </div>`;
  }).join("");

  container.querySelectorAll(".driver-status-card").forEach((card) => {
    card.addEventListener("click", () => {
      const driverId = card.dataset.driverId;
      selectedTrackingDriver = driverId;
      container.querySelectorAll(".driver-status-card").forEach((c) => c.classList.remove("is-selected"));
      card.classList.add("is-selected");

      const loc = driverLocations[driverId];
      if (loc && loc.lat && loc.lng && trackingMap) {
        trackingMap.setView([loc.lat, loc.lng], 16);
        trackingDriverMarkers[driverId]?.openPopup();
      }
    });
  });
}

async function refreshTrackingMap() {
  if (!trackingMap) return;

  try {
    Object.keys(trackingDriverMarkers).forEach((dId) => {
      if (!isDriverOnline(dId)) {
        trackingMap.removeLayer(trackingDriverMarkers[dId]);
        delete trackingDriverMarkers[dId];
      }
    });

    Object.keys(trackingRouteLines).forEach((dId) => {
      if (!isDriverOnline(dId)) {
        trackingMap.removeLayer(trackingRouteLines[dId]);
        delete trackingRouteLines[dId];
      }
    });

    Object.keys(trackingShopMarkers).forEach((sId) => {
      trackingMap.removeLayer(trackingShopMarkers[sId]);
      delete trackingShopMarkers[sId];
    });

    const activeDrivers = drivers.filter((d) => isDriverOnline(d.id));
    const allBounds = [];

    for (const d of activeDrivers) {
      const loc = driverLocations[d.id];
      if (!loc || !loc.lat || !loc.lng) continue;

      const lat = Number(loc.lat);
      const lng = Number(loc.lng);
      allBounds.push([lat, lng]);

      const truckIcon = L.divIcon({
        className: "driver-truck-marker",
        html: `<div class="driver-pin"><i class="fa-solid fa-truck"></i></div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
      });

      const targetChallan = getDriverTargetChallan(d.id);
      const popupHtml = `
        <div style="font-size:13px; font-weight:700; color:var(--text); margin-bottom:4px;">
          🚚 ${esc(d.name)} (${esc(d.vehicleNumber || "")})
        </div>
        <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">
          Speed: ${Math.round(loc.speed || 0)} km/h • Heading: ${Math.round(loc.heading || 0)}°
        </div>
        <div style="font-size:12px; color:var(--primary); font-weight:600;">
          Target: ${targetChallan ? esc(targetChallan.shopName) : "No active challan"}
        </div>`;

      if (trackingDriverMarkers[d.id]) {
        trackingDriverMarkers[d.id].setLatLng([lat, lng]);
        trackingDriverMarkers[d.id].setPopupContent(popupHtml);
      } else {
        const marker = L.marker([lat, lng], { icon: truckIcon }).addTo(trackingMap);
        marker.bindPopup(popupHtml);
        trackingDriverMarkers[d.id] = marker;
      }

      if (targetChallan && targetChallan.shopLatitude && targetChallan.shopLongitude) {
        const sLat = Number(targetChallan.shopLatitude);
        const sLng = Number(targetChallan.shopLongitude);
        allBounds.push([sLat, sLng]);

        const shopIcon = L.divIcon({
          className: "driver-truck-marker",
          html: `<div class="shop-pin"><i class="fa-solid fa-store"></i></div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });

        if (!trackingShopMarkers[targetChallan.shopId]) {
          const sMarker = L.marker([sLat, sLng], { icon: shopIcon }).addTo(trackingMap);
          sMarker.bindPopup(`<strong>Target Shop:</strong> ${esc(targetChallan.shopName)}`);
          trackingShopMarkers[targetChallan.shopId] = sMarker;
        }

        await drawDriverRoute(d.id, lat, lng, sLat, sLng);
      } else if (trackingRouteLines[d.id]) {
        trackingMap.removeLayer(trackingRouteLines[d.id]);
        delete trackingRouteLines[d.id];
      }
    }

    if (!selectedTrackingDriver && allBounds.length > 0) {
      trackingMap.fitBounds(allBounds, { padding: [50, 50], maxZoom: 15 });
    }
  } catch (err) {
    console.warn("refreshTrackingMap error:", err);
  }
}

async function drawDriverRoute(driverId, lat1, lng1, lat2, lng2) {
  if (!trackingMap) return;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    const route = data?.routes?.[0];

    if (route) {
      const lineCoords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      if (trackingRouteLines[driverId]) {
        trackingRouteLines[driverId].setLatLngs(lineCoords);
      } else {
        trackingRouteLines[driverId] = L.polyline(lineCoords, {
          color: "#059669",
          weight: 4,
          opacity: 0.8
        }).addTo(trackingMap);
      }
      return;
    }
  } catch (e) {}

  const fallbackCoords = [[lat1, lng1], [lat2, lng2]];
  if (trackingRouteLines[driverId]) {
    trackingRouteLines[driverId].setLatLngs(fallbackCoords);
  } else {
    trackingRouteLines[driverId] = L.polyline(fallbackCoords, {
      color: "#94a3b8",
      weight: 3,
      dashArray: "6, 8"
    }).addTo(trackingMap);
  }
}

function startArrivalDetection() {
  if (arrivalCheckInterval) clearInterval(arrivalCheckInterval);

  arrivalCheckInterval = setInterval(() => {
    const activeDrivers = drivers.filter((d) => isDriverOnline(d.id));

    activeDrivers.forEach((driver) => {
      const loc = driverLocations[driver.id];
      if (!loc || !loc.lat || !loc.lng) return;

      const targetChallan = getDriverTargetChallan(driver.id);
      if (!targetChallan || !targetChallan.shopLatitude || !targetChallan.shopLongitude) return;

      const dist = distanceMeters(
        Number(loc.lat),
        Number(loc.lng),
        Number(targetChallan.shopLatitude),
        Number(targetChallan.shopLongitude)
      );

      if (dist <= 100) {
        const alertKey = `${driver.id}-${targetChallan.id}`;
        if (!firedAlerts.has(alertKey)) {
          firedAlerts.add(alertKey);
          triggerArrivalAlert(driver.name || "Driver", targetChallan.shopName || "Shop");
        }
      }
    });
  }, 10000);
}

function triggerArrivalAlert(driverName, shopName) {
  beep();

  const container = document.getElementById("arrivalAlertContainer");
  if (!container) return;

  const alertEl = document.createElement("div");
  alertEl.className = "arrival-alert";

  const timeStr = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  alertEl.innerHTML = `
    <div class="arrival-alert__icon">🚚</div>
    <div class="arrival-alert__body">
      <div class="arrival-alert__title">
        Driver ${esc(driverName)} reached ${esc(shopName)}!
      </div>
      <div class="arrival-alert__time">${timeStr} • Arrival within 100m</div>
    </div>
    <button type="button" class="arrival-alert__close" aria-label="Close alert">&times;</button>
  `;

  const closeBtn = alertEl.querySelector(".arrival-alert__close");
  closeBtn.addEventListener("click", () => {
    alertEl.remove();
  });

  container.appendChild(alertEl);

  setTimeout(() => {
    if (alertEl.parentNode) {
      alertEl.style.transition = "opacity 0.3s ease, transform 0.3s ease";
      alertEl.style.opacity = "0";
      alertEl.style.transform = "translateX(20px)";
      setTimeout(() => alertEl.remove(), 300);
    }
  }, 15000);
}

// ── GPS Picker for Shops ───────────────────────────────────────────

function setPickedLocation(lat, lng, pan = false) {
  pendingShopLat = Number(lat);
  pendingShopLng = Number(lng);

  if (shopMapPicker) {
    if (shopMapMarker) {
      shopMapMarker.setLatLng([pendingShopLat, pendingShopLng]);
    } else {
      shopMapMarker = L.marker([pendingShopLat, pendingShopLng]).addTo(shopMapPicker);
    }
    if (pan) {
      shopMapPicker.setView([pendingShopLat, pendingShopLng], 15);
    }
  }

  const chosenEl = document.getElementById("shopMapChosen");
  if (chosenEl) {
    chosenEl.textContent = `Selected: ${pendingShopLat.toFixed(5)}, ${pendingShopLng.toFixed(5)}`;
  }
}

function openShopMapPicker() {
  openModal("shopMapModal");

  setTimeout(() => {
    if (!shopMapPicker) {
      shopMapPicker = L.map("shopMapPicker").setView([20.5937, 78.9629], 5);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap"
      }).addTo(shopMapPicker);

      shopMapPicker.on("click", (e) => {
        setPickedLocation(e.latlng.lat, e.latlng.lng);
      });
    }

    shopMapPicker.invalidateSize();

    const curLat = document.getElementById("shopLatitude").value;
    const curLng = document.getElementById("shopLongitude").value;

    if (curLat && curLng) {
      setPickedLocation(Number(curLat), Number(curLng), true);
    } else if (pendingShopLat != null && pendingShopLng != null) {
      setPickedLocation(pendingShopLat, pendingShopLng, true);
    } else {
      if (shopMapMarker) {
        shopMapPicker.removeLayer(shopMapMarker);
        shopMapMarker = null;
      }
      shopMapPicker.setView([20.5937, 78.9629], 5);
      document.getElementById("shopMapChosen").textContent = "Click on the map to place the marker";
    }
  }, 200);
}

async function searchLocation(queryStr) {
  if (!queryStr) return;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(queryStr)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data && data.length > 0) {
      const { lat, lon } = data[0];
      setPickedLocation(parseFloat(lat), parseFloat(lon), true);
      showToast("Location found on map", "success");
    } else {
      showToast("No location found for this query", "warning");
    }
  } catch (err) {
    console.warn("Geocoding failed:", err);
    showToast("Search failed", "error");
  }
}

function useMyLocation() {
  if (!navigator.geolocation) {
    showToast("Geolocation is not supported by your browser", "error");
    return;
  }
  showToast("Fetching GPS position…", "info");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      pendingShopLat = lat;
      pendingShopLng = lng;
      document.getElementById("shopLatitude").value  = lat;
      document.getElementById("shopLongitude").value = lng;
      document.getElementById("shopLocationPreview").textContent =
        `Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`;
      if (shopMapPicker) {
        setPickedLocation(lat, lng, true);
      }
      showToast("Location set from GPS", "success");
    },
    (err) => {
      console.warn("Geo error:", err);
      showToast("Could not get location: " + err.message, "warning");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function setupShopMapPickerHandlers() {
  document.getElementById("openShopMapBtn")
    ?.addEventListener("click", () => openShopMapPicker());

  document.getElementById("useMyLocationBtn")
    ?.addEventListener("click", () => useMyLocation());

  document.getElementById("confirmShopLocationBtn")
    ?.addEventListener("click", () => {
      if (pendingShopLat != null && pendingShopLng != null) {
        document.getElementById("shopLatitude").value  = pendingShopLat;
        document.getElementById("shopLongitude").value = pendingShopLng;
        document.getElementById("shopLocationPreview").textContent =
          `Lat: ${pendingShopLat.toFixed(5)}, Lng: ${pendingShopLng.toFixed(5)}`;
        showToast("Location confirmed", "success");
      }
      closeModal("shopMapModal");
    });

  const searchInput = document.getElementById("shopMapSearch");
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchLocation(searchInput.value.trim());
    }
  });
}

// ── Shop Modal ─────────────────────────────────────────────────────

function openShopModal(shop = null) {
  document.getElementById("shopModalTitle").textContent = shop ? "Edit Shop" : "Add Shop";
  document.getElementById("shopId").value      = shop?.id          || "";
  document.getElementById("shopName").value    = shop?.name        || "";
  document.getElementById("shopOwner").value   = shop?.owner_name  || "";
  document.getElementById("shopPhone").value   = shop?.phone       || "";
  document.getElementById("shopAddress").value = shop?.address     || "";
  document.getElementById("shopType").value    = shop?.shop_type   || "Retailer";
  document.getElementById("shopPending").value = shop?.pending_fees ?? 0;

  const lat = shop?.latitude != null ? Number(shop.latitude) : null;
  const lng = shop?.longitude != null ? Number(shop.longitude) : null;
  document.getElementById("shopLatitude").value  = lat != null ? lat : "";
  document.getElementById("shopLongitude").value = lng != null ? lng : "";

  if (lat != null && lng != null) {
    pendingShopLat = lat;
    pendingShopLng = lng;
    document.getElementById("shopLocationPreview").textContent =
      `Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`;
  } else {
    pendingShopLat = null;
    pendingShopLng = null;
    document.getElementById("shopLocationPreview").textContent = "No location selected";
  }

  openModal("shopModal");
}

function setupShopForm() {
  document.getElementById("shopForm")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      const id = document.getElementById("shopId").value;

      const latVal = document.getElementById("shopLatitude").value;
      const lngVal = document.getElementById("shopLongitude").value;

      const data = {
        name:         document.getElementById("shopName").value.trim(),
        owner_name:   document.getElementById("shopOwner").value.trim(),
        phone:        document.getElementById("shopPhone").value.trim(),
        address:      document.getElementById("shopAddress").value.trim(),
        shop_type:    document.getElementById("shopType").value,
        pending_fees: Number(document.getElementById("shopPending").value) || 0,
        latitude:     latVal ? Number(latVal) : null,
        longitude:    lngVal ? Number(lngVal) : null,
        updatedAt:    serverTimestamp()
      };
      try {
        if (id) {
          await updateDoc(doc(db, "shops", id), data);
          lastRecentShopId = id;
          shouldFocusRecentShop = true;
          showToast("Shop updated", "success");
        } else {
          data.createdAt = serverTimestamp();
          const docRef = await addDoc(collection(db, "shops"), data);
          lastRecentShopId = docRef.id;
          shouldFocusRecentShop = true;
          showToast("Shop added", "success");
        }
        closeModal("shopModal");
      } catch (err) {
        console.error(err);
        showToast("Could not save shop", "error");
      } finally {
        btn.disabled = false;
      }
    });
}

function editShop(id) {
  const shop = shops.find((s) => s.id === id);
  if (shop) openShopModal(shop);
}

async function deleteShop(id) {
  const shop = shops.find((s) => s.id === id);
  if (!shop) return;
  if (!confirm(`Delete shop "${shop.name}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "shops", id));
    showToast("Shop deleted", "success");
  } catch (err) {
    console.error(err);
    showToast("Could not delete shop", "error");
  }
}

// ── Product Modal ──────────────────────────────────────────────────

function openProductModal(product = null) {
  document.getElementById("productModalTitle").textContent = product ? "Edit Product" : "Add Product";
  document.getElementById("productId").value       = product?.id            || "";
  document.getElementById("productName").value     = product?.name          || "";
  document.getElementById("productCategory").value = product?.category      || "Pipes & Fittings";
  document.getElementById("productUnit").value     = product?.unit          || "piece";
  document.getElementById("productCost").value     = product?.cost_price    ?? "";
  document.getElementById("productPrice").value    = product?.selling_price ?? "";
  document.getElementById("productStock").value    = product?.stock         ?? 0;
  openModal("productModal");
}

function setupProductForm() {
  document.getElementById("productForm")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      const id = document.getElementById("productId").value;
      const data = {
        name:          document.getElementById("productName").value.trim(),
        category:      document.getElementById("productCategory").value,
        unit:          document.getElementById("productUnit").value,
        cost_price:    Number(document.getElementById("productCost").value)  || 0,
        selling_price: Number(document.getElementById("productPrice").value) || 0,
        stock:         Number(document.getElementById("productStock").value) || 0,
        updatedAt:     serverTimestamp()
      };
      try {
        if (id) {
          await updateDoc(doc(db, "products", id), data);
          showToast("Product updated", "success");
        } else {
          data.createdAt = serverTimestamp();
          await addDoc(collection(db, "products"), data);
          showToast("Product added", "success");
        }
        closeModal("productModal");
      } catch (err) {
        console.error(err);
        showToast("Could not save product", "error");
      } finally {
        btn.disabled = false;
      }
    });
}

function editProduct(id) {
  const product = products.find((p) => p.id === id);
  if (product) openProductModal(product);
}

async function deleteProduct(id) {
  const product = products.find((p) => p.id === id);
  if (!product) return;
  if (!confirm(`Delete product "${product.name}"?`)) return;
  try {
    await deleteDoc(doc(db, "products", id));
    showToast("Product deleted", "success");
  } catch (err) {
    console.error(err);
    showToast("Could not delete product", "error");
  }
}

// ── Modal Trigger Wiring ───────────────────────────────────────────

function setupModals() {
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const modal = e.target.closest(".modal");
      if (modal) closeModal(modal.id);
    });
  });

  document.getElementById("addShopBtn")?.addEventListener("click", () => openShopModal());
  document.getElementById("addProductBtn")?.addEventListener("click", () => openProductModal());
  document.getElementById("addDriverBtn")?.addEventListener("click", () => openModal("driverModal"));
  document.getElementById("addChallanBtn")?.addEventListener("click", () => openChallanModal());
  document.getElementById("addSaleBtn")?.addEventListener("click", () => openSaleModal());
  document.getElementById("addPaymentBtn")?.addEventListener("click", () => openPaymentModal());

  document.getElementById("printChallanBtn")?.addEventListener("click", () => printChallan());
  document.getElementById("downloadChallanPdfBtn")?.addEventListener("click", () => downloadChallanPDF());

  document.getElementById("printInvoiceBtn")?.addEventListener("click", () => printInvoice());
  document.getElementById("downloadInvoicePdfBtn")?.addEventListener("click", () => downloadInvoicePDF());
}

// ── Logout ─────────────────────────────────────────────────────────

function setupLogout() {
  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    showToast("Signed out", "info");
    setTimeout(() => logout(), 200);
  });
}

// ── Escaping Helper ────────────────────────────────────────────────

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}
