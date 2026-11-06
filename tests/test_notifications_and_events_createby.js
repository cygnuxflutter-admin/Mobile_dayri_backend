const assert = require("assert");
const {
  notificationController,
  ensureNotificationsTable,
  buildNotificationPayload,
  validateNotification,
} = require("../controller/notification.controller");
const {
  eventController,
  ensureEventsTable,
  buildEventPayload,
  validateEvent,
} = require("../controller/event.controller");

console.log("=== Running Notifications & Events createBy Tests ===");

// 1. Notification Payload Builder & Validation Tests
{
  // 1.1 Uses body.createBy
  const payload1 = buildNotificationPayload({ title: "T", message: "M", createBy: 42 }, []);
  assert.strictEqual(payload1.createBy, 42, "Should parse body.createBy");

  // 1.2 Uses body.createdBy fallback
  const payload2 = buildNotificationPayload({ title: "T", message: "M", createdBy: "99" }, []);
  assert.strictEqual(payload2.createBy, 99, "Should parse body.createdBy string as number");

  // 1.3 Uses body.create_by fallback
  const payload3 = buildNotificationPayload({ title: "T", message: "M", create_by: 12 }, []);
  assert.strictEqual(payload3.createBy, 12, "Should parse body.create_by");

  // 1.4 Falls back to callerId when not provided in body
  const payload4 = buildNotificationPayload({ title: "T", message: "M" }, [], 7);
  assert.strictEqual(payload4.createBy, 7, "Should fall back to callerId");

  // 1.5 Leaves undefined when neither body nor callerId provided
  const payload5 = buildNotificationPayload({ title: "T", message: "M" }, []);
  assert.strictEqual(payload5.createBy, undefined, "Should be undefined if not provided");

  // 1.6 Validation tests
  assert.strictEqual(validateNotification({ title: "T", message: "M", createBy: 5 }), null, "Valid createBy");
  assert.strictEqual(validateNotification({ title: "T", message: "M", createBy: null }), null, "Nullable createBy");
  const errInvalid = validateNotification({ title: "T", message: "M", createBy: -1 });
  assert.ok(errInvalid && errInvalid.error.includes("createBy"), "Negative createBy should fail validation");
  const errString = validateNotification({ title: "T", message: "M", createBy: "abc" });
  assert.ok(errString && errString.error.includes("createBy"), "Non-numeric createBy should fail validation");

  console.log("✔ Notification Payload Builder & Validation passed");
}

