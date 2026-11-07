const assert = require("assert");
const { memberController } = require("../controller/member.controller");

console.log("=== Running Reset Password Unit Tests ===");

(async () => {
  // Test 1: Validation checks
  {
    const mockPool = {
      query: async () => ({ rowCount: 0, rows: [] }),
    };
    const controller = memberController(mockPool);

    // Invalid ID
    {
      let status = 0;
      let jsonResp = null;
      const req = { params: { id: "abc" }, body: {} };
      const res = {
        status: (s) => {
          status = s;
          return { json: (j) => { jsonResp = j; } };
        },
      };
      await controller.resetPassword(req, res);
      assert.strictEqual(status, 400);
      assert.strictEqual(jsonResp.error, "Member id must be a positive integer");
      console.log("✔ resetPassword: Invalid member ID rejected (400)");
    }

    // Missing password
    {
      let status = 0;
      let jsonResp = null;
      const req = { params: { id: "394" }, body: {} };
      const res = {
        status: (s) => {
          status = s;
          return { json: (j) => { jsonResp = j; } };
        },
      };
      await controller.resetPassword(req, res);
      assert.strictEqual(status, 400);
      assert.strictEqual(jsonResp.error, "newPassword is required");
      console.log("✔ resetPassword: Missing newPassword rejected (400)");
    }

    // Short password (< 6 chars)
    {
      let status = 0;
      let jsonResp = null;
      const req = { params: { id: "394" }, body: { newPassword: "123" } };
      const res = {
        status: (s) => {
          status = s;
          return { json: (j) => { jsonResp = j; } };
        },
      };
      await controller.resetPassword(req, res);
      assert.strictEqual(status, 400);
      assert.strictEqual(jsonResp.error, "Password must be at least 6 characters");
      console.log("✔ resetPassword: Short password rejected (400)");
    }

    // Mismatched confirmPassword
    {
      let status = 0;
      let jsonResp = null;
      const req = {
        params: { id: "394" },
        body: { newPassword: "password123", confirmPassword: "different123" },
      };
      const res = {
        status: (s) => {
          status = s;
          return { json: (j) => { jsonResp = j; } };
        },
      };
      await controller.resetPassword(req, res);
      assert.strictEqual(status, 400);
      assert.strictEqual(jsonResp.error, "Passwords do not match");
      console.log("✔ resetPassword: Mismatched confirmPassword rejected (400)");
    }
  }

  // Test 2: Member not found (404)
  {
    const mockPool = {
      query: async (sql) => {
        if (sql.includes("SELECT id, \"role\"")) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    const controller = memberController(mockPool);
    let status = 0;
    let jsonResp = null;
    const req = {
      params: { id: "394" },
      body: { newPassword: "newsecretpassword" },
      member: { id: 1, role: "ADMIN" },
    };
    const res = {
      status: (s) => {
        status = s;
        return { json: (j) => { jsonResp = j; } };
      },
    };
    await controller.resetPassword(req, res);
    assert.strictEqual(status, 404);
    assert.strictEqual(jsonResp.error, "Member not found");
    console.log("✔ resetPassword: Member not found returned 404");
  }

  // Test 3: Role permissions
  {
    // ADMIN cannot reset ADMIN
    const mockPool = {
      query: async (sql) => {
        if (sql.includes("SELECT id, \"role\"")) {
          return {
            rowCount: 1,
            rows: [{ id: 394, role: "ADMIN", firstName: "Admin", middleName: "A", surname: "Patel" }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    const controller = memberController(mockPool);
    let status = 0;
    let jsonResp = null;
    const req = {
      params: { id: "394" },
      body: { newPassword: "newsecretpassword" },
      member: { id: 2, role: "ADMIN" },
    };
    const res = {
      status: (s) => {
        status = s;
        return { json: (j) => { jsonResp = j; } };
      },
    };
    await controller.resetPassword(req, res);
    assert.strictEqual(status, 403);
    assert.strictEqual(jsonResp.error, "Admin can only reset password for Users");
    console.log("✔ resetPassword: Admin cannot reset another Admin (403)");
  }

  // SUPERADMIN cannot reset another SUPERADMIN
  {
    const mockPool = {
      query: async (sql) => {
        if (sql.includes("SELECT id, \"role\"")) {
          return {
            rowCount: 1,
            rows: [{ id: 394, role: "SUPERADMIN", firstName: "Super", middleName: "B", surname: "Patel" }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    const controller = memberController(mockPool);
    let status = 0;
    let jsonResp = null;
    const req = {
      params: { id: "394" },
      body: { newPassword: "newsecretpassword" },
      member: { id: 1, role: "SUPERADMIN" },
    };
    const res = {
      status: (s) => {
        status = s;
        return { json: (j) => { jsonResp = j; } };
      },
    };
    await controller.resetPassword(req, res);
    assert.strictEqual(status, 403);
    assert.strictEqual(jsonResp.error, "Cannot reset password for another SuperAdmin");
    console.log("✔ resetPassword: SuperAdmin cannot reset another SuperAdmin (403)");
  }

  // Test 4: Successful reset by ADMIN for USER
  {
    let updatedValues = null;
    let executedSql = null;
    const mockPool = {
      query: async (sql, values) => {
        if (sql.includes("SELECT id, \"role\"")) {
          // Verify that "fullName" is NOT in the SELECT query (which was the bug!)
          assert(!sql.includes("\"fullName\""), "Query should not reference non-existent \"fullName\" column");
          return {
            rowCount: 1,
            rows: [{ id: 394, role: "USER", firstName: "Ramesh", middleName: "B", surname: "Patel" }],
          };
        }
        if (sql.includes("UPDATE members")) {
          executedSql = sql;
          updatedValues = values;
          assert(!sql.includes("\"fullName\""), "UPDATE query should not reference non-existent \"fullName\" column");
          return {
            rowCount: 1,
            rows: [{ id: 394, role: "USER", firstName: "Ramesh", middleName: "B", surname: "Patel" }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    const controller = memberController(mockPool);
    let status = 0;
    let successPayload = null;
    const req = {
      params: { id: "394" },
      body: { newPassword: "securePassword123", confirmPassword: "securePassword123" },
      member: { id: 1, role: "ADMIN" },
    };
    const res = {
      status: (s) => {
        status = s;
        return {
          json: (j) => {
            successPayload = j;
          },
        };
      },
    };
    await controller.resetPassword(req, res);
    assert.strictEqual(status, 200);
    assert.strictEqual(successPayload.success, true);
    assert.strictEqual(successPayload.message, "Password reset successfully");
    assert.deepStrictEqual(successPayload.data.member, {
      id: 394,
      fullName: "Ramesh B Patel",
      role: "USER",
    });
    console.log("✔ resetPassword: Admin successfully reset User password (200)");
  }

  // Test 5: Fallback parameter names (e.g. body.password instead of body.newPassword)
  {
    const mockPool = {
      query: async (sql) => {
        if (sql.includes("SELECT id, \"role\"")) {
          return {
            rowCount: 1,
            rows: [{ id: 394, role: "USER", firstName: "Ramesh", middleName: null, surname: "Patel" }],
          };
        }
        if (sql.includes("UPDATE members")) {
          return {
            rowCount: 1,
            rows: [{ id: 394, role: "USER", firstName: "Ramesh", middleName: null, surname: "Patel" }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    const controller = memberController(mockPool);
    let status = 0;
    let successPayload = null;
    const req = {
      params: { id: "394" },
      body: { password: "securePassword123" },
      member: { id: 1, role: "SUPERADMIN" },
    };
    const res = {
      status: (s) => {
        status = s;
        return {
          json: (j) => {
            successPayload = j;
          },
        };
      },
    };
    await controller.resetPassword(req, res);
    assert.strictEqual(status, 200);
    assert.strictEqual(successPayload.data.member.fullName, "Ramesh Patel");
    console.log("✔ resetPassword: Supports body.password and correctly formats fullName when middleName is null (200)");
  }

  console.log("\n ALL RESET PASSWORD TESTS PASSED SUCCESSFULLY! ✨\n");
})();
