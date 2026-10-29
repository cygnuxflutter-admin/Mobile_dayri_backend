const assert = require("assert");
const { memberResponse } = require("../controller/auth.controller");
const { memberController } = require("../controller/member.controller");

console.log("=== Running Business and Status (Married/Unmarried) Unit Tests ===");

// 1. Test memberResponse serializer
{
  const member = {
    id: 1,
    firstName: "Ramesh",
    firstNameEnglish: "Ramesh",
    middleName: "K",
    middleNameEnglish: "K",
    surname: "Patel",
    surnameEnglish: "Patel",
    mobileNumber: "9876543210",
    secondaryMobileNumber: null,
    email: null,
    business: "Diamond Trading",
    status: "married",
    countryCode: "+91",
    isOutsideIndia: false,
    country: null,
    state: null,
    city: null,
    role: "USER",
    dateOfBirth: "1990-01-01",
    gender: "Male",
    isActive: true,
    isApproved: true,
    photo_url: null,
    created_at: new Date(),
    updated_at: new Date(),
    isPasswordChange: false,
  };

  const serialized = memberResponse(member);
  assert.strictEqual(serialized.business, "Diamond Trading");
  assert.strictEqual(serialized.status, "married");
  assert.strictEqual(serialized.maritalStatus, "married");
  assert.strictEqual(serialized.middleName, "K");
  assert.strictEqual(serialized.middleNameEnglish, "K");
  console.log("✔ Serializer with business and married status passed");

  const memberUnmarried = {
    ...member,
    business: "Software Engineer",
    status: "unmarried",
  };
  const serializedUnmarried = memberResponse(memberUnmarried);
  assert.strictEqual(serializedUnmarried.business, "Software Engineer");
  assert.strictEqual(serializedUnmarried.status, "unmarried");
  assert.strictEqual(serializedUnmarried.maritalStatus, "unmarried");
  console.log("✔ Serializer with unmarried status passed");

  const memberEmpty = {
    ...member,
    business: null,
    status: null,
  };
  const serializedEmpty = memberResponse(memberEmpty);
  assert.strictEqual(serializedEmpty.business, null);
  assert.strictEqual(serializedEmpty.status, null);
  assert.strictEqual(serializedEmpty.maritalStatus, null);
  console.log("✔ Serializer with null business and status passed");
}

