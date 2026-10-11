import { auth, db } from "./firebase-config.js";
import { requireRole, logout } from "./auth.js";
import { showToast, openModal, closeModal } from "./ui.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── Local state cache ──────────────────────────────────────────────
let currentUser = null;
let currentProfile = null;
let shops = [];
let products = [];
let challans = [];
let drivers = [];
let unsubShops = null;
let unsubProducts = null;
let unsubChallans = null;

// Tracks which challan is open in the view modal (for print/PDF)
let currentViewChallan = null;

// ── Init ───────────────────────────────────────────────────────────

/**
 * Initializes the distributor dashboard after role validation.
 */
async function init() {
  try {
    const { user, profile } = await requireRole("distributor");
    currentUser = user;
    currentProfile = profile;

    const userInfoEl = document.getElementById("userInfo");
    if (userInfoEl) {
      userInfoEl.textContent = `Hi ${profile.name || "Distributor"} 👋`;
    }

    setupNav();
    setupModals();
    setupShopForm();
    setupProductForm();
    setupChallanForm();
    setupLogout();

    loadDashboardKPIs();
    subscribeShops();
    subscribeProducts();
    subscribeChallans();
    loadDrivers();
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
 * Wires sidebar nav tab switching for all active nav items.
 */
function setupNav() {
  const navItems = document.querySelectorAll(".sidebar__nav .nav-item");
  const sections = document.querySelectorAll(".content-section");
  const titleEl = document.getElementById("pageTitle");

  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      if (item.disabled) return;
      const target = item.dataset.target;
      if (!target) return;

      navItems.forEach((n) => n.classList.remove("is-active"));
      item.classList.add("is-active");

      sections.forEach((s) => s.classList.remove("is-active"));
      const active = document.getElementById(`section-${target}`);
      if (active) active.classList.add("is-active");

      if (titleEl) {
        titleEl.textContent = item.textContent.trim().split(/\s+/)[0];
      }
    });
  });
}

// ── Dashboard KPIs ─────────────────────────────────────────────────

/**
 * Fetches one-time KPI data from Firestore and populates dashboard cards.
 * Also called from subscribeChallans to keep Active Deliveries up to date.
 */
async function loadDashboardKPIs() {
  try {
    const [shopsSnap, challansSnap, salesSnap, productsSnap] =
      await Promise.all([
        getDocs(collection(db, "shops")),
        getDocs(collection(db, "delivery_challans")),
        getDocs(collection(db, "sales")),
        getDocs(collection(db, "products"))
      ]);

    const kpiShopsEl = document.getElementById("kpiShops");
    if (kpiShopsEl) kpiShopsEl.textContent = shopsSnap.size.toString();

    let totalPending = 0;
    shopsSnap.forEach((d) => {
      totalPending += Number(d.data().pending_fees) || 0;
    });
    const kpiPendingEl = document.getElementById("kpiPending");
    if (kpiPendingEl) {
      kpiPendingEl.textContent = "₹" + totalPending.toLocaleString("en-IN");
    }

    let activeDeliveries = 0;
    challansSnap.forEach((d) => {
      const s = d.data().status;
      if (s === "assigned" || s === "out_for_delivery") activeDeliveries++;
    });
    const kpiActiveEl = document.getElementById("kpiActive");
    if (kpiActiveEl) kpiActiveEl.textContent = activeDeliveries.toString();

    const todayStr = new Date().toISOString().slice(0, 10);
    let todaySales = 0;
    salesSnap.forEach((d) => {
      const data = d.data();
      const dStr =
        data.dateStr ||
        (data.timestamp?.toDate?.().toISOString?.().slice(0, 10));
      if (dStr === todayStr) todaySales += Number(data.total) || 0;
    });
    const kpiSalesEl = document.getElementById("kpiSales");
    if (kpiSalesEl) {
      kpiSalesEl.textContent = "₹" + todaySales.toLocaleString("en-IN");
    }

    let lowStock = 0;
    productsSnap.forEach((d) => {
      if ((Number(d.data().stock) || 0) < 10) lowStock++;
    });
    const kpiLowStockEl = document.getElementById("kpiLowStock");
    if (kpiLowStockEl) kpiLowStockEl.textContent = lowStock.toString();
  } catch (err) {
    console.error("Dashboard load failed:", err);
  }
}

