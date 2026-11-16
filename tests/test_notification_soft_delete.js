const assert = require("assert");
const {
  notificationController,
  ensureNotificationsTable,
} = require("../controller/notification.controller");

(async () => {
  console.log("=== Running Notification Soft Delete Tests ===");

  let executedQueries = [];
  const notificationsInDb = [
    {
      id: "201",
      title: "Community Meeting",
      message: "Meeting at town hall",
      createBy: "10",
      is_active: true,
      isActive: true,
      isDeleted: false,
      deletedBy: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
    {
      id: "202",
      title: "Old Deleted Alert",
      message: "Old message",
      createBy: "10",
      is_active: false,
      isActive: false,
      isDeleted: true,
      deletedBy: "5",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-15T00:00:00Z",
    },
  ];

  const mockPool = {
    async query(sql, params) {
      executedQueries.push({ sql, params });

      if (
        sql.includes("ALTER TABLE notifications") ||
        sql.includes("CREATE INDEX") ||
        sql.includes("CREATE TABLE")
      ) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("UPDATE notifications") && sql.includes('"isDeleted" = TRUE')) {
        const deletedByParam = params[0];
        const notifIdParam = String(params[1]);
        const target = notificationsInDb.find((n) => n.id === notifIdParam && !n.isDeleted);
        if (!target) {
          return { rowCount: 0, rows: [] };
        }
        target.isDeleted = true;
        target.isActive = false;
        target.is_active = false;
        target.deletedBy = deletedByParam !== null ? String(deletedByParam) : null;
        target.updated_at = new Date().toISOString();
        return {
          rowCount: 1,
          rows: [{ ...target }],
        };
      }

      if (sql.includes("UPDATE notifications") && sql.includes("is_active = $1") && sql.includes("COALESCE(\"isDeleted\", false) = false")) {
        const newActive = params[0];
        const notifIdParam = String(params[1]);
        const target = notificationsInDb.find((n) => n.id === notifIdParam && !n.isDeleted);
        if (!target) {
          return { rowCount: 0, rows: [] };
        }
        target.is_active = newActive;
        target.isActive = newActive;
        target.updated_at = new Date().toISOString();
        return { rowCount: 1, rows: [{ ...target }] };
      }

      if (sql.includes("UPDATE notifications") && sql.includes("COALESCE(\"isDeleted\", false) = false")) {
        const notifIdParam = String(params[params.length - 1]);
        const target = notificationsInDb.find((n) => n.id === notifIdParam && !n.isDeleted);
        if (!target) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 1, rows: [{ ...target }] };
      }

      if (
        sql.includes("SELECT") &&
        sql.includes("FROM notifications") &&
        sql.includes("COALESCE(\"isDeleted\", false) = false") &&
        sql.includes("LIMIT $1 OFFSET $2")
      ) {
        let activeNotifs = notificationsInDb.filter((n) => !n.isDeleted);
        if (sql.includes("is_active = true") || sql.includes("COALESCE(is_active, true) = true")) {
          activeNotifs = activeNotifs.filter((n) => n.is_active && n.isActive);
        }
        return {
          rowCount: activeNotifs.length,
          rows: activeNotifs.map((n) => ({ ...n, total_count: String(activeNotifs.length) })),
        };
      }

      if (sql.includes("SELECT * FROM notifications WHERE id = $1") && sql.includes("COALESCE(\"isDeleted\", false) = false")) {
        const notifIdParam = String(params[0]);
        const target = notificationsInDb.find((n) => n.id === notifIdParam && !n.isDeleted);
        if (!target) {
          return { rowCount: 0, rows: [] };
        }
        return {
          rowCount: 1,
          rows: [{ ...target }],
        };
      }

      return { rowCount: 1, rows: [] };
    },
  };

  const controller = notificationController(mockPool);

  // 1. deleteNotification soft deletes and sets isDeleted=true, isActive=false, is_active=false, deletedBy=caller.id
  {
    executedQueries = [];
    const req = {
      params: { id: "201" },
      member: { id: 12, role: "ADMIN" },
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.deleteNotification(req, res);

    assert.strictEqual(statusCode, 200, "Should return HTTP 200 on successful soft delete");
    assert.strictEqual(responseData.success, true);
    assert.strictEqual(responseData.message, "Notification deleted successfully");
    assert.strictEqual(responseData.data.isDeleted, true, "isDeleted must be true");
    assert.strictEqual(responseData.data.isActive, false, "isActive must be false");
    assert.strictEqual(responseData.data.is_active, false, "is_active must be false");
    assert.strictEqual(responseData.data.deletedBy, 12, "deletedBy must be caller member id (12)");
    assert.strictEqual(responseData.data.createBy, 10, "createBy must be preserved as number");

    // Verify SQL query executed
    const deleteQuery = executedQueries.find((q) => q.sql.includes("UPDATE notifications"));
    assert.ok(deleteQuery, "Must execute UPDATE query instead of DELETE FROM notifications");
    assert.ok(deleteQuery.sql.includes('"isDeleted" = TRUE'), 'SQL must set "isDeleted" = TRUE');
    assert.ok(deleteQuery.sql.includes('"isActive" = FALSE'), 'SQL must set "isActive" = FALSE');
    assert.ok(deleteQuery.sql.includes('is_active = FALSE'), 'SQL must set is_active = FALSE');
    assert.ok(deleteQuery.sql.includes('"deletedBy" = $1'), 'SQL must set "deletedBy" = $1');
    assert.ok(deleteQuery.sql.includes('COALESCE("isDeleted", false) = false'), 'SQL must ensure not already deleted');
    assert.strictEqual(deleteQuery.params[0], 12, "Param 1 must be deletedBy (12)");
    assert.strictEqual(deleteQuery.params[1], 201, "Param 2 must be notificationId (201)");

    const hardDeleteQuery = executedQueries.find((q) => q.sql.includes("DELETE FROM notifications"));
    assert.strictEqual(hardDeleteQuery, undefined, "Must NOT run any hard DELETE FROM notifications query");

    console.log("✔ deleteNotification performs soft delete with isDeleted=true, isActive=false, is_active=false, and deletedBy=callerId");
  }

  // 2. deleteNotification on already soft-deleted notification returns 404
  {
    executedQueries = [];
    const req = {
      params: { id: "201" }, // Now already deleted
      member: { id: 12, role: "ADMIN" },
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.deleteNotification(req, res);

    assert.strictEqual(statusCode, 404, "Should return HTTP 404 for already deleted notification");
    assert.strictEqual(responseData.error, "Notification not found");
    console.log("✔ deleteNotification on already soft-deleted notification returns 404");
  }

  // 3. deleteNotification on non-existent notification returns 404
  {
    executedQueries = [];
    const req = {
      params: { id: "9999" },
      member: { id: 12, role: "ADMIN" },
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.deleteNotification(req, res);

    assert.strictEqual(statusCode, 404, "Should return HTTP 404 for non-existent notification");
    console.log("✔ deleteNotification on non-existent notification returns 404");
  }

  // 4. deleteNotification with invalid id returns 400
  {
    const req = {
      params: { id: "xyz" },
      member: { id: 12, role: "ADMIN" },
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.deleteNotification(req, res);

    assert.strictEqual(statusCode, 400, "Should return HTTP 400 for invalid notification id");
    assert.strictEqual(responseData.error, "Notification id must be a positive integer");
    console.log("✔ deleteNotification with invalid id returns 400");
  }

  // 5. getAllNotifications excludes soft-deleted notifications
  {
    executedQueries = [];
    const req = { query: { page: "1", limit: "10" }, member: { role: "ADMIN" } };
    let responseData = null;
    const res = {
      status() { return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.getAllNotifications(req, res);

    const getQuery = executedQueries.find((q) => q.sql.includes("FROM notifications"));
    assert.ok(getQuery.sql.includes('COALESCE("isDeleted", false) = false'), 'getAllNotifications must filter out isDeleted');
    assert.ok(getQuery.sql.includes('"isActive"'), 'getAllNotifications must select "isActive"');
    assert.ok(getQuery.sql.includes('"isDeleted"'), 'getAllNotifications must select "isDeleted"');
    assert.ok(getQuery.sql.includes('"deletedBy"'), 'getAllNotifications must select "deletedBy"');

    // Both notifications 201 and 202 are deleted, so total active is 0
    assert.strictEqual(responseData.data.notifications.length, 0, "No soft-deleted notifications should be in list");
    console.log("✔ getAllNotifications filters out soft-deleted notifications and selects flags");
  }

  // 6. getNotificationById on soft-deleted notification returns 404
  {
    executedQueries = [];
    const req = { params: { id: "201" } };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.getNotificationById(req, res);

    assert.strictEqual(statusCode, 404, "Should return 404 when getting soft-deleted notification");
    const selectCheck = executedQueries.find((q) => q.sql.includes("FROM notifications WHERE id = $1"));
    assert.ok(selectCheck.sql.includes('COALESCE("isDeleted", false) = false'), 'getNotificationById must include isDeleted condition');
    console.log("✔ getNotificationById returns 404 for soft-deleted notification");
  }

  // 7. setNotificationActive on soft-deleted notification returns 404
  {
    executedQueries = [];
    const req = { params: { id: "201" }, body: { is_active: true } };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.setNotificationActive(req, res);

    assert.strictEqual(statusCode, 404, "Should return 404 when activating soft-deleted notification");
    console.log("✔ setNotificationActive prevents activating soft-deleted notification");
  }

  // 8. ensureNotificationsTable creates columns and indexes for soft delete
  {
    executedQueries = [];
    await ensureNotificationsTable(mockPool);

    const alterActive = executedQueries.find((q) => q.sql.includes('ADD COLUMN IF NOT EXISTS "isActive"'));
    const alterDeleted = executedQueries.find((q) => q.sql.includes('ADD COLUMN IF NOT EXISTS "isDeleted"'));
    const alterDeletedBy = executedQueries.find((q) => q.sql.includes('ADD COLUMN IF NOT EXISTS "deletedBy"'));
    const idxDeleted = executedQueries.find((q) => q.sql.includes("idx_notifications_is_deleted"));
    const idxActive = executedQueries.find((q) => q.sql.includes("idx_notifications_is_active"));
    const idxDeletedBy = executedQueries.find((q) => q.sql.includes("idx_notifications_deleted_by"));

    assert.ok(alterActive, 'Must add "isActive" column');
    assert.ok(alterDeleted, 'Must add "isDeleted" column');
    assert.ok(alterDeletedBy, 'Must add "deletedBy" column');
    assert.ok(idxDeleted, "Must create idx_notifications_is_deleted index");
    assert.ok(idxActive, "Must create idx_notifications_is_active index");
    assert.ok(idxDeletedBy, "Must create idx_notifications_deleted_by index");

    console.log("✔ ensureNotificationsTable ensures isActive, isDeleted, and deletedBy columns and indexes");
  }

  console.log("\n ALL NOTIFICATION SOFT DELETE TESTS PASSED! ✨");
})();