// 2. Test registration payload & validation logic via controller
(async () => {
  let insertedParams = null;
  const mockClient = {
    query: async (sql, params) => {
      if (sql.includes("INSERT INTO members")) {
        insertedParams = params;
        return {
          rowCount: 1,
          rows: [
            {
              id: 101,
              firstName: params[0],
              surname: params[4],
              mobileNumber: params[6],
              business: params[9],
              status: params[10],
              created_at: new Date(),
            },
          ],
        };
      }
      if (sql.includes("SELECT id FROM members\n           WHERE \"mobileNumber\"") || sql.includes("mobileNumber\" = $1")) {
        return { rowCount: 0, rows: [] };
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
    query: async () => ({ rowCount: 0, rows: [] }),
  };

  const ctrl = memberController(mockPool);

  async function callRegister(body, routePath = "/register", role = "USER") {
    let statusCode = 200;
    let responseData = null;
    const req = {
      body,
      file: null,
      route: { path: routePath },
      member: { role },
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
    return { statusCode, responseData };
  }

  const baseValidPayload = {
    firstName: "Priya",
    firstNameEnglish: "Priya",
    middleName: "M",
    middleNameEnglish: "M",
    surname: "Shah",
    surnameEnglish: "Shah",
    mobileNumber: "9825098250",
    countryCode: "+91",
    gender: "Female",
    dateOfBirth: "1998-08-20",
    isOutsideIndia: false,
    password: "password123",
    confirmPassword: "password123",
  };

  // Test self-registration with business and married status
  {
    insertedParams = null;
    const res = await callRegister({
      ...baseValidPayload,
      business: "Textile Business",
      status: "married",
    });

    assert.strictEqual(res.statusCode, 200, "Registration should succeed");
    assert.strictEqual(insertedParams[9], "Textile Business", "business should be inserted at param $10");
    assert.strictEqual(insertedParams[10], "married", "status should be inserted at param $11");
    assert.strictEqual(res.responseData.data.member.business, "Textile Business");
    assert.strictEqual(res.responseData.data.member.status, "married");
    console.log("✔ Self-registration with business and married status passed");
  }

  // Test admin addMember with business and unmarried status
  {
    insertedParams = null;
    const res = await callRegister(
      {
        ...baseValidPayload,
        mobileNumber: "9825098251",
        business: "Education / Teacher",
        status: "Unmarried", // Test uppercase normalization
      },
      "/addMember",
      "ADMIN"
    );

    assert.strictEqual(res.statusCode, 200, "Admin addMember should succeed");
    assert.strictEqual(insertedParams[9], "Education / Teacher", "business should match");
    assert.strictEqual(insertedParams[10], "unmarried", "status should be normalized to lowercase 'unmarried'");
    assert.strictEqual(res.responseData.data.member.business, "Education / Teacher");
    assert.strictEqual(res.responseData.data.member.status, "unmarried");
    console.log("✔ Admin addMember with business and unmarried status passed");
  }

  // Test validation error on invalid status
  {
    const res = await callRegister({
      ...baseValidPayload,
      mobileNumber: "9825098252",
      business: "Shop",
      status: "invalid_status",
    });

    assert.strictEqual(res.statusCode, 400, "Should reject invalid status");
    assert.strictEqual(res.responseData.error, "status must be either 'married' or 'unmarried'");
    console.log("✔ Validation rejects invalid status value");
  }

  // Test registration without business or status (optional backward compatibility)
  {
    insertedParams = null;
    const res = await callRegister({
      ...baseValidPayload,
      mobileNumber: "9825098253",
    });

    assert.strictEqual(res.statusCode, 200, "Registration without optional fields should succeed");
    assert.strictEqual(insertedParams[9], null, "business should be null when omitted");
    assert.strictEqual(insertedParams[10], null, "status should be null when omitted");
    console.log("✔ Registration without business/status defaults to null cleanly");
  }

  // Test profile update validation
  {
    let updatedValues = null;
    const updateMockPool = {
      query: async (sql, params) => {
        if (sql.includes("SELECT id, \"isDeleted\"")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 5,
                mobileNumber: "9825098250",
                countryCode: "+91",
                fatherId: null,
                sonIds: null,
              },
            ],
          };
        }
        if (sql.includes("UPDATE members\n         SET")) {
          updatedValues = params;
          return { rowCount: 1 };
        }
        if (sql.includes("SELECT\n          m.*")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 5,
                firstName: "Priya",
                business: "Retail Shop",
                status: "married",
                dateOfBirth: "1998-08-20",
              },
            ],
          };
        }
        if (sql.includes("SELECT r.id, r.target_id")) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    const updateCtrl = memberController(updateMockPool);

    // Helper to simulate updateMember
    async function testUpdate(body) {
      let statusCode = 200;
      let responseData = null;
      const req = {
        params: { id: "5" },
        body,
        file: null,
        member: { id: 5, role: "USER" },
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
      await updateCtrl.updateMember(req, res);
      return { statusCode, responseData };
    }

    // Valid update
    const validUpdate = await testUpdate({
      business: "Retail Shop",
      status: "married",
    });
    assert.strictEqual(validUpdate.statusCode, 200, "Update member should succeed");
    assert.strictEqual(validUpdate.responseData.data.business, "Retail Shop");
    assert.strictEqual(validUpdate.responseData.data.status, "married");
    console.log("✔ Profile update with business and status passed");

    // Invalid status update
    const invalidUpdate = await testUpdate({
      status: "not_a_valid_status",
    });
    assert.strictEqual(invalidUpdate.statusCode, 400, "Update should reject invalid status");
    assert.strictEqual(invalidUpdate.responseData.error, "status must be either 'married' or 'unmarried'");
    console.log("✔ Profile update rejects invalid status");
  }

  console.log("=== All Business and Status Unit Tests Passed Successfully! ===");
})();
