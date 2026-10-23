const assert = require("assert");
const { memberResponse } = require("../controller/auth.controller");
const {
  memberController,
} = require("../controller/member.controller");

// Mock pool
const mockPool = {
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => {},
  }),
};

console.log("=== Running Secondary Mobile Number and Email Unit Tests ===");

// 1. Test memberResponse serializer
{
  const memberWithBoth = {
    id: 1,
    firstName: "Raj",
    firstNameEnglish: "Raj",
    surname: "Patel",
    surnameEnglish: "Patel",
    mobileNumber: "9876543210",
    secondaryMobileNumber: "+919876543211",
    email: "raj.patel@example.com",
    countryCode: "+91",
    isOutsideIndia: false,
    country: null,
    state: null,
    city: null,
    role: "USER",
    dateOfBirth: "1995-05-15",
    gender: "Male",
    isActive: true,
    isApproved: true,
    photo_url: "/uploads/members/photo.jpg",
    created_at: new Date(),
    updated_at: new Date(),
    isPasswordChange: false,
  };

  const serialized = memberResponse(memberWithBoth);
  assert.strictEqual(serialized.secondaryMobileNumber, "+919876543211");
  assert.strictEqual(serialized.email, "raj.patel@example.com");
  assert.strictEqual(serialized.mobileNumber, "9876543210");
  console.log("✔ Serializer with both fields present passed");

  const memberWithoutOptional = {
    ...memberWithBoth,
    secondaryMobileNumber: null,
    email: null,
  };
  const serializedEmpty = memberResponse(memberWithoutOptional);
  assert.strictEqual(serializedEmpty.secondaryMobileNumber, null);
  assert.strictEqual(serializedEmpty.email, null);
  console.log("✔ Serializer with null optional fields passed");

  // Lowercase fallback check (in case postgres unquoted column)
  const memberWithLowercaseKeys = {
    ...memberWithBoth,
    secondaryMobileNumber: undefined,
    secondarymobilenumber: "+919876543299",
  };
  const serializedFallback = memberResponse(memberWithLowercaseKeys);
  assert.strictEqual(serializedFallback.secondaryMobileNumber, "+919876543299");
  console.log("✔ Serializer fallback from lowercase column passed");
}

// 2. Test registration payload & validation logic via controller endpoint mocks
{
  const ctrl = memberController(mockPool);

  // Helper to simulate register request
  async function testRegister(body) {
    let statusCode = 200;
    let responseData = null;
    const req = {
      body,
      file: null,
      route: { path: "/register" },
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
    firstName: "Aarav",
    firstNameEnglish: "Aarav",
    middleName: "Kumar",
    middleNameEnglish: "Kumar",
    surname: "Shah",
    surnameEnglish: "Shah",
    mobileNumber: "9876543210",
    countryCode: "+91",
    gender: "Male",
    dateOfBirth: "2000-01-01",
    isOutsideIndia: false,
    password: "Password123",
    confirmPassword: "Password123",
  };

  (async () => {
    // Test invalid secondary mobile number
    const resInvalidPhone = await testRegister({
      ...baseValidPayload,
      secondaryMobileNumber: "invalid-phone",
    });
    assert.strictEqual(resInvalidPhone.statusCode, 400);
    assert.match(resInvalidPhone.responseData.error, /secondaryMobileNumber must be a valid mobile number/);
    console.log("✔ Validation rejects invalid secondary mobile number");

    // Test invalid email
    const resInvalidEmail = await testRegister({
      ...baseValidPayload,
      secondaryMobileNumber: "+919876543210",
      email: "not-an-email",
    });
    assert.strictEqual(resInvalidEmail.statusCode, 400);
    assert.strictEqual(resInvalidEmail.responseData.error, "email must be a valid email address");
    console.log("✔ Validation rejects invalid email format");

    // Test email exceeding 150 characters
    const longEmail = "a".repeat(145) + "@test.com";
    const resLongEmail = await testRegister({
      ...baseValidPayload,
      email: longEmail,
    });
    assert.strictEqual(resLongEmail.statusCode, 400);
    assert.match(resLongEmail.responseData.error, /email exceeds maximum length of 150 characters/);
    console.log("✔ Validation rejects email exceeding 150 characters");

    // Helper to simulate updateMember validation
    async function testUpdateMember(body) {
      let statusCode = 200;
      let responseData = null;
      const req = {
        params: { id: "1" },
        member: { id: 1, role: "USER" },
        body,
        file: null,
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

      // Mock pool query for target member
      const updatePool = {
        query: async (sql, params) => {
          if (sql.includes("SELECT id, \"isDeleted\"")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: 1,
                  isDeleted: false,
                  mobileNumber: "9876543210",
                  countryCode: "+91",
                },
              ],
            };
          }
          return { rowCount: 1, rows: [{ id: 1 }] };
        },
      };

      const updateCtrl = memberController(updatePool);
      await updateCtrl.updateMember(req, res);
      return { statusCode, responseData };
    }

    // Test invalid secondary mobile in update
    const resUpdateInvalidPhone = await testUpdateMember({
      secondaryMobileNumber: "bad-number",
    });
    assert.strictEqual(resUpdateInvalidPhone.statusCode, 400);
    assert.match(resUpdateInvalidPhone.responseData.error, /secondaryMobileNumber must be a valid mobile number/);
    console.log("✔ Profile update rejects invalid secondary mobile number");

    // Test invalid email in update
    const resUpdateInvalidEmail = await testUpdateMember({
      email: "bad-email@",
    });
    assert.strictEqual(resUpdateInvalidEmail.statusCode, 400);
    assert.strictEqual(resUpdateInvalidEmail.responseData.error, "email must be a valid email address");
    console.log("✔ Profile update rejects invalid email address");

    console.log("=== All Tests Passed Successfully! ===");
  })().catch((err) => {
    console.error("Test failure:", err);
    process.exit(1);
  });
}
