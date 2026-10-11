/**
 * Displays an animated toast notification.
 * @param {string} message - Text message to display
 * @param {'info' | 'success' | 'error' | 'warning'} [type='info'] - Notification style
 * @param {number} [durationMs=3000] - Duration in milliseconds before dismissing
 */
export function showToast(message, type = "info", durationMs = 3000) {
  let root = document.querySelector(".toast-root");
  if (!root) {
    root = document.createElement("div");
    root.className = "toast-root";
    document.body.appendChild(root);
  }

  const icons = {
    success: "✓",
    error: "✕",
    warning: "!",
    info: "i"
  };

  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;

  const iconSpan = document.createElement("span");
  iconSpan.className = "toast__icon";
  iconSpan.textContent = icons[type] || icons.info;

  const msgSpan = document.createElement("span");
  msgSpan.className = "toast__message";
  msgSpan.textContent = message;

  toast.appendChild(iconSpan);
  toast.appendChild(msgSpan);
  root.appendChild(toast);

  // Trigger CSS entry animation via requestAnimationFrame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add("is-visible");
    });
  });

  // Automatically dismiss and remove after duration
  setTimeout(() => {
    toast.classList.remove("is-visible");
    toast.addEventListener(
      "transitionend",
      () => {
        toast.remove();
        if (root.children.length === 0) {
          root.remove();
        }
      },
      { once: true }
    );
  }, durationMs);
}

/**
 * Opens a modal dialog by element or id and disables background scrolling.
 * @param {string | HTMLElement} id - Element ID or HTMLElement instance
 */
export function openModal(id) {
  const modal = typeof id === "string" ? document.getElementById(id) : id;
  if (modal) {
    modal.classList.add("is-open");
    document.body.style.overflow = "hidden";
  }
}

/**
 * Closes a modal dialog by element or id and restores body scrolling if no modals are open.
 * @param {string | HTMLElement} id - Element ID or HTMLElement instance
 */
export function closeModal(id) {
  const modal = typeof id === "string" ? document.getElementById(id) : id;
  if (modal) {
    modal.classList.remove("is-open");
    if (!document.querySelector(".modal.is-open")) {
      document.body.style.overflow = "";
    }
  }
}

// Global modal event listeners
document.addEventListener("click", (e) => {
  if (e.target.matches(".modal-backdrop") || e.target.closest(".modal-backdrop")) {
    const modal = e.target.closest(".modal");
    if (modal) {
      closeModal(modal);
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const openModals = document.querySelectorAll(".modal.is-open");
    openModals.forEach((modal) => closeModal(modal));
  }
});
