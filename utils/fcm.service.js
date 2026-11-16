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
  if (!stringifiedData.title) stringifiedData.title = String(title || "");
  if (!stringifiedData.body) stringifiedData.body = String(body || "");
  if (!stringifiedData.click_action) stringifiedData.click_action = "FLUTTER_NOTIFICATION_CLICK";

  const message = {
    token: fcmToken.trim(),
    notification: {
      title,
      body,
    },
    data: stringifiedData,
    android: {
      priority: "high",
      notification: {
        title,
        body,
        sound: "default",
        defaultSound: true,
        defaultVibrateTimings: true,
        priority: "high",
        clickAction: "FLUTTER_NOTIFICATION_CLICK",
      },
    },
    apns: {
      payload: {
        aps: {
          alert: {
            title,
            body,
          },
          sound: "default",
          badge: 1,
          contentAvailable: true,
        },
      },
      headers: {
        "apns-priority": "10",
      },
    },
  };

  try {
    const response = await messaging.send(message);
    console.log("[FCM] Single notification sent successfully:", response);
    return response;
  } catch (error) {
    console.error("[FCM] Error sending notification to token:", fcmToken, error.message);
    return null;
  }
}

/**
 * Send push notification to multiple device tokens (in batches of 500).
 * @param {string[]} fcmTokens 
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body
 * @param {object} [options.data]
 */
async function sendMulticastNotification(fcmTokens, { title, body, data = {} }) {
  if (!messaging) {
    console.warn("Firebase messaging not initialized. Skipping multicast push notification.");
    return null;
  }

  if (!Array.isArray(fcmTokens) || fcmTokens.length === 0) {
    return null;
  }

  // Filter unique valid non-empty tokens
  const validTokens = Array.from(
    new Set(
      fcmTokens
        .filter((t) => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim())
    )
  );

  if (validTokens.length === 0) {
    return null;
  }

  const stringifiedData = {};
  for (const [key, value] of Object.entries(data)) {
    stringifiedData[key] = value !== null && value !== undefined ? String(value) : "";
  }
  if (!stringifiedData.title) stringifiedData.title = String(title || "");
  if (!stringifiedData.body) stringifiedData.body = String(body || "");
  if (!stringifiedData.click_action) stringifiedData.click_action = "FLUTTER_NOTIFICATION_CLICK";

  const batchSize = 500;
  const results = [];

  for (let i = 0; i < validTokens.length; i += batchSize) {
    const batchTokens = validTokens.slice(i, i + batchSize);
    const message = {
      tokens: batchTokens,
      notification: {
        title,
        body,
      },
      data: stringifiedData,
      android: {
        priority: "high",
        notification: {
          title,
          body,
          sound: "default",
          defaultSound: true,
          defaultVibrateTimings: true,
          priority: "high",
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title,
              body,
            },
            sound: "default",
            badge: 1,
            contentAvailable: true,
          },
        },
        headers: {
          "apns-priority": "10",
        },
      },
    };

    try {
      let response;
      if (typeof messaging.sendEachForMulticast === "function") {
        response = await messaging.sendEachForMulticast(message);
      } else if (typeof messaging.sendMulticast === "function") {
        response = await messaging.sendMulticast(message);
      } else {
        const individual = await Promise.all(
          batchTokens.map((token) =>
            messaging.send({ ...message, token, tokens: undefined }).catch((err) => ({ error: err }))
          )
        );
        response = {
          successCount: individual.filter((r) => !r.error).length,
          failureCount: individual.filter((r) => r.error).length,
          responses: individual.map((r) => ({ success: !r.error, error: r.error })),
        };
      }

      console.log(
        `[FCM] Multicast sent to ${batchTokens.length} devices. Success: ${response?.successCount || 0}, Failure: ${response?.failureCount || 0}`
      );

      if (Array.isArray(response?.responses)) {
        response.responses.forEach((resp, idx) => {
          const tokenPreview = batchTokens[idx] ? batchTokens[idx].substring(0, 20) + "..." : "unknown";
          if (resp.success) {
            console.log(`[FCM] ✓ Delivered to token: ${tokenPreview} (messageId: ${resp.messageId})`);
          } else {
            console.error(`[FCM] ✗ Failed token: ${tokenPreview} | Code: ${resp.error?.code} | Message: ${resp.error?.message}`);
          }
        });
      }

      results.push(response);
    } catch (error) {
      console.error("[FCM] Error sending multicast notification:", error.message);
    }
  }

  return results;
}

/**
 * Fetch all active, non-deleted members' FCM tokens and send push notification.
 * @param {object} pool PostgreSQL pool
 * @param {object} payload
 * @param {string} payload.title
 * @param {string} payload.body
 * @param {object} [payload.data]
 * @param {number} [payload.excludeMemberId]
 */
async function sendPushToAllMembers(pool, { title, body, data = {}, excludeMemberId = null }) {
  try {
    let query = `
      SELECT DISTINCT "fcmToken"
      FROM members
      WHERE "fcmToken" IS NOT NULL
        AND TRIM("fcmToken") != ''
        AND COALESCE("isDeleted", false) = false
        AND COALESCE("isActive", true) = true
    `;
    const params = [];
    if (excludeMemberId) {
      params.push(excludeMemberId);
      query += ` AND id != $1`;
    }

    const result = await pool.query(query, params);
    const tokens = result.rows
      .map((row) => {
        const raw = row.fcmToken || row.fcmtoken || Object.values(row)[0];
        return raw ? String(raw).trim() : null;
      })
      .filter(Boolean);

    console.log(`[FCM] Found ${tokens.length} active member token(s) to notify.`);

    if (tokens.length === 0) {
      console.warn("[FCM] No active members with valid fcmToken found in database. Push notification skipped.");
      return null;
    }

    return await sendMulticastNotification(tokens, { title, body, data });
  } catch (error) {
    console.error("[FCM] Failed to send push notification to all members:", error.message);
    return null;
  }
}

module.exports = {
  sendPushNotification,
  sendMulticastNotification,
  sendPushToAllMembers,
};