// ── Shops ──────────────────────────────────────────────────────────

/**
 * Opens a real-time listener on the shops collection ordered by name.
 */
function subscribeShops() {
  if (unsubShops) unsubShops();
  const q = query(collection(db, "shops"), orderBy("name", "asc"));
  unsubShops = onSnapshot(
    q,
    (snap) => {
      shops = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderShopsTable();
      updateShopsKPIs();
    },
    (err) => {
      console.error("Shops listener error:", err);
    }
  );
}

/**
 * Re-computes shops KPI cards from local cache.
 */
function updateShopsKPIs() {
  const countEl = document.getElementById("kpiShops");
  const pendingEl = document.getElementById("kpiPending");
  if (countEl) countEl.textContent = shops.length.toString();
  if (pendingEl) {
    const sum = shops.reduce(
      (a, s) => a + (Number(s.pending_fees) || 0),
      0
    );
    pendingEl.textContent = "₹" + sum.toLocaleString("en-IN");
  }
}

/**
 * Renders the shops table; shows empty state when no rows exist.
 */
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

  tbody.innerHTML = shops
    .map((s) => {
      const typeClass =
        { Retailer: "badge--retailer", Wholesaler: "badge--wholesaler", Both: "badge--both" }[s.shop_type] ||
        "badge--retailer";
      const pending = Number(s.pending_fees) || 0;
      return `
        <tr>
          <td><strong>${esc(s.name)}</strong></td>
          <td class="muted">${esc(s.owner_name) || "—"}</td>
          <td class="muted">${esc(s.phone) || "—"}</td>
          <td class="muted">${esc(s.address) || "—"}</td>
          <td><span class="badge ${typeClass}">${esc(s.shop_type) || "Retailer"}</span></td>
          <td class="money">
            ${pending > 0
              ? '<span class="badge badge--danger">₹' + pending.toLocaleString("en-IN") + "</span>"
              : "₹0"}
          </td>
          <td class="actions">
            <button class="row-btn row-btn--edit" data-action="edit-shop" data-id="${s.id}">Edit</button>
            <button class="row-btn row-btn--del"  data-action="del-shop"  data-id="${s.id}">Delete</button>
          </td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "edit-shop") editShop(btn.dataset.id);
      if (btn.dataset.action === "del-shop")  deleteShop(btn.dataset.id);
    });
  });
}

// ── Products ───────────────────────────────────────────────────────

/**
 * Opens a real-time listener on the products collection ordered by name.
 */
function subscribeProducts() {
  if (unsubProducts) unsubProducts();
  const q = query(collection(db, "products"), orderBy("name", "asc"));
  unsubProducts = onSnapshot(
    q,
    (snap) => {
      products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderProductsTable();
      updateLowStockKPI();
    },
    (err) => {
      console.error("Products listener error:", err);
    }
  );
}

/**
 * Updates the Low Stock KPI from the local products cache.
 */
function updateLowStockKPI() {
  const el = document.getElementById("kpiLowStock");
  if (!el) return;
  const low = products.filter((p) => (Number(p.stock) || 0) < 10).length;
  el.textContent = low.toString();
}

/**
 * Renders the products table with margin badges and row actions.
 */
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

  tbody.innerHTML = products
    .map((p) => {
      const cost   = Number(p.cost_price) || 0;
      const sell   = Number(p.selling_price) || 0;
      const stock  = Number(p.stock) || 0;
      const margin = cost > 0 ? Math.round(((sell - cost) / cost) * 100) : 0;
      const marginClass = margin >= 0 ? "badge--success" : "badge--danger";
      const stockClass  = stock < 10  ? "badge--danger"  : "badge--success";
      return `
        <tr>
          <td><strong>${esc(p.name)}</strong></td>
          <td class="muted">${esc(p.category) || "—"}</td>
          <td class="muted">${esc(p.unit) || "pc"}</td>
          <td class="money">₹${cost.toLocaleString("en-IN")}</td>
          <td class="money">₹${sell.toLocaleString("en-IN")}</td>
          <td><span class="badge ${marginClass}">${margin}%</span></td>
          <td><span class="badge ${stockClass}">${stock}</span></td>
          <td class="actions">
            <button class="row-btn row-btn--edit" data-action="edit-product" data-id="${p.id}">Edit</button>
            <button class="row-btn row-btn--del"  data-action="del-product"  data-id="${p.id}">Delete</button>
          </td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "edit-product") editProduct(btn.dataset.id);
      if (btn.dataset.action === "del-product")  deleteProduct(btn.dataset.id);
    });
  });
}

