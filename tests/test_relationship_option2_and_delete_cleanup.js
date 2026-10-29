const assert = require("assert");
const { memberController } = require("../controller/member.controller");

console.log("=== Running Option 2 (Pending Request on Register) & Delete Cleanup Tests ===");

// 1. Test register with fatherId (Option 2)
{
  let insertedValues = null;
  let relationshipRequests = [];

  const mockClient = {
    query: async (sql, params) => {
      if (sql.includes("INSERT INTO members")) {
        insertedValues = params;
        return {
          rowCount: 1,
          rows: [
            {
              id: 10,
              firstName: params[0],
              surname: params[4],
              mobileNumber: params[6],
              fatherId: params[22],
              sonIds: params[21],
              created_at: new Date(),
            },
          ],
        };
      }
      if (sql.includes("SELECT id FROM members\n           WHERE \"mobileNumber\"") || sql.includes("mobileNumber\" = $1")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("WHERE id = $1 AND COALESCE(\"isDeleted\", false) = false")) {
        return { rowCount: 1, rows: [{ id: params[0] }] };
      }
      if (sql.includes("SELECT setval")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };

  const mockPool = {
    connect: async () => mockClient,
    query: async (sql, params) => {
      if (sql.includes("SELECT id, \"firstName\"")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: params[0],
              firstName: "Test",
              middleName: "User",
              surname: "Test",
              fatherId: null,
              sonIds: null,
              fcmToken: null,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO relationship_requests")) {
        relationshipRequests.push(params);
        return {
          rowCount: 1,
          rows: [{ id: 101, requester_id: params[0], target_id: params[1], relationship_type: params[2] }],
        };
      }
      if (sql.includes("INSERT INTO user_notifications")) {
        return {
          rowCount: 1,
          rows: [{ id: 201 }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const ctrl = memberController(mockPool);

  (async () => {
    let statusCode = 200;
    let responseData = null;
    const req = {
      body: {
        firstName: "Fenil",
        firstNameEnglish: "Fenil",
        middleName: "A",
        middleNameEnglish: "A",
        surname: "Patel",
        surnameEnglish: "Patel",
        mobileNumber: "9123456789",
        countryCode: "+91",
        gender: "Male",
        dateOfBirth: "2002-01-01",
        isOutsideIndia: false,
        password: "password123",
        confirmPassword: "password123",
        fatherId: 2, // Aayush
      },
      file: null,
      route: { path: "/addMember" },
      member: { role: "ADMIN" },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        responseData = data;
        return this;
      },
    };

    await ctrl.register(req, res);

    assert.strictEqual(statusCode, 200, "Registration should succeed");
    // Under Option 2, new member should NOT have fatherId directly set
    assert.strictEqual(insertedValues[22], null, "fatherId must be NULL in INSERT query (pending approval)");
    assert.strictEqual(insertedValues[21], null, "sonIds must be NULL in INSERT query (pending approval)");

    // Relationship request must be created for target father (ID 2)
    assert.strictEqual(relationshipRequests.length, 1, "Must create 1 relationship request");
    assert.strictEqual(relationshipRequests[0][0], 10, "Requester must be new member ID (10)");
    assert.strictEqual(relationshipRequests[0][1], 2, "Target must be requested father ID (2)");
    assert.strictEqual(relationshipRequests[0][2], "FATHER", "Relationship type must be FATHER");

    console.log("✔ Option 2: Register/addMember creates pending request instead of directly setting fatherId");
  })().catch((err) => {
    console.error("Test error:", err);
    process.exit(1);
  });
}

// 2. Test deleteAccount unlinking relationships
{
  const executedUpdates = [];
  const mockPool = {
    query: async (sql, params) => {
      executedUpdates.push({ sql, params });
      if (sql.includes("isDeleted") && sql.includes("UPDATE members")) {
        return {
          rowCount: 1,
          rows: [{ id: params[0], isDeleted: true, isActive: false, deletedBy: params[0] }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const ctrl = memberController(mockPool);

  (async () => {
    let statusCode = 200;
    const req = {
      member: { id: 5 },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    };

    await ctrl.deleteAccount(req, res);
    assert.strictEqual(statusCode, 200);

    const unlinkedFather = executedUpdates.some(
      (e) => e.sql.includes("SET \"fatherId\" = NULL") && e.params[0] === 5
    );
    const unlinkedSons = executedUpdates.some(
      (e) => e.sql.includes("SET \"sonIds\" = array_remove") && e.params[0] === 5
    );
    const cancelledRequests = executedUpdates.some(
      (e) => e.sql.includes("UPDATE relationship_requests") && e.sql.includes("CANCELLED") && e.params[0] === 5
    );

    console.log("Executed updates:", executedUpdates);
    assert.ok(unlinkedFather, "Must unlink fatherId where fatherId = deleted user");
    assert.ok(unlinkedSons, "Must remove deleted user from sonIds arrays");
    assert.ok(cancelledRequests, "Must cancel pending requests involving deleted user");

    console.log("✔ Delete account properly cleans up fatherId, sonIds, and pending requests");
    console.log("=== All Option 2 & Delete Cleanup Tests Passed! ===");
  })().catch((err) => {
    console.error("Test error:", err);
    process.exit(1);
  });
}
