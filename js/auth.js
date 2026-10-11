import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// Role-to-page destination mapping
const ROUTES = {
  distributor: "distributor.html",
  driver: "driver.html",
  watcher: "watcher.html"
};

/**
 * Signs in a user using email and password, then validates Firestore profile and role.
 * @param {string} email - User email address
 * @param {string} password - User password
 * @returns {Promise<{ user: object, profile: object }>}
 */
export async function login(email, password) {
  const userCredential = await signInWithEmailAndPassword(auth, email, password);
  const user = userCredential.user;

  // Retrieve user document from Firestore
  const userDocRef = doc(db, "users", user.uid);
  const userDocSnap = await getDoc(userDocRef);

  if (!userDocSnap.exists()) {
    await signOut(auth);
    throw new Error("NO_PROFILE");
  }

  const profile = userDocSnap.data();

  if (!profile.active) {
    await signOut(auth);
    throw new Error("INACTIVE");
  }

  if (!ROUTES[profile.role]) {
    await signOut(auth);
    throw new Error("BAD_ROLE");
  }

  return { user, profile };
}

/**
 * Redirects the window location to the target page assigned to the role.
 * @param {string} role - 'distributor' | 'driver' | 'watcher'
 */
export function redirectToRole(role) {
  const destination = ROUTES[role];
  if (destination) {
    window.location.href = destination;
  }
}

/**
 * Signs out the current authenticated user and redirects back to index.html.
 * @returns {Promise<void>}
 */
export async function logout() {
  await signOut(auth);
  window.location.href = "index.html";
}

/**
 * Route guard that requires an active authenticated session matching the expected role.
 * @param {string} expectedRole - Required role for the current page
 * @returns {Promise<{ user: object, profile: object }>}
 */
export function requireRole(expectedRole) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let graceTimer = null;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        // Wait 400ms session restore grace period before treating as unauthenticated
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            unsubscribe();
            window.location.href = "index.html";
            reject(new Error("NOT_LOGGED_IN"));
          }, 400);
        }
        return;
      }

      // User session detected - clear grace timer
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }

      if (resolved) return;
      resolved = true;
      unsubscribe();

      try {
        const userDocRef = doc(db, "users", user.uid);
        const userDocSnap = await getDoc(userDocRef);

        if (!userDocSnap.exists()) {
          await signOut(auth);
          window.location.href = "index.html";
          reject(new Error("NO_PROFILE"));
          return;
        }

        const profile = userDocSnap.data();

        if (!profile.active) {
          await signOut(auth);
          window.location.href = "index.html";
          reject(new Error("INACTIVE"));
          return;
        }

        if (profile.role !== expectedRole) {
          // If valid role exists, route user to their respective landing page
          if (ROUTES[profile.role]) {
            redirectToRole(profile.role);
          } else {
            await signOut(auth);
            window.location.href = "index.html";
          }
          reject(new Error("ROLE_MISMATCH"));
          return;
        }

        resolve({ user, profile });
      } catch (err) {
        window.location.href = "index.html";
        reject(err);
      }
    });
  });
}