// ── Challans ───────────────────────────────────────────────────────

/**
 * Opens a real-time listener on delivery_challans ordered by createdAt desc.
 * Also refreshes Active Deliveries KPI on every snapshot.
 */
function subscribeChallans() {
  if (unsubChallans) unsubChallans();
  const q = query(
    collection(db, "delivery_challans"),
    orderBy("createdAt", "desc")
  );
  unsubChallans = onSnapshot(
    q,
    (snap) => {
      challans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderChallansTable();
      updateActiveDeliveriesKPI();
    },
    (err) => {
      console.error("Challans listener error:", err);
    }
  );
}

/**
 * Recomputes the Active Deliveries KPI from the local challans cache.
 */
function updateActiveDeliveriesKPI() {
  const el = document.getElementById("kpiActive");
  if (!el) return;
  const active = challans.filter(
    (c) => c.status === "assigned" || c.status === "out_for_delivery"
  ).length;
  el.textContent = active.toString();
}

/**
 * Maps a challan status string to a CSS badge class.
 * @param {string} status
 * @returns {string}
 */
function statusBadgeClass(status) {
  return (
    {
      pending:          "badge--pending",
      assigned:         "badge--assigned",
      out_for_delivery: "badge--transit",
      delivered:        "badge--delivered",
      converted:        "badge--converted"
    }[status] || "badge--pending"
  );
}

/**
 * Maps a status value to a human-readable label.
 * @param {string} status
 * @returns {string}
 */
function statusLabel(status) {
  return (
    {
      pending:          "Pending",
      assigned:         "Assigned",
      out_for_delivery: "In Transit",
      delivered:        "Delivered",
      converted:        "Converted"
    }[status] || status
  );
}

/**
 * Renders the challans table with all columns and row action buttons.
 */