// 2. Notification Controller Flow Tests
(async () => {
  let executedQueries = [];
  const mockPool = {
    query: async (sql, params) => {
      executedQueries.push({ sql, params });

      if (sql.includes("INSERT INTO notifications")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              title: params[0],
              message: params[1],
              location: params[2],
              contact_numbers: params[3],
              notify_type: params[4],
              photo_url: params[5],
              photo_urls: params[6] ? JSON.parse(params[6]) : null,
              createBy: params[7],
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        };
      }

      if (sql.includes("UPDATE notifications") && sql.includes("is_active = $1")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              title: "T",
              message: "M",
              createBy: "10",
              is_active: params[0],
            },
          ],
        };
      }

      if (sql.includes("UPDATE notifications")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              title: "Updated",
              message: "Updated M",
              createBy: "15",
              is_active: true,
            },
          ],
        };
      }

      if (sql.includes("SELECT") && sql.includes("FROM notifications WHERE id = $1")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              title: "T",
              message: "M",
              createBy: "10",
              is_active: true,
            },
          ],
        };
      }

      if (sql.includes("SELECT") && sql.includes("FROM notifications")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              title: "T",
              message: "M",
              createBy: "10",
              is_active: true,
              total_count: "1",
            },
          ],
        };
      }

      return { rowCount: 1, rows: [] };
    },
  };

  const controller = notificationController(mockPool);

  // 2.1 addNotification with callerId
  {
    executedQueries = [];
    const req = {
      body: { title: "Test Alert", message: "Alert body" },
      member: { id: 10, role: "ADMIN" },
      files: [],
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(c) {
        statusCode = c;
        return this;
      },
      json(d) {
        responseData = d;
        return this;
      },
    };

    await controller.addNotification(req, res);
    assert.strictEqual(statusCode, 201, "addNotification should return 201");
    assert.strictEqual(responseData.data.createBy, 10, "addNotification must set createBy from caller member id");
    const insertQuery = executedQueries.find((q) => q.sql.includes("INSERT INTO notifications"));
    assert.ok(insertQuery.sql.includes('"createBy"'), 'Insert SQL must include "createBy"');
    assert.strictEqual(insertQuery.params[7], 10, "Param 8 must be createBy 10");
    console.log("✔ addNotification successfully inserts createBy and returns formatted number");
  }

  // 2.2 addNotification with explicit body.createBy
  {
    executedQueries = [];
    const req = {
      body: { title: "Custom Alert", message: "Alert body", createBy: 25 },
      member: { id: 10, role: "ADMIN" },
      files: [],
    };
    let responseData = null;
    const res = {
      status() { return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.addNotification(req, res);
    assert.strictEqual(responseData.data.createBy, 25, "addNotification must prioritize body.createBy");
    console.log("✔ addNotification prioritizes body.createBy");
  }

  // 2.3 updateNotification updating createBy
  {
    executedQueries = [];
    const req = {
      params: { id: "1" },
      body: { createBy: 15 },
      member: { id: 10, role: "ADMIN" },
      files: [],
    };
    let responseData = null;
    const res = {
      status() { return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.updateNotification(req, res);
    const updateQuery = executedQueries.find((q) => q.sql.includes("UPDATE notifications"));
    assert.ok(updateQuery.sql.includes('"createBy"'), 'Update SQL must include "createBy"');
    assert.strictEqual(responseData.data.createBy, 15, "updateNotification returns updated createBy");
    console.log("✔ updateNotification updates createBy");
  }

  // 2.4 getAllNotifications includes createBy
  {
    executedQueries = [];
    const req = { query: {}, member: { id: 10, role: "ADMIN" } };
    let responseData = null;
    const res = {
      status() { return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.getAllNotifications(req, res);
    const selectQuery = executedQueries.find((q) => q.sql.includes("FROM notifications"));
    assert.ok(selectQuery.sql.includes('"createBy"'), 'getAllNotifications SQL must include "createBy"');
    assert.strictEqual(responseData.data.notifications[0].createBy, 10, "getAllNotifications returns createBy as number");
    console.log("✔ getAllNotifications returns createBy");
  }

  // 2.5 getNotificationById includes createBy
  {
    const req = { params: { id: "1" }, member: { id: 10, role: "ADMIN" } };
    let responseData = null;
    const res = {
      status() { return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.getNotificationById(req, res);
    assert.strictEqual(responseData.data.createBy, 10, "getNotificationById returns createBy as number");
    console.log("✔ getNotificationById returns createBy");
  }

  // 2.6 ensureNotificationsTable alters table
  {
    executedQueries = [];
    await ensureNotificationsTable(mockPool);
    const alterQuery = executedQueries.find(
      (q) => q.sql.includes("ALTER TABLE notifications") && q.sql.includes('"createBy"')
    );
    assert.ok(alterQuery, 'ensureNotificationsTable must add "createBy" column');
    console.log("✔ ensureNotificationsTable ensures createBy column and index");
  }
})();

// 3. Event Payload Builder & Validation Tests
{
  // 3.1 Uses body.createBy
  const payload1 = buildEventPayload({ name: "Gala", event_date: "15-11-2026", createBy: 50 }, []);
  assert.strictEqual(payload1.createBy, 50, "Should parse body.createBy");

  // 3.2 Uses body.createdBy fallback
  const payload2 = buildEventPayload({ name: "Gala", event_date: "15-11-2026", createdBy: "75" }, []);
  assert.strictEqual(payload2.createBy, 75, "Should parse body.createdBy");

  // 3.3 Falls back to callerId
  const payload3 = buildEventPayload({ name: "Gala", event_date: "15-11-2026" }, [], null, 88);
  assert.strictEqual(payload3.createBy, 88, "Should fall back to callerId");

  // 3.4 Validation
  assert.strictEqual(validateEvent({ name: "Gala", eventDate: "15-11-2026", createBy: 1 }), null, "Valid event");
  const errInvalid = validateEvent({ name: "Gala", eventDate: "15-11-2026", createBy: 0 });
  assert.ok(errInvalid && errInvalid.error.includes("createBy"), "Zero createBy should fail");
  console.log("✔ Event Payload Builder & Validation passed");
}

// 4. Event Controller Flow Tests
(async () => {
  let executedQueries = [];
  const mockPool = {
    query: async (sql, params) => {
      executedQueries.push({ sql, params });

      if (sql.includes("INSERT INTO events")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              name: params[0],
              event_date: params[1],
              image_url: params[2],
              image_urls: params[3] ? JSON.parse(params[3]) : null,
              video_url: params[4],
              video_urls: params[5] ? JSON.parse(params[5]) : null,
              video_link: params[6],
              video_links: params[7] ? JSON.parse(params[7]) : null,
              createBy: params[8],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        };
      }

      if (sql.includes("SELECT * FROM events WHERE id = $1")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              name: "Existing Event",
              event_date: "2026-11-15T00:00:00Z",
              createBy: "33",
            },
          ],
        };
      }

      if (sql.includes("UPDATE events") && sql.includes("RETURNING *")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              name: params ? params[0] : "Updated Event",
              event_date: params ? params[1] : "2026-11-15T00:00:00Z",
              createBy: params ? params[8] : null,
              updated_at: new Date().toISOString(),
            },
          ],
        };
      }

      if (sql.includes("SELECT") && sql.includes("FROM events")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              name: "Event 1",
              event_date: "2026-11-15T00:00:00Z",
              createBy: "33",
              total_count: "1",
            },
          ],
        };
      }

      if (sql.includes("DELETE FROM events")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "1",
              name: "Deleted Event",
              createBy: "33",
            },
          ],
        };
      }

      return { rowCount: 1, rows: [] };
    },
  };

  const controller = eventController(mockPool);

  // 4.1 addEvent with callerId
  {
    executedQueries = [];
    const req = {
      body: { name: "Annual Gathering", event_date: "20-12-2026" },
      member: { id: 33, role: "ADMIN" },
      files: [],
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.addEvent(req, res);
    assert.strictEqual(statusCode, 201, "addEvent should return 201");
    assert.strictEqual(responseData.data.createBy, 33, "addEvent must set createBy from caller member id");
    const insertQuery = executedQueries.find((q) => q.sql.includes("INSERT INTO events"));
    assert.ok(insertQuery.sql.includes('"createBy"'), 'Insert SQL must include "createBy"');
    assert.strictEqual(insertQuery.params[8], 33, "Param 9 must be createBy 33");
    console.log("✔ addEvent successfully inserts createBy and returns formatted number");
  }

  // 4.2 addEvent with explicit body.createBy
  {
    executedQueries = [];
    const req = {
      body: { name: "Annual Gathering", event_date: "20-12-2026", createBy: 77 },
      member: { id: 33, role: "ADMIN" },
      files: [],
    };
    let responseData = null;
    const res = {
      status() { return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.addEvent(req, res);
    assert.strictEqual(responseData.data.createBy, 77, "addEvent must prioritize body.createBy");
    console.log("✔ addEvent prioritizes body.createBy");
  }

  // 4.3 updateEvent preserves existing createBy if not passed
  {
    executedQueries = [];
    const req = {
      params: { id: "1" },
      body: { name: "Updated Gathering Name" },
      member: { id: 33, role: "ADMIN" },
      files: [],
    };
    let responseData = null;
    const res = {
      status() { return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.updateEvent(req, res);
    const updateQuery = executedQueries.find((q) => q.sql.includes("UPDATE events"));
    assert.ok(updateQuery.sql.includes('"createBy" = $9'), 'Update SQL must include "createBy"');
    assert.strictEqual(updateQuery.params[8], 33, "Should preserve existing createBy 33");
    assert.strictEqual(responseData.data.createBy, 33, "updateEvent returns createBy");
    console.log("✔ updateEvent preserves existing createBy");
  }

  // 4.4 updateEvent updates createBy if passed in body
  {
    executedQueries = [];
    const req = {
      params: { id: "1" },
      body: { createBy: 99 },
      member: { id: 33, role: "ADMIN" },
      files: [],
    };
    let responseData = null;
    const res = {
      status() { return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.updateEvent(req, res);
    const updateQuery = executedQueries.find((q) => q.sql.includes("UPDATE events"));
    assert.strictEqual(updateQuery.params[8], 99, "Should update to new createBy 99");
    assert.strictEqual(responseData.data.createBy, 99, "updateEvent returns updated createBy");
    console.log("✔ updateEvent updates createBy when provided");
  }

  // 4.5 getEvents includes createBy
  {
    executedQueries = [];
    const req = { query: {}, member: { id: 33, role: "ADMIN" } };
    let responseData = null;
    const res = {
      status() { return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.getEvents(req, res);
    const selectQuery = executedQueries.find((q) => q.sql.includes("FROM events"));
    assert.ok(selectQuery.sql.includes('"createBy"'), 'getEvents SQL must include "createBy"');
    assert.strictEqual(responseData.data.events[0].createBy, 33, "getEvents returns createBy as number");
    console.log("✔ getEvents returns createBy");
  }

  // 4.6 deleteEvent includes createBy
  {
    const req = { params: { id: "1" }, member: { id: 33, role: "ADMIN" } };
    let responseData = null;
    const res = {
      status() { return this; },
      json(d) { responseData = d; return this; },
    };

    await controller.deleteEvent(req, res);
    assert.strictEqual(responseData.data.createBy, 33, "deleteEvent returns createBy as number");
    console.log("✔ deleteEvent returns createBy");
  }

  // 4.7 ensureEventsTable alters table
  {
    executedQueries = [];
    await ensureEventsTable(mockPool);
    const alterQuery = executedQueries.find(
      (q) => q.sql.includes("ALTER TABLE events") && q.sql.includes('"createBy"')
    );
    assert.ok(alterQuery, 'ensureEventsTable must add "createBy" column');
    console.log("✔ ensureEventsTable ensures createBy column and index");
  }

  console.log("\n ALL NOTIFICATION AND EVENT createBy TESTS PASSED! ✨");
})();
