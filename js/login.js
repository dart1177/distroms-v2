import { login, redirectToRole } from "./auth.js";
import { showToast } from "./ui.js";

const loginForm = document.getElementById("loginForm");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const loginError = document.getElementById("loginError");

// User-friendly error messages mapped from auth errors and profile check errors
const ERROR_MESSAGES = {
  "NO_PROFILE": "Account setup incomplete. Contact your admin.",
  "INACTIVE": "This account has been deactivated.",
  "BAD_ROLE": "This account has an invalid role.",
  "auth/invalid-credential": "Invalid email or password.",
  "auth/user-not-found": "No account with that email.",
  "auth/wrong-password": "Incorrect password.",
  "auth/invalid-email": "Please enter a valid email.",
  "auth/too-many-requests": "Too many attempts. Try later.",
  "auth/network-request-failed": "Network error."
};

if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Clear previous error state
    loginError.textContent = "";
    loginError.style.display = "none";

    // Set loading state
    const originalText = loginBtn.textContent;
    loginBtn.disabled = true;
    loginBtn.classList.add("is-loading");
    loginBtn.textContent = "Signing in...";

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    try {
      const { profile } = await login(email, password);
      showToast(`Welcome ${profile.name || ""} 👋`.trim(), "success");
      setTimeout(() => {
        redirectToRole(profile.role);
      }, 350);
    } catch (err) {
      const key = err.code || err.message;
      const message = ERROR_MESSAGES[key] || "Login failed. Please try again.";
      loginError.textContent = message;
      loginError.style.display = "block";
    } finally {
      loginBtn.disabled = false;
      loginBtn.classList.remove("is-loading");
      loginBtn.textContent = originalText;
    }
  });
}