function renderChallansTable() {
  const tbody = document.getElementById("challansTableBody");
  if (!tbody) return;

  if (challans.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty-state">
          <div class="empty-state__icon">📋</div>
          <div class="empty-state__title">No challans yet</div>
          <div class="empty-state__text">Click "New Challan" to create one.</div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = challans
    .map((c) => {
      const total = Number(c.total) || 0;
      const badge = statusBadgeClass(c.status);
      const label = statusLabel(c.status);
      return `
        <tr>
          <td><strong>${esc(c.challanNumber)}</strong></td>
          <td>${esc(c.shopName)}</td>
          <td>${esc(c.productName)}</td>
          <td>${Number(c.quantity) || 0}</td>
          <td class="money">₹${total.toLocaleString("en-IN")}</td>
          <td>
            ${esc(c.driverName)}<br>
            <small class="muted">${esc(c.vehicleNumber) || ""}</small>
          </td>
          <td><span class="otp-code">${esc(c.otp)}</span></td>
          <td><span class="badge ${badge}">${label}</span></td>
          <td class="actions">
            <button class="row-btn row-btn--view" data-action="view-challan" data-id="${c.id}">View</button>
            <button class="row-btn row-btn--del"  data-action="del-challan"  data-id="${c.id}">Delete</button>
          </td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "view-challan") viewChallan(btn.dataset.id);
      if (btn.dataset.action === "del-challan")  deleteChallan(btn.dataset.id);
    });
  });
}

/**
 * Fetches drivers from Firestore once (users where role=driver and active=true)
 * and populates the driver dropdown in the challan modal.
 */
async function loadDrivers() {
  try {
    const q = query(
      collection(db, "users"),
      where("role", "==", "driver"),
      where("active", "==", true)
    );
    const snap = await getDocs(q);
    drivers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("loadDrivers failed:", err);
    drivers = [];
  }
}

/**
 * Resets and opens the Create Challan modal, populating all dropdowns
 * from the local shops, products, and drivers caches.
 */
function openChallanModal() {
  // Reset form
  document.getElementById("challanForm").reset();
  document.getElementById("challanTotalPreview").style.display = "none";
  document.getElementById("challanTotalValue").textContent = "0";

  // Populate shop dropdown
  const shopSel = document.getElementById("challanShop");
  shopSel.innerHTML = '<option value="">— Select shop —</option>';
  shops.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    shopSel.appendChild(opt);
  });

  // Populate product dropdown with price stored as data attribute
  const prodSel = document.getElementById("challanProduct");
  prodSel.innerHTML = '<option value="">— Select product —</option>';
  products.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} — ₹${Number(p.selling_price || 0).toLocaleString("en-IN")}/${p.unit || "pc"}`;
    opt.dataset.price = p.selling_price || 0;
    prodSel.appendChild(opt);
  });

  // Populate driver dropdown
  const driverSel = document.getElementById("challanDriver");
  driverSel.innerHTML = '<option value="">— Select driver —</option>';
  drivers.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.name} (${d.vehicleNumber || "—"})`;
    driverSel.appendChild(opt);
  });

  openModal("challanModal");
}

/**
 * Sets up the challan form: live total preview and submit handler.
 */
function setupChallanForm() {
  const prodSel = document.getElementById("challanProduct");
  const qtyInput = document.getElementById("challanQty");
  const totalPreview = document.getElementById("challanTotalPreview");
  const totalValueEl = document.getElementById("challanTotalValue");

  // Live total calculation when product or quantity changes
  function updateTotalPreview() {
    const selectedOpt = prodSel.options[prodSel.selectedIndex];
    const price = parseFloat(selectedOpt?.dataset?.price || 0);
    const qty = parseInt(qtyInput.value, 10) || 0;
    if (price > 0 && qty > 0) {
      const total = price * qty;
      totalValueEl.textContent = total.toLocaleString("en-IN");
      totalPreview.style.display = "";
    } else {
      totalPreview.style.display = "none";
    }
  }

  prodSel?.addEventListener("change", updateTotalPreview);
  qtyInput?.addEventListener("input", updateTotalPreview);

  // Submit handler
  document
    .getElementById("challanForm")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;

      try {
        // Read selections
        const shopId    = document.getElementById("challanShop").value;
        const productId = document.getElementById("challanProduct").value;
        const qty       = parseInt(document.getElementById("challanQty").value, 10);
        const driverId  = document.getElementById("challanDriver").value;

        if (!shopId || !productId || !driverId || qty < 1) {
          showToast("Please fill all required fields.", "warning");
          return;
        }

        // Resolve from local caches
        const shop    = shops.find((s) => s.id === shopId);
        const product = products.find((p) => p.id === productId);
        const driver  = drivers.find((d) => d.id === driverId);

        if (!shop || !product || !driver) {
          showToast("Selection error — please refresh and try again.", "error");
          return;
        }

        const unitPrice = Number(product.selling_price) || 0;
        const total     = unitPrice * qty;

        // Generate sequential challan number
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const seqQuery = query(
          collection(db, "delivery_challans"),
          where("dateStr", "==", todayStr),
          limit(100)
        );
        const seqSnap = await getDocs(seqQuery);
        const seqNum = seqSnap.size + 1;
        const challanNumber = `DC-${todayStr}-${String(seqNum).padStart(3, "0")}`;

        // Generate 4-digit OTP
        const otp = String(Math.floor(1000 + Math.random() * 9000));

        const challanData = {
          challanNumber,
          dateStr: todayStr,
          shopId,
          shopName:        shop.name,
          productId,
          productName:     product.name,
          quantity:        qty,
          unitPrice,
          total,
          driverId,
          driverName:      driver.name,
          vehicleNumber:   driver.vehicleNumber || "",
          status:          "assigned",
          otp,
          pod:             null,
          assignedAt:      serverTimestamp(),
          deliveredAt:     null,
          createdAt:       serverTimestamp(),
          saleId:          null,
          saleInvoiceNumber: null
        };

        await addDoc(collection(db, "delivery_challans"), challanData);
        closeModal("challanModal");
        showToast(`Challan ${challanNumber} created. OTP: ${otp}`, "success", 6000);
        // Real-time listener will update the table automatically
      } catch (err) {
        console.error("Create challan failed:", err);
        showToast("Could not create challan", "error");
      } finally {
        btn.disabled = false;
      }
    });
}

/**
 * Opens the challan view modal for the given challan ID and renders
 * a styled document with all details and OTP box.
 * @param {string} id
 */
function viewChallan(id) {
  const c = challans.find((ch) => ch.id === id);
  if (!c) return;
  currentViewChallan = c;

  const date = c.assignedAt?.toDate
    ? c.assignedAt.toDate().toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric"
      })
    : "—";

  const total = Number(c.total) || 0;
  const badge = statusBadgeClass(c.status);
  const label = statusLabel(c.status);

  document.getElementById("challanViewBody").innerHTML = `
    <div class="challan-doc">
      <div class="challan-doc__header">
        <div>
          <div class="challan-doc__brand">DistroMS</div>
          <div class="challan-doc__tagline">Distribution &amp; Delivery Tracking</div>
        </div>
        <div class="challan-doc__number">
          <div class="challan-doc__number-label">Delivery Challan</div>
          <div class="challan-doc__number-value">${esc(c.challanNumber)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${date}</div>
        </div>
      </div>

      <div class="challan-doc__grid">
        <div class="challan-doc__section">
          <div class="challan-doc__section-title">Deliver To</div>
          <div class="challan-doc__value">
            <strong>${esc(c.shopName)}</strong>
          </div>
        </div>
        <div class="challan-doc__section">
          <div class="challan-doc__section-title">Assigned Driver</div>
          <div class="challan-doc__value">
            <strong>${esc(c.driverName)}</strong><br>
            <span style="color:var(--text-muted);font-size:12px;">${esc(c.vehicleNumber) || "—"}</span>
          </div>
        </div>
      </div>

      <div class="challan-doc__grid">
        <div class="challan-doc__section">
          <div class="challan-doc__section-title">Status</div>
          <div class="challan-doc__value">
            <span class="badge ${badge}">${label}</span>
          </div>
        </div>
      </div>

      <div class="challan-doc__otp-box">
        <div class="challan-doc__otp-label">Shop OTP</div>
        <div class="challan-doc__otp-value">${esc(c.otp)}</div>
        <div class="challan-doc__otp-hint">
          Share this OTP with the shopkeeper — they will give it to the driver on delivery.
        </div>
      </div>

      <table class="challan-doc__table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Qty</th>
            <th>Unit Price</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${esc(c.productName)}</td>
            <td>${Number(c.quantity) || 0}</td>
            <td>₹${Number(c.unitPrice || 0).toLocaleString("en-IN")}</td>
            <td>₹${total.toLocaleString("en-IN")}</td>
          </tr>
        </tbody>
      </table>

      <div class="challan-doc__total-row">
        <span class="challan-doc__total-label">Total Amount</span>
        <span class="challan-doc__total-value">₹${total.toLocaleString("en-IN")}</span>
      </div>

      <div class="challan-doc__footer">
        This is a system generated delivery challan. — DistroMS v2
      </div>
    </div>`;

  openModal("challanViewModal");
}

/**
 * Triggers the browser print dialog while the challan view modal is open.
 * CSS @media print rules hide everything else.
 */
function printChallan() {
  if (!currentViewChallan) return;
  window.print();
}

/**
 * Captures the challan document using html2canvas and saves it as a PDF
 * using jsPDF. Both libraries are loaded via CDN as global scripts.
 */
async function downloadChallanPDF() {
  if (!currentViewChallan) return;

  const element = document.querySelector("#challanViewBody .challan-doc");
  if (!element) {
    showToast("Nothing to export", "warning");
    return;
  }

  showToast("Generating PDF…", "info");

  try {
    // html2canvas and jspdf are loaded as global scripts in the HTML head
    const canvas = await window.html2canvas(element, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff"
    });
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const pageW = 210;
    const imgW = pageW - 20;
    const imgH = (canvas.height * imgW) / canvas.width;
    pdf.addImage(imgData, "PNG", 10, 10, imgW, imgH);
    pdf.save(`${currentViewChallan.challanNumber}.pdf`);
    showToast("PDF downloaded", "success");
  } catch (err) {
    console.error("PDF generation failed:", err);
    showToast("PDF generation failed", "error");
  }
}

/**
 * Confirms and deletes a challan document from Firestore.
 * @param {string} id
 */
async function deleteChallan(id) {
  const challan = challans.find((c) => c.id === id);
  if (!challan) return;
  if (
    !confirm(
      `Delete challan "${challan.challanNumber}"? This cannot be undone.`
    )
  )
    return;
  try {
    await deleteDoc(doc(db, "delivery_challans", id));
    showToast("Challan deleted", "success");
  } catch (err) {
    console.error(err);
    showToast("Could not delete challan", "error");
  }
}

// ── Modals Setup ───────────────────────────────────────────────────

/**
 * Wires all [data-close] buttons, and open-modal trigger buttons
 * (shops, products, challans, print, PDF).
 */
function setupModals() {
  // Close any modal by [data-close]
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const modal = e.target.closest(".modal");
      if (modal) closeModal(modal.id);
    });
  });

  // Open modal triggers
  document.getElementById("addShopBtn")
    ?.addEventListener("click", () => openShopModal());
  document.getElementById("addProductBtn")
    ?.addEventListener("click", () => openProductModal());
  document.getElementById("addChallanBtn")
    ?.addEventListener("click", () => openChallanModal());

  // Challan view modal action buttons
  document.getElementById("printChallanBtn")
    ?.addEventListener("click", () => printChallan());
  document.getElementById("downloadChallanPdfBtn")
    ?.addEventListener("click", () => downloadChallanPDF());
}

// ── Shop Modal ─────────────────────────────────────────────────────

/**
 * Opens the shop modal prefilled for editing or cleared for creation.
 * @param {object|null} shop
 */
function openShopModal(shop = null) {
  document.getElementById("shopModalTitle").textContent = shop ? "Edit Shop" : "Add Shop";
  document.getElementById("shopId").value        = shop?.id          || "";
  document.getElementById("shopName").value      = shop?.name        || "";
  document.getElementById("shopOwner").value     = shop?.owner_name  || "";
  document.getElementById("shopPhone").value     = shop?.phone       || "";
  document.getElementById("shopAddress").value   = shop?.address     || "";
  document.getElementById("shopType").value      = shop?.shop_type   || "Retailer";
  document.getElementById("shopPending").value   = shop?.pending_fees || 0;
  openModal("shopModal");
}

/**
 * Binds submit handler for shop create/update.
 */
function setupShopForm() {
  document.getElementById("shopForm")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;

      const id = document.getElementById("shopId").value;
      const data = {
        name:         document.getElementById("shopName").value.trim(),
        owner_name:   document.getElementById("shopOwner").value.trim(),
        phone:        document.getElementById("shopPhone").value.trim(),
        address:      document.getElementById("shopAddress").value.trim(),
        shop_type:    document.getElementById("shopType").value,
        pending_fees: Number(document.getElementById("shopPending").value) || 0,
        updatedAt:    serverTimestamp()
      };

      try {
        if (id) {
          await updateDoc(doc(db, "shops", id), data);
          showToast("Shop updated", "success");
        } else {
          data.createdAt  = serverTimestamp();
          data.latitude   = null;
          data.longitude  = null;
          await addDoc(collection(db, "shops"), data);
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

/**
 * Finds shop by id and opens edit modal.
 * @param {string} id
 */
function editShop(id) {
  const shop = shops.find((s) => s.id === id);
  if (shop) openShopModal(shop);
}

/**
 * Confirms and deletes a shop from Firestore.
 * @param {string} id
 */
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

/**
 * Opens the product modal prefilled for editing or cleared for creation.
 * @param {object|null} product
 */
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

/**
 * Binds submit handler for product create/update.
 */
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

/**
 * Finds product by id and opens edit modal.
 * @param {string} id
 */
function editProduct(id) {
  const product = products.find((p) => p.id === id);
  if (product) openProductModal(product);
}

/**
 * Confirms and deletes a product from Firestore.
 * @param {string} id
 */
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

// ── Logout ─────────────────────────────────────────────────────────

/**
 * Wires the sign-out button to logout() with a brief toast.
 */
function setupLogout() {
  document.getElementById("logoutBtn")
    ?.addEventListener("click", async () => {
      showToast("Signed out", "info");
      setTimeout(() => logout(), 200);
    });
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Escapes user-provided strings before insertion into innerHTML to prevent XSS.
 * @param {string|null} str
 * @returns {string}
 */
function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
