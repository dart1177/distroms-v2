import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyCgR_0dvuOXF2PHtPSVgMHVH3ni3lQGsy4",
  authDomain: "distroms-6fc6d.firebaseapp.com",
  projectId: "distroms-6fc6d",
  storageBucket: "distroms-6fc6d.firebasestorage.app",
  messagingSenderId: "112346461227",
  appId: "1:112346461227:web:e7e67b9554421e5e63266e"
};
// Do NOT add databaseURL — Realtime DB is not used.

// Initialize Firebase services
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

export { app, auth, db, storage };
