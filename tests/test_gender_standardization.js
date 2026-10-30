const assert = require("assert");
const { memberResponse } = require("../controller/auth.controller");
const { memberController } = require("../controller/member.controller");

console.log("=== Running Gender Standardization Unit Tests ===");

// 1. Test Serializers output uppercase gender
{
  const mockMember = {
    id: 1,
    firstName: "Ramesh",
    surname: "Patel",
    mobileNumber: "9876543210",
    gender: "Male", // lowercase/mixed from old DB
    dateOfBirth: "1990-01-01",
  };

  const serialized = memberResponse(mockMember);
  assert.strictEqual(serialized.gender, "MALE", "memberResponse must return uppercase MALE");
  console.log("✔ Serializer: memberResponse normalizes gender to uppercase 'MALE'");

  const femaleMember = {
    ...mockMember,
    gender: "female",
  };
  const serializedFemale = memberResponse(femaleMember);
  assert.strictEqual(serializedFemale.gender, "FEMALE", "memberResponse must return uppercase FEMALE");
  console.log("✔ Serializer: memberResponse normalizes gender to uppercase 'FEMALE'");
}

// 2. Test registration & update validation
(async () => {
  const mockPool = {
    query: async () => ({ rowCount: 0, rows: [] }),
    connect: async () => ({
      query: async () => ({ rowCount: 0, rows: [] }),
      release: () => {},
    }),
  };

  const controller = memberController(mockPool);

  // 2.1 Registration with invalid gender rejected
  {
    const req = {
      body: {
        firstName: "Test",
        firstNameEnglish: "Test",
        middleName: "User",
        middleNameEnglish: "User",
        surname: "Patel",
        surnameEnglish: "Patel",
        mobileNumber: "9876543210",
        countryCode: "+91",
        dateOfBirth: "1990-01-01",
        password: "password123",
        confirmPassword: "password123",
        gender: "InvalidGender",
      },
    };

    let status = 0;
    let jsonResp = null;
    await controller.register(req, {
      status: (s) => {
        status = s;
        return {
          json: (j) => {
            jsonResp = j;
          },
        };
      },
    });

    assert.strictEqual(status, 400);
    assert(jsonResp.error.includes("MALE") && jsonResp.error.includes("FEMALE"));
    console.log("✔ Validation: Registration rejects invalid gender");
  }

  // 2.2 Profile update with invalid gender rejected
  {
    const req = {
      member: { id: 1, role: "USER" },
      params: { id: 1 },
      body: {
        gender: "Other",
      },
    };

    let status = 0;
    let jsonResp = null;
    const mockPoolForUpdate = {
      query: async (sql) => {
        if (sql.includes("FROM members") && sql.includes("WHERE id = $1")) {
          return {
            rowCount: 1,
            rows: [{ id: 1, createdBy: 1, isDeleted: false, mobileNumber: "9876543210", countryCode: "+91", fatherId: null, sonIds: [] }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    const ctrlUpdate = memberController(mockPoolForUpdate);
    await ctrlUpdate.updateMember(req, {
      status: (s) => {
        status = s;
        return {
          json: (j) => {
            jsonResp = j;
          },
        };
      },
    });

    assert.strictEqual(status, 400);
    assert(jsonResp.error.includes("MALE") && jsonResp.error.includes("FEMALE"));
    console.log("✔ Validation: updateMember rejects invalid gender");
  }

  // 2.3 Registration with mixed case 'Male' auto-normalizes to 'MALE'
  {
    let insertedGender = null;
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes("INSERT INTO members")) {
          insertedGender = params[13]; // gender parameter index
          return {
            rowCount: 1,
            rows: [
              {
                id: 100,
                firstName: "Test",
                gender: insertedGender,
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    };

    const poolRegister = {
      query: async (sql) => {
        if (sql.includes("mobileNumber")) return { rowCount: 0, rows: [] };
        if (sql.includes("FROM members WHERE id = $1")) {
          return {
            rowCount: 1,
            rows: [{ id: 100, firstName: "Test", gender: insertedGender }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
      connect: async () => mockClient,
    };

    const ctrlReg = memberController(poolRegister);
    const reqReg = {
      body: {
        firstName: "Test",
        firstNameEnglish: "Test",
        middleName: "User",
        middleNameEnglish: "User",
        surname: "Patel",
        surnameEnglish: "Patel",
        mobileNumber: "9876543210",
        countryCode: "+91",
        dateOfBirth: "1990-01-01",
        password: "password123",
        confirmPassword: "password123",
        gender: "Male", // sent as mixed case
      },
    };

    let status = 0;
    let jsonResp = null;
    await ctrlReg.register(reqReg, {
      status: (s) => {
        status = s;
        return {
          json: (j) => {
            jsonResp = j;
          },
        };
      },
    });

    assert(status === 200 || status === 201);
    assert.strictEqual(insertedGender, "MALE", "Inserted gender into DB must be uppercase MALE");
    console.log("✔ Normalization: Mixed case 'Male' automatically converted to uppercase 'MALE' in DB");
  }

  console.log("\n ALL GENDER STANDARDIZATION TESTS PASSED! ✨");
})();
