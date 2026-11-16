const assert = require("assert");
const { eventController } = require("../controller/event.controller");
const { notificationController } = require("../controller/notification.controller");
const {
  sendMulticastNotification,
  sendPushToAllMembers,
} = require("../utils/fcm.service");

(async () => {
  console.log("=== Running FCM Broadcast on Add Event & Notification Tests ===");

  let executedQueries = [];
  const mockMembers = [
    { id: 1, fcmToken: "token_user_1", isDeleted: false, isActive: true },
    { id: 2, fcmToken: "token_user_2", isDeleted: false, isActive: true },
    { id: 3, fcmToken: null, isDeleted: false, isActive: true },
    { id: 4, fcmToken: "token_deleted_user", isDeleted: true, isActive: false },
    { id: 5, fcmToken: "token_inactive_user", isDeleted: false, isActive: false },
  ];

  const mockPool = {
    async query(sql, params) {
      executedQueries.push({ sql, params });

      // Member token query for broadcast
      if (sql.includes('SELECT DISTINCT "fcmToken"') && sql.includes("FROM members")) {
        const activeTokens = mockMembers
          .filter((m) => !m.isDeleted && m.isActive && m.fcmToken)
          .map((m) => ({ fcmToken: m.fcmToken }));
        return {
          rowCount: activeTokens.length,
          rows: activeTokens,
        };
      }

      // Add Event query
      if (sql.includes("INSERT INTO events")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "88",
              name: params[0],
              event_date: params[1],
              createBy: params[8] || "1",
              isActive: true,
              isDeleted: false,
              deletedBy: null,
            },
          ],
        };
      }

      // Add Notification query
      if (sql.includes("INSERT INTO notifications")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "99",
              title: params[0],
              message: params[1],
              notify_type: params[4],
              createBy: params[7] || "1",
              is_active: true,
              isActive: true,
              isDeleted: false,
              deletedBy: null,
            },
          ],
        };
      }

      return { rowCount: 1, rows: [] };
    },
  };

  // Test 1: addEvent triggers member token query
  {
    executedQueries = [];
    const eventCtrl = eventController(mockPool);
    const req = {
      body: { name: "Blood Donation Camp", event_date: "15-12-2026" },
      member: { id: 1, role: "ADMIN" },
      files: [],
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json(d) { responseData = d; return this; },
    };

    await eventCtrl.addEvent(req, res);

    assert.strictEqual(statusCode, 201);
    assert.strictEqual(responseData.data.id, "88");

    const fcmQuery = executedQueries.find((q) =>
      q.sql.includes('SELECT DISTINCT "fcmToken"') && q.sql.includes("FROM members")
    );
    assert.ok(fcmQuery, "addEvent must query active member FCM tokens for broadcast");
    console.log("✔ addEvent triggers FCM broadcast to active members");
  }

  // Test 2: addNotification triggers member token query
  {
    executedQueries = [];
    const notifCtrl = notificationController(mockPool);
    const req = {
      body: { title: "Urgent Meeting", message: "All members please attend.", notify_type: "ALERT" },
      member: { id: 1, role: "ADMIN" },
      files: [],
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json(d) { responseData = d; return this; },
    };

    await notifCtrl.addNotification(req, res);

    assert.strictEqual(statusCode, 201);
    assert.strictEqual(responseData.data.id, "99");

    const fcmQuery = executedQueries.find((q) =>
      q.sql.includes('SELECT DISTINCT "fcmToken"') && q.sql.includes("FROM members")
    );
    assert.ok(fcmQuery, "addNotification must query active member FCM tokens for broadcast");
    console.log("✔ addNotification triggers FCM broadcast to active members");
  }

  // Test 3: sendMulticastNotification validation & error resilience
  {
    const nullRes = await sendMulticastNotification(null, { title: "T", body: "B" });
    assert.strictEqual(nullRes, null, "Should return null for non-array tokens");

    const emptyRes = await sendMulticastNotification([], { title: "T", body: "B" });
    assert.strictEqual(emptyRes, null, "Should return null for empty tokens");

    const invalidRes = await sendMulticastNotification(["", "  ", null], { title: "T", body: "B" });
    assert.strictEqual(invalidRes, null, "Should return null when no valid non-empty tokens");

    console.log("✔ sendMulticastNotification input validation works properly");
  }

  // Test 4: sendPushToAllMembers with mock pool
  {
    executedQueries = [];
    await sendPushToAllMembers(mockPool, {
      title: "Test Broadcast",
      body: "Test Body",
      data: { type: "TEST" },
    });

    const fcmQuery = executedQueries.find((q) =>
      q.sql.includes('SELECT DISTINCT "fcmToken"') && q.sql.includes("FROM members")
    );
    assert.ok(fcmQuery, "sendPushToAllMembers executed member token query");
    assert.ok(fcmQuery.sql.includes('COALESCE("isDeleted", false) = false'));
    assert.ok(fcmQuery.sql.includes('COALESCE("isActive", true) = true'));
    console.log("✔ sendPushToAllMembers successfully filters active non-deleted members");
  }

  console.log("\n ALL FCM BROADCAST TESTS PASSED! ✨");
})();
