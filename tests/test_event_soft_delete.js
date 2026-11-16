const assert = require("assert");
const {
  eventController,
  ensureEventsTable,
} = require("../controller/event.controller");

(async () => {
  console.log("=== Running Event Soft Delete Tests ===");

  let executedQueries = [];
  const eventsInDb = [
    {
      id: "101",
      name: "Diwali Mahotsav",
      event_date: "2026-11-01T00:00:00Z",
      createBy: "10",
      isActive: true,
      isDeleted: false,
      deletedBy: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
    {
      id: "102",
      name: "Past Deleted Event",
      event_date: "2026-10-01T00:00:00Z",
      createBy: "10",
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

      if (sql.includes("ALTER TABLE events") || sql.includes("CREATE INDEX") || sql.includes("CREATE TABLE")) {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("UPDATE events") && sql.includes('"isDeleted" = TRUE')) {
        const deletedByParam = params[0];
        const eventIdParam = String(params[1]);
        const target = eventsInDb.find((e) => e.id === eventIdParam && !e.isDeleted);
        if (!target) {
          return { rowCount: 0, rows: [] };
        }
        target.isDeleted = true;
        target.isActive = false;
        target.deletedBy = deletedByParam !== null ? String(deletedByParam) : null;
        target.updated_at = new Date().toISOString();
        return {
          rowCount: 1,
          rows: [{ ...target }],
        };
      }

      if (sql.includes("SELECT") && sql.includes("FROM events") && sql.includes("COALESCE(\"isDeleted\", false) = false") && sql.includes("LIMIT $1 OFFSET $2")) {
        const activeEvents = eventsInDb.filter((e) => !e.isDeleted);
        return {
          rowCount: activeEvents.length,
          rows: activeEvents.map((e) => ({ ...e, total_count: String(activeEvents.length) })),
        };
      }

      if (sql.includes("SELECT * FROM events WHERE id = $1") && sql.includes("COALESCE(\"isDeleted\", false) = false")) {
        const eventIdParam = String(params[0]);
        const target = eventsInDb.find((e) => e.id === eventIdParam && !e.isDeleted);
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

  const controller = eventController(mockPool);

  // 1. deleteEvent soft deletes and sets isDeleted=true, isActive=false, deletedBy=caller.id
  {
    executedQueries = [];
    const req = {
      params: { id: "101" },
      member: { id: 7, role: "ADMIN" },
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.deleteEvent(req, res);

    assert.strictEqual(statusCode, 200, "Should return HTTP 200 on successful soft delete");
    assert.strictEqual(responseData.success, true);
    assert.strictEqual(responseData.message, "Event deleted successfully");
    assert.strictEqual(responseData.data.isDeleted, true, "isDeleted must be true");
    assert.strictEqual(responseData.data.isActive, false, "isActive must be false");
    assert.strictEqual(responseData.data.deletedBy, 7, "deletedBy must be caller member id (7)");
    assert.strictEqual(responseData.data.createBy, 10, "createBy must be preserved as number");

    // Verify SQL query executed
    const deleteQuery = executedQueries.find((q) => q.sql.includes("UPDATE events"));
    assert.ok(deleteQuery, "Must execute UPDATE query instead of DELETE FROM events");
    assert.ok(deleteQuery.sql.includes('"isDeleted" = TRUE'), 'SQL must set "isDeleted" = TRUE');
    assert.ok(deleteQuery.sql.includes('"isActive" = FALSE'), 'SQL must set "isActive" = FALSE');
    assert.ok(deleteQuery.sql.includes('"deletedBy" = $1'), 'SQL must set "deletedBy" = $1');
    assert.ok(deleteQuery.sql.includes('COALESCE("isDeleted", false) = false'), 'SQL must ensure event was not already deleted');
    assert.strictEqual(deleteQuery.params[0], 7, "Param 1 must be deletedBy (7)");
    assert.strictEqual(deleteQuery.params[1], 101, "Param 2 must be eventId (101)");

    const hardDeleteQuery = executedQueries.find((q) => q.sql.includes("DELETE FROM events"));
    assert.strictEqual(hardDeleteQuery, undefined, "Must NOT run any hard DELETE FROM events query");

    console.log("✔ deleteEvent performs soft delete with isDeleted=true, isActive=false, and deletedBy=callerId");
  }

  // 2. deleteEvent on already soft-deleted event returns 404
  {
    executedQueries = [];
    const req = {
      params: { id: "101" }, // Now already deleted
      member: { id: 7, role: "ADMIN" },
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.deleteEvent(req, res);

    assert.strictEqual(statusCode, 404, "Should return HTTP 404 for already deleted event");
    assert.strictEqual(responseData.error, "Event not found");
    console.log("✔ deleteEvent on already soft-deleted event returns 404");
  }

  // 3. deleteEvent on non-existent event returns 404
  {
    executedQueries = [];
    const req = {
      params: { id: "9999" },
      member: { id: 7, role: "ADMIN" },
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.deleteEvent(req, res);

    assert.strictEqual(statusCode, 404, "Should return HTTP 404 for non-existent event");
    console.log("✔ deleteEvent on non-existent event returns 404");
  }

  // 4. deleteEvent with invalid id returns 400
  {
    const req = {
      params: { id: "abc" },
      member: { id: 7, role: "ADMIN" },
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.deleteEvent(req, res);

    assert.strictEqual(statusCode, 400, "Should return HTTP 400 for invalid event id");
    assert.strictEqual(responseData.error, "Event id must be a positive integer");
    console.log("✔ deleteEvent with invalid id returns 400");
  }

  // 5. getEvents excludes soft-deleted events
  {
    executedQueries = [];
    const req = { query: { page: "1", limit: "10" } };
    let responseData = null;
    const res = {
      status() { return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.getEvents(req, res);

    const getQuery = executedQueries.find((q) => q.sql.includes("FROM events"));
    assert.ok(getQuery.sql.includes('WHERE COALESCE("isDeleted", false) = false'), 'getEvents must filter out isDeleted');
    assert.ok(getQuery.sql.includes('"isActive"'), 'getEvents must select isActive');
    assert.ok(getQuery.sql.includes('"isDeleted"'), 'getEvents must select isDeleted');
    assert.ok(getQuery.sql.includes('"deletedBy"'), 'getEvents must select deletedBy');

    // Both events 101 and 102 are deleted, so total is 0
    assert.strictEqual(responseData.data.events.length, 0, "No soft-deleted events should be in list");
    console.log("✔ getEvents query filters out soft-deleted events and includes new columns");
  }

  // 6. updateEvent on soft-deleted event returns 404
  {
    executedQueries = [];
    const req = {
      params: { id: "101" },
      body: { name: "Attempt to update deleted event" },
      member: { id: 7, role: "ADMIN" },
    };
    let responseData = null;
    let statusCode = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseData = data; return this; },
    };

    await controller.updateEvent(req, res);

    assert.strictEqual(statusCode, 404, "Should return 404 when updating soft-deleted event");
    const selectCheck = executedQueries.find((q) => q.sql.includes("SELECT * FROM events"));
    assert.ok(selectCheck.sql.includes('COALESCE("isDeleted", false) = false'), 'updateEvent check must include isDeleted condition');
    console.log("✔ updateEvent prevents updating soft-deleted event");
  }

  // 7. ensureEventsTable creates columns and indexes for soft delete
  {
    executedQueries = [];
    await ensureEventsTable(mockPool);

    const alterActive = executedQueries.find((q) => q.sql.includes('ADD COLUMN IF NOT EXISTS "isActive"'));
    const alterDeleted = executedQueries.find((q) => q.sql.includes('ADD COLUMN IF NOT EXISTS "isDeleted"'));
    const alterDeletedBy = executedQueries.find((q) => q.sql.includes('ADD COLUMN IF NOT EXISTS "deletedBy"'));
    const idxDeleted = executedQueries.find((q) => q.sql.includes("idx_events_is_deleted"));
    const idxActive = executedQueries.find((q) => q.sql.includes("idx_events_is_active"));
    const idxDeletedBy = executedQueries.find((q) => q.sql.includes("idx_events_deleted_by"));

    assert.ok(alterActive, 'Must add "isActive" column');
    assert.ok(alterDeleted, 'Must add "isDeleted" column');
    assert.ok(alterDeletedBy, 'Must add "deletedBy" column');
    assert.ok(idxDeleted, "Must create idx_events_is_deleted index");
    assert.ok(idxActive, "Must create idx_events_is_active index");
    assert.ok(idxDeletedBy, "Must create idx_events_deleted_by index");

    console.log("✔ ensureEventsTable ensures isActive, isDeleted, and deletedBy columns and indexes");
  }

  console.log("\n ALL EVENT SOFT DELETE TESTS PASSED! ✨");
})();
