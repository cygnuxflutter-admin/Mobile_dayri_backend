const assert = require("assert");
const { memberResponse, authController } = require("../controller/auth.controller");
const { memberController } = require("../controller/member.controller");

console.log("=== Running Family Tree and Virtual Member (No Mobile) Unit Tests ===");

// 1. Test memberResponse serializer for createdBy, hasAppAccess, isClaimed
{
  const member = {
    id: 10,
    firstName: "Dadaji",
    firstNameEnglish: "Dadaji",
    middleName: null,
    middleNameEnglish: null,
    surname: "Patel",
    surnameEnglish: "Patel",
    mobileNumber: null,
    countryCode: "+91",
    isOutsideIndia: false,
    role: "USER",
    dateOfBirth: "1950-01-01",
    gender: "MALE",
    isActive: true,
    isApproved: true,
    photo_url: null,
    created_at: new Date(),
    updated_at: new Date(),
    isPasswordChange: false,
    createdBy: 1,
    hasAppAccess: false,
    isClaimed: false,
  };

  const serialized = memberResponse(member);
  assert.strictEqual(serialized.createdBy, 1);
  assert.strictEqual(serialized.hasAppAccess, false);
  assert.strictEqual(serialized.isClaimed, false);
  assert.strictEqual(serialized.mobileNumber, null);
  console.log("✔ Serializer: memberResponse correctly includes createdBy, hasAppAccess, isClaimed");
}

