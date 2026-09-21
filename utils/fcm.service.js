const { cert, initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const path = require("path");
const fs = require("fs");

let firebaseApp = null;
let messaging = null;

try {
  const serviceAccountPath = path.join(__dirname, "..", "service-account.json");
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
    firebaseApp = initializeApp({
      credential: cert(serviceAccount),
    });
    messaging = getMessaging(firebaseApp);
    console.log("Firebase Admin initialized successfully.");
  } else {
    console.warn("service-account.json not found at:", serviceAccountPath);
  }
} catch (error) {
  console.error("Failed to initialize Firebase Admin:", error.message);
}

/**
 * Send push notification to a single device token.
 * @param {string} fcmToken 
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body
 * @param {object} [options.data]
 */
async function sendPushNotification(fcmToken, { title, body, data = {} }) {
  if (!messaging) {
    console.warn("Firebase messaging not initialized. Skipping push notification.");
    return null;
  }

  if (!fcmToken || typeof fcmToken !== "string" || fcmToken.trim() === "") {
    return null;
  }

  // Ensure all data values are strings for FCM payload
  const stringifiedData = {};
  for (const [key, value] of Object.entries(data)) {
    stringifiedData[key] = value !== null && value !== undefined ? String(value) : "";
  }

  const message = {
    token: fcmToken.trim(),
    notification: {
      title,
      body,
    },
    data: stringifiedData,
  };

  try {
    const response = await messaging.send(message);
    console.log("FCM notification sent successfully:", response);
    return response;
  } catch (error) {
    console.error("Error sending FCM notification to token:", fcmToken, error.message);
    return null;
  }
}

module.exports = {
  sendPushNotification,
};