// 2. Test addFamilyMember validations
(async () => {
  const mockPool = {
    query: async () => ({ rowCount: 0, rows: [] }),
    connect: async () => ({
      query: async () => ({ rowCount: 0, rows: [] }),
      release: () => {},
    }),
  };

  const controller = memberController(mockPool);

  // 2.1 Unauthorized caller
  {
    const req = { member: null, body: {} };
    let status = 0;
    let jsonResp = null;
    const res = {
      status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
    };

    await controller.addFamilyMember(req, res);
    assert.strictEqual(status, 401);
    console.log("✔ addFamilyMember: Unauthorized caller rejected");
  }

  // 2.2 Invalid relationshipType
  {
    const req = { member: { id: 1 }, body: { relationshipType: "COUSIN", firstName: "Rahul" } };
    let status = 0;
    let jsonResp = null;
    const res = {
      status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
    };

    await controller.addFamilyMember(req, res);
    assert.strictEqual(status, 400);
    assert(jsonResp.error.includes("FATHER") && jsonResp.error.includes("SON"));
    console.log("✔ addFamilyMember: Invalid relationshipType rejected");
  }

  // 2.3 Missing firstName
  {
    const req = { member: { id: 1 }, body: { relationshipType: "SON" } };
    let status = 0;
    let jsonResp = null;
    const res = {
      status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
    };

    await controller.addFamilyMember(req, res);
    assert.strictEqual(status, 400);
    assert(jsonResp.error.includes("firstName"));
    console.log("✔ addFamilyMember: Missing firstName rejected");
  }

  // 2.4 Duplicate Father check
  {
    const poolWithFather = {
      query: async (sql) => {
        if (sql.includes("FROM members WHERE id = $1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 1,
                firstName: "UserA",
                surname: "Patel",
                fatherId: 5, // already has father
                sonIds: [],
              },
            ],
          };
        }
        if (sql.includes("WHERE id = $1 LIMIT 1")) {
          return {
            rowCount: 1,
            rows: [{ firstName: "ExistingFather", surname: "Patel" }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    const ctrlWithFather = memberController(poolWithFather);
    const req = {
      member: { id: 1 },
      body: { relationshipType: "FATHER", firstName: "NewFather", surname: "Patel" },
    };
    let status = 0;
    let jsonResp = null;
    const res = {
      status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
    };

    await ctrlWithFather.addFamilyMember(req, res);
    assert.strictEqual(status, 400);
    assert(jsonResp.error.includes("already have a Father"));
    console.log("✔ addFamilyMember: Cannot add second Father when one exists");
  }

  // 2.5 Success adding Son without mobile number
  {
    let insertedMember = null;
    let updatedCallerSql = null;
    let updatedCallerParams = null;

    const mockClient = {
      query: async (sql, params) => {
        if (sql === "BEGIN" || sql === "COMMIT") return {};
        if (sql.includes("INSERT INTO members")) {
          insertedMember = {
            id: 20,
            firstName: params[0],
            middleName: params[2],
            surname: params[4],
            mobileNumber: params[6],
            fatherId: params[22],
            sonIds: params[21],
            createdBy: params[24],
            hasAppAccess: params[25],
            isClaimed: params[26],
            created_at: new Date(),
          };
          return { rowCount: 1, rows: [insertedMember] };
        }
        if (sql.includes("UPDATE members") && sql.includes("sonIds")) {
          updatedCallerSql = sql;
          updatedCallerParams = params;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    };

    const poolAddSon = {
      query: async (sql, params) => {
        if (sql.includes("FROM members WHERE id = $1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 1,
                firstName: "UserA",
                firstNameEnglish: "UserA",
                surname: "Patel",
                surnameEnglish: "Patel",
                fatherId: null,
                sonIds: [],
                city: "Surat",
                state: "Gujarat",
                country: "India",
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
      connect: async () => mockClient,
    };

    const ctrlAddSon = memberController(poolAddSon);
    const req = {
      member: { id: 1 },
      body: {
        relationshipType: "SON",
        firstName: "Chintu",
        // no mobileNumber provided!
      },
    };
    let status = 0;
    let jsonResp = null;
    const res = {
      status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
    };

    await ctrlAddSon.addFamilyMember(req, res);
    assert.strictEqual(status, 201);
    assert.strictEqual(jsonResp.data.firstName, "Chintu");
    assert.strictEqual(jsonResp.data.middleName, "UserA"); // auto-inherited father's first name
    assert.strictEqual(jsonResp.data.surname, "Patel"); // auto-inherited surname
    assert.strictEqual(jsonResp.data.mobileNumber, null);
    assert.strictEqual(jsonResp.data.hasAppAccess, false);
    assert.strictEqual(jsonResp.data.createdBy, 1);
    assert.strictEqual(jsonResp.data.fatherId, 1);
    assert(updatedCallerParams.includes(20)); // new member ID appended to caller's sonIds
    console.log("✔ addFamilyMember: Added Son without mobile, auto-inherited middleName & surname, linked fatherId & sonIds");
  }

  // 2.6 Test adding Grandfather via relationshipType = "GRANDFATHER"
  {
    // Case A: Fails if caller has no father yet
    const poolNoFather = {
      query: async () => ({
        rowCount: 1,
        rows: [{ id: 1, firstName: "UserA", surname: "Patel", fatherId: null, sonIds: [] }],
      }),
    };
    const ctrlNoFather = memberController(poolNoFather);
    const reqGFNoFather = {
      member: { id: 1 },
      body: { relationshipType: "GRANDFATHER", firstName: "Dada" },
    };
    let statusA = 0;
    let jsonA = null;
    await ctrlNoFather.addFamilyMember(reqGFNoFather, {
      status: (s) => { statusA = s; return { json: (j) => { jsonA = j; } }; },
    });
    assert.strictEqual(statusA, 400);
    assert(jsonA.error.includes("add your Father first"));
    console.log("✔ addFamilyMember: Rejects GRANDFATHER if Father is not added yet");

    // Case B: Succeeds if caller has a father -> links to Father
    let insertedDada = null;
    let updatedFatherSql = null;
    let updatedFatherParams = null;
    const clientGF = {
      query: async (sql, params) => {
        if (sql === "BEGIN" || sql === "COMMIT") return {};
        if (sql.includes("INSERT INTO members")) {
          insertedDada = {
            id: 50,
            firstName: params[0],
            surname: params[4],
            sonIds: params[21],
            fatherId: params[22],
            createdBy: params[24],
            hasAppAccess: false,
          };
          return { rowCount: 1, rows: [insertedDada] };
        }
        if (sql.includes("UPDATE members SET \"fatherId\" = $1")) {
          updatedFatherSql = sql;
          updatedFatherParams = params;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    };

    const poolWithFatherGF = {
      query: async (sql, params) => {
        if (sql.includes("FROM members WHERE id = $1")) {
          if (params[0] === 1) {
            return {
              rowCount: 1,
              rows: [{ id: 1, firstName: "UserA", surname: "Patel", fatherId: 10, sonIds: [] }],
            };
          }
          if (params[0] === 10) {
            // Father record
            return {
              rowCount: 1,
              rows: [{ id: 10, firstName: "Kishorbhai", surname: "Patel", fatherId: null, sonIds: [1], createdBy: 1 }],
            };
          }
        }
        return { rowCount: 0, rows: [] };
      },
      connect: async () => clientGF,
    };

    const ctrlWithFatherGF = memberController(poolWithFatherGF);
    const reqGF = {
      member: { id: 1 },
      body: { relationshipType: "GRANDFATHER", firstName: "Tribhovanbhai" },
    };
    let statusB = 0;
    let jsonB = null;
    await ctrlWithFatherGF.addFamilyMember(reqGF, {
      status: (s) => { statusB = s; return { json: (j) => { jsonB = j; } }; },
    });
    assert.strictEqual(statusB, 201);
    assert.strictEqual(jsonB.data.firstName, "Tribhovanbhai");
    assert.strictEqual(jsonB.data.surname, "Patel");
    assert.strictEqual(insertedDada.sonIds[0], 10); // Dada's son is Father (10)
    assert.strictEqual(updatedFatherParams[0], 50); // Father's fatherId updated to Dada (50)
    assert.strictEqual(updatedFatherParams[1], 10); // Target is Father (10)
    console.log("✔ addFamilyMember: Added Grandfather via 'GRANDFATHER' shortcut, automatically linked as Father of Father");
  }

  // 2.7 Test adding Brother via forMemberId = fatherId and relationshipType = "SON"
  {
    let insertedBrother = null;
    let updatedFatherParams = null;
    const clientBrother = {
      query: async (sql, params) => {
        if (sql === "BEGIN" || sql === "COMMIT") return {};
        if (sql.includes("INSERT INTO members")) {
          insertedBrother = {
            id: 60,
            firstName: params[0],
            middleName: params[2],
            surname: params[4],
            fatherId: params[22],
            sonIds: params[21],
            createdBy: params[24],
            hasAppAccess: false,
          };
          return { rowCount: 1, rows: [insertedBrother] };
        }
        if (sql.includes("UPDATE members") && sql.includes("sonIds")) {
          updatedFatherParams = params;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    };

    const poolBrother = {
      query: async (sql, params) => {
        if (sql.includes("FROM members WHERE id = $1")) {
          if (params[0] === 1) {
            return {
              rowCount: 1,
              rows: [{ id: 1, firstName: "UserA", surname: "Patel", fatherId: 10, sonIds: [] }],
            };
          }
          if (params[0] === 10) {
            return {
              rowCount: 1,
              rows: [{ id: 10, firstName: "Kishorbhai", surname: "Patel", fatherId: 50, sonIds: [1], createdBy: 1 }],
            };
          }
        }
        return { rowCount: 0, rows: [] };
      },
      connect: async () => clientBrother,
    };

    const ctrlBrother = memberController(poolBrother);
    const reqBrother = {
      member: { id: 1 },
      body: {
        forMemberId: 10, // Father
        relationshipType: "SON", // Son of father = brother of User A
        firstName: "Suresh",
      },
    };
    let statusC = 0;
    let jsonC = null;
    await ctrlBrother.addFamilyMember(reqBrother, {
      status: (s) => { statusC = s; return { json: (j) => { jsonC = j; } }; },
    });
    assert.strictEqual(statusC, 201);
    assert.strictEqual(jsonC.data.firstName, "Suresh");
    assert.strictEqual(jsonC.data.middleName, "Kishorbhai"); // Auto-inherited Father's name
    assert.strictEqual(jsonC.data.fatherId, 10); // Linked to Father
    assert.strictEqual(updatedFatherParams[0], 60); // Father's sonIds gets Suresh (60)
    console.log("✔ addFamilyMember: Added Brother via forMemberId=<fatherId> and relation='SON'");
  }

  // 3. Test grantAppAccess
  {
    // 3.1 Permission denied for non-guardian
    const poolGrant = {
      query: async (sql, params) => {
        if (sql.includes("FROM members WHERE id = $1 LIMIT 1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 20,
                firstName: "Chintu",
                createdBy: 1, // created by user 1
                fatherId: 1,
                hasAppAccess: false,
                mobileNumber: null,
                isDeleted: false,
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    const ctrlGrant = memberController(poolGrant);

    // Stranger (user 99) tries to grant access
    const reqDenied = {
      member: { id: 99, role: "USER" },
      params: { id: 20 },
      body: { mobileNumber: "9876543210", password: "password123" },
    };
    let statusDenied = 0;
    let jsonDenied = null;
    const resDenied = {
      status: (s) => { statusDenied = s; return { json: (j) => { jsonDenied = j; } }; },
    };

    await ctrlGrant.grantAppAccess(reqDenied, resDenied);
    assert.strictEqual(statusDenied, 403);
    console.log("✔ grantAppAccess: Stranger denied permission");

    // 3.2 Guardian (user 1) successfully grants access
    let updatedTarget = null;
    const poolGrantSuccess = {
      query: async (sql, params) => {
        if (sql.includes("FROM members WHERE id = $1 LIMIT 1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 20,
                firstName: "Chintu",
                createdBy: 1,
                fatherId: 1,
                hasAppAccess: false,
                mobileNumber: null,
                isDeleted: false,
              },
            ],
          };
        }
        if (sql.includes("FROM members WHERE \"mobileNumber\" = $1")) {
          return { rowCount: 0, rows: [] }; // no duplicate mobile
        }
        if (sql.includes("UPDATE members")) {
          updatedTarget = {
            id: 20,
            firstName: "Chintu",
            mobileNumber: params[0],
            countryCode: params[1],
            passwordHash: params[2],
            hasAppAccess: true,
            isClaimed: true,
            isPasswordChange: true,
          };
          return { rowCount: 1, rows: [updatedTarget] };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    const ctrlGrantSuccess = memberController(poolGrantSuccess);
    const reqSuccess = {
      member: { id: 1, role: "USER" },
      params: { id: 20 },
      body: { mobileNumber: "9876543210", password: "password123" },
    };
    let statusSuccess = 0;
    let jsonSuccess = null;
    const resSuccess = {
      status: (s) => { statusSuccess = s; return { json: (j) => { jsonSuccess = j; } }; },
    };

    await ctrlGrantSuccess.grantAppAccess(reqSuccess, resSuccess);
    assert.strictEqual(statusSuccess, 200);
    assert.strictEqual(jsonSuccess.data.mobileNumber, "9876543210");
    assert.strictEqual(jsonSuccess.data.hasAppAccess, true);
    assert.strictEqual(jsonSuccess.data.isPasswordChange, true);
    console.log("✔ grantAppAccess: Guardian successfully assigned mobile number and password");
  }

  // 4. Test login block when hasAppAccess === false
  {
    const poolLogin = {
      query: async (sql) => {
        if (sql.includes("FROM members")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 30,
                firstName: "Dada",
                mobileNumber: "9999999999",
                countryCode: "+91",
                passwordHash: "$2a$10$abcdefghijklmnopqrstuu",
                hasAppAccess: false, // NO app access
                isDeleted: false,
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    const auth = authController(poolLogin);
    const req = {
      body: {
        mobileNumber: "9999999999",
        countryCode: "+91",
        password: "anyPassword",
      },
    };
    let status = 0;
    let jsonResp = null;
    const res = {
      status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
    };

    await auth.login(req, res);
    assert.strictEqual(status, 403);
    assert(jsonResp.error.includes("App access is not enabled"));
    console.log("✔ auth.login: Member with hasAppAccess=false blocked from login");
  }

  // 5. Test getFamilyTree builds hierarchical structure
  {
    const mockLineageRows = [
      {
        id: 100, // Dada (root)
        firstName: "Tribhovanbhai",
        middleName: "Ramjibhai",
        surname: "Patel",
        fatherId: null,
        sonIds: [101],
        hasAppAccess: false,
        level: 1,
      },
      {
        id: 101, // Father
        firstName: "Kishorbhai",
        middleName: "Tribhovanbhai",
        surname: "Patel",
        fatherId: 100,
        sonIds: [102],
        hasAppAccess: false,
        level: 2,
      },
      {
        id: 102, // User A
        firstName: "Ravi",
        middleName: "Kishorbhai",
        surname: "Patel",
        fatherId: 101,
        sonIds: [103],
        hasAppAccess: true,
        level: 3,
      },
      {
        id: 103, // Son
        firstName: "Aarav",
        middleName: "Ravi",
        surname: "Patel",
        fatherId: 102,
        sonIds: [],
        hasAppAccess: false,
        level: 4,
      },
    ];

    const poolTree = {
      query: async (sql, params) => {
        if (sql.includes("SELECT id, \"fatherId\" FROM members")) {
          // Parent traversal
          const id = params[0];
          const found = mockLineageRows.find((r) => r.id === id);
          return { rowCount: found ? 1 : 0, rows: found ? [found] : [] };
        }
        if (sql.includes("WITH RECURSIVE family_lineage")) {
          return { rowCount: mockLineageRows.length, rows: mockLineageRows };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    const ctrlTree = memberController(poolTree);
    const req = { member: { id: 102 }, params: { id: 102 } };
    let status = 0;
    let jsonResp = null;
    const res = {
      status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
    };

    await ctrlTree.getFamilyTree(req, res);
    assert.strictEqual(status, 200);
    const tree = jsonResp.data.tree;
    assert.strictEqual(tree.id, 100); // root is Tribhovanbhai
    assert.strictEqual(tree.children.length, 1);
    assert.strictEqual(tree.children[0].id, 101); // Kishorbhai
    assert.strictEqual(tree.children[0].children.length, 1);
    assert.strictEqual(tree.children[0].children[0].id, 102); // Ravi (isTargetUser=true)
    assert.strictEqual(tree.children[0].children[0].isTargetUser, true);
    assert.strictEqual(tree.children[0].children[0].children[0].id, 103); // Aarav
    console.log("✔ getFamilyTree: Perfectly built 4-generation hierarchy (Dada -> Father -> User A -> Son)");
  }

  console.log("\n ALL TESTS PASSED SUCCESSFULLY! ✨");
})();
