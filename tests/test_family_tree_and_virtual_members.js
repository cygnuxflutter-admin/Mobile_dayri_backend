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
            fatherId: params[23],
            sonIds: params[22],
            createdBy: params[25],
            hasAppAccess: params[26],
            isClaimed: params[27],
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
            sonIds: params[22],
            fatherId: params[23],
            createdBy: params[25],
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
            fatherId: params[23],
            sonIds: params[22],
            createdBy: params[25],
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

  // 5. Test getFamilyTree hierarchy logic
  {
    // Mock database for multi-generation family:
    // Dada (100)
    //   ├── Father (101)
    //   │     ├── Target User Ravi (102)
    //   │     │     └── Son Aarav (103)
    //   │     └── Brother Suresh (104)
    //   └── Uncle Mansukhbhai (105)
    //
    // Separate member with no father:
    // Orphan Member (200)
    //   ├── Child 1 (201)
    //   └── Child 2 (202)

    const allMembers = [
      {
        id: 100, // Dada (top ancestor)
        firstName: "Tribhovanbhai",
        middleName: "Ramjibhai",
        surname: "Patel",
        fatherId: null,
        sonIds: [101, 105],
        gender: "MALE",
        hasAppAccess: false,
        isDeleted: false,
      },
      {
        id: 101, // Father of Ravi & Suresh
        firstName: "Kishorbhai",
        middleName: "Tribhovanbhai",
        surname: "Patel",
        fatherId: 100,
        sonIds: [102, 104],
        gender: "MALE",
        hasAppAccess: false,
        isDeleted: false,
      },
      {
        id: 105, // Uncle (Father's brother)
        firstName: "Mansukhbhai",
        middleName: "Tribhovanbhai",
        surname: "Patel",
        fatherId: 100,
        sonIds: [],
        gender: "MALE",
        hasAppAccess: false,
        isDeleted: false,
      },
      {
        id: 102, // User Ravi
        firstName: "Ravi",
        middleName: "Kishorbhai",
        surname: "Patel",
        fatherId: 101,
        sonIds: [103],
        gender: "MALE",
        hasAppAccess: true,
        isDeleted: false,
      },
      {
        id: 104, // Brother Suresh
        firstName: "Suresh",
        middleName: "Kishorbhai",
        surname: "Patel",
        fatherId: 101,
        sonIds: [],
        gender: "MALE",
        hasAppAccess: false,
        isDeleted: false,
      },
      {
        id: 103, // Son Aarav
        firstName: "Aarav",
        middleName: "Ravi",
        surname: "Patel",
        fatherId: 102,
        sonIds: [],
        gender: "MALE",
        hasAppAccess: false,
        isDeleted: false,
      },
      {
        id: 200, // Orphan Member (no father)
        firstName: "Nilesh",
        middleName: null,
        surname: "Shah",
        fatherId: null,
        sonIds: [201, 202],
        gender: "MALE",
        hasAppAccess: true,
        isDeleted: false,
      },
      {
        id: 201, // Nilesh's Child 1
        firstName: "Dev",
        middleName: "Nilesh",
        surname: "Shah",
        fatherId: 200,
        sonIds: [],
        gender: "MALE",
        hasAppAccess: false,
        isDeleted: false,
      },
      {
        id: 202, // Nilesh's Child 2
        firstName: "Diya",
        middleName: "Nilesh",
        surname: "Shah",
        fatherId: 200,
        sonIds: [],
        gender: "FEMALE",
        hasAppAccess: false,
        isDeleted: false,
      },
    ];

    const createPool = () => ({
      query: async (sql, params) => {
        if (sql.includes("SELECT id, \"fatherId\" FROM members")) {
          const id = params[0];
          const found = allMembers.find((r) => r.id === id && !r.isDeleted);
          return { rowCount: found ? 1 : 0, rows: found ? [found] : [] };
        }
        if (sql.includes("WITH RECURSIVE family_lineage")) {
          const startId = params[0];
          // Downward traversal from startId
          const result = [];
          const queue = [{ id: startId, level: 1 }];
          const visited = new Set();

          while (queue.length > 0) {
            const { id, level } = queue.shift();
            if (visited.has(id)) continue;
            visited.add(id);

            const m = allMembers.find((r) => r.id === id && !r.isDeleted);
            if (!m) continue;
            result.push({ ...m, level });

            // find children (by fatherId or sonIds)
            const children = allMembers.filter(
              (c) =>
                !c.isDeleted &&
                (c.fatherId === id || (Array.isArray(m.sonIds) && m.sonIds.includes(c.id))),
            );
            for (const child of children) {
              queue.push({ id: child.id, level: level + 1 });
            }
          }
          return { rowCount: result.length, rows: result };
        }
        return { rowCount: 0, rows: [] };
      },
    });

    // 5.1 Scenario 1: Viewing Own Family Tree when :id is provided and equals caller.id
    {
      const ctrl = memberController(createPool());
      const req = { member: { id: 102 }, params: { id: 102 } };
      let status = 0;
      let jsonResp = null;
      await ctrl.getFamilyTree(req, {
        status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
      });

      assert.strictEqual(status, 200);
      assert.strictEqual(jsonResp.status, "success");
      assert.strictEqual(jsonResp.data.targetMemberId, 102);
      assert.strictEqual(jsonResp.data.rootMemberId, 100); // Topmost ancestor Dada
      assert.strictEqual(jsonResp.data.totalMembers, 6); // Dada + Father + Uncle + Ravi + Suresh + Aarav
      assert.strictEqual(jsonResp.data.tree.id, 100);
      assert.strictEqual(jsonResp.data.tree.isTargetUser, false);
      // Verify target user has isTargetUser: true
      const fatherNode = jsonResp.data.tree.children.find((c) => c.id === 101);
      assert(fatherNode);
      const raviNode = fatherNode.children.find((c) => c.id === 102);
      assert(raviNode);
      assert.strictEqual(raviNode.isTargetUser, true);
      console.log("✔ getFamilyTree (Scenario 1): Viewing own tree with :id == caller.id builds full tree from topmost ancestor Dada (100)");
    }

    // 5.2 Scenario 1: Viewing Own Family Tree when :id is NOT provided
    {
      const ctrl = memberController(createPool());
      const req = { member: { id: 102 }, params: {} };
      let status = 0;
      let jsonResp = null;
      await ctrl.getFamilyTree(req, {
        status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
      });

      assert.strictEqual(status, 200);
      assert.strictEqual(jsonResp.status, "success");
      assert.strictEqual(jsonResp.data.targetMemberId, 102);
      assert.strictEqual(jsonResp.data.rootMemberId, 100); // Topmost ancestor Dada
      assert.strictEqual(jsonResp.data.totalMembers, 6);
      console.log("✔ getFamilyTree (Scenario 1): Viewing own tree without :id param defaults to caller and builds complete tree");
    }

    // 5.3 Scenario 2 Case A: Viewing Another Member's Tree who HAS a Father
    {
      const ctrl = memberController(createPool());
      // Caller is stranger (id 999), requesting target Ravi (102)
      const req = { member: { id: 999 }, params: { id: 102 } };
      let status = 0;
      let jsonResp = null;
      await ctrl.getFamilyTree(req, {
        status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
      });

      assert.strictEqual(status, 200);
      assert.strictEqual(jsonResp.status, "success");
      assert.strictEqual(jsonResp.data.targetMemberId, 102);
      assert.strictEqual(jsonResp.data.rootMemberId, 101); // Father Kishorbhai, NOT Dada 100!
      assert.strictEqual(jsonResp.data.totalMembers, 4); // Father(101) + Ravi(102) + Suresh(104) + Aarav(103)

      const tree = jsonResp.data.tree;
      assert.strictEqual(tree.id, 101); // Root is Father
      assert.strictEqual(tree.isTargetUser, false);
      assert.strictEqual(tree.children.length, 2); // Ravi and Brother Suresh

      const targetChild = tree.children.find((c) => c.id === 102);
      assert(targetChild);
      assert.strictEqual(targetChild.isTargetUser, true);
      assert.strictEqual(targetChild.children.length, 1);
      assert.strictEqual(targetChild.children[0].id, 103); // Aarav
      assert.strictEqual(targetChild.children[0].isTargetUser, false);

      const brotherChild = tree.children.find((c) => c.id === 104);
      assert(brotherChild);
      assert.strictEqual(brotherChild.isTargetUser, false);
      assert.strictEqual(brotherChild.children.length, 0);

      // Verify Dada (100) and Uncle Mansukhbhai (105) are NOT in the tree
      assert.strictEqual(tree.children.some((c) => c.id === 100 || c.id === 105), false);
      console.log("✔ getFamilyTree (Scenario 2 Case A): Viewing another member with Father roots at Father (101) and builds downward only (no Dada, no Uncle)");
    }

    // 5.4 Scenario 2 Case B: Viewing Another Member's Tree who DOES NOT HAVE a Father in DB
    {
      const ctrl = memberController(createPool());
      // Caller 999 views target Nilesh (200), who has fatherId = null
      const req = { member: { id: 999 }, params: { id: 200 } };
      let status = 0;
      let jsonResp = null;
      await ctrl.getFamilyTree(req, {
        status: (s) => { status = s; return { json: (j) => { jsonResp = j; } }; },
      });

      assert.strictEqual(status, 200);
      assert.strictEqual(jsonResp.status, "success");
      assert.strictEqual(jsonResp.data.targetMemberId, 200);
      assert.strictEqual(jsonResp.data.rootMemberId, 200); // Fallback: target member himself
      assert.strictEqual(jsonResp.data.totalMembers, 3); // Nilesh (200) + Dev (201) + Diya (202)

      const tree = jsonResp.data.tree;
      assert.strictEqual(tree.id, 200);
      assert.strictEqual(tree.isTargetUser, true);
      assert.strictEqual(tree.children.length, 2);
      assert.strictEqual(tree.children[0].id, 201);
      assert.strictEqual(tree.children[1].id, 202);
      console.log("✔ getFamilyTree (Scenario 2 Case B): Viewing another member without Father roots at target member himself");
    }

    // 5.5 Error handling: Invalid or non-existent member ID returns 404
    {
      const ctrl = memberController(createPool());

      // Non-existent ID
      const reqNotFound = { member: { id: 999 }, params: { id: 8888 } };
      let status404 = 0;
      let json404 = null;
      await ctrl.getFamilyTree(reqNotFound, {
        status: (s) => { status404 = s; return { json: (j) => { json404 = j; } }; },
      });
      assert.strictEqual(status404, 404);
      assert.strictEqual(json404.error, "Member not found");

      // Invalid ID string
      const reqInvalid = { member: { id: 999 }, params: { id: "invalid_id" } };
      let statusInv = 0;
      let jsonInv = null;
      await ctrl.getFamilyTree(reqInvalid, {
        status: (s) => { statusInv = s; return { json: (j) => { jsonInv = j; } }; },
      });
      assert.strictEqual(statusInv, 404);
      assert.strictEqual(jsonInv.error, "Member not found");

      // Unauthorized caller
      const reqUnauth = { member: null, params: {} };
      let statusUnauth = 0;
      await ctrl.getFamilyTree(reqUnauth, {
        status: (s) => { statusUnauth = s; return { json: () => {} }; },
      });
      assert.strictEqual(statusUnauth, 401);

      console.log("✔ getFamilyTree (Error Handling): Invalid/non-existent IDs return 404 and unauthorized callers return 401");
    }

    // 5.6 Sorting logic: DOB oldest-to-youngest first, then missing/invalid DOB by created_at ascending, recursively across all levels
    {
      const sortingMembers = [
        {
          id: 300, // User A (Father)
          firstName: "UserA",
          surname: "Patel",
          fatherId: null,
          sonIds: [301, 302, 303, 304, 305],
          dateOfBirth: "1965-01-01",
          created_at: "2025-01-01T00:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        {
          id: 301, // SON 1 => DOB attached (youngest of DOB group, DD-MM-YYYY format)
          firstName: "Son1",
          surname: "Patel",
          fatherId: 300,
          sonIds: [311, 312, 313, 314],
          dateOfBirth: "15-03-1995",
          created_at: "2026-01-01T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        {
          id: 302, // SON 2 => DOB attached (oldest)
          firstName: "Son2",
          surname: "Patel",
          fatherId: 300,
          sonIds: [321, 322],
          dateOfBirth: "1990-07-20",
          created_at: "2026-01-02T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        {
          id: 303, // SON 3 => DOB NOT attached (empty string, created later)
          firstName: "Son3",
          surname: "Patel",
          fatherId: 300,
          sonIds: [],
          dateOfBirth: "",
          created_at: "2026-01-05T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        {
          id: 304, // SON 4 => DOB NOT attached (null, created earlier)
          firstName: "Son4",
          surname: "Patel",
          fatherId: 300,
          sonIds: [],
          dateOfBirth: null,
          created_at: "2026-01-03T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        {
          id: 305, // SON 5 => DOB attached (middle age)
          firstName: "Son5",
          surname: "Patel",
          fatherId: 300,
          sonIds: [],
          dateOfBirth: "1992-11-01",
          created_at: "2026-01-04T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        // Grandsons under SON 1 (301)
        {
          id: 311, // No DOB, created later
          firstName: "GS1_NoDobLate",
          surname: "Patel",
          fatherId: 301,
          sonIds: [],
          dateOfBirth: "",
          created_at: "2026-03-10T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        {
          id: 312, // DOB younger
          firstName: "GS1_Younger",
          surname: "Patel",
          fatherId: 301,
          sonIds: [],
          dateOfBirth: "2020-05-10",
          created_at: "2026-03-01T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        {
          id: 313, // Invalid DOB -> treated as missing DOB, created earlier than 311
          firstName: "GS1_InvalidDobEarly",
          surname: "Patel",
          fatherId: 301,
          sonIds: [],
          dateOfBirth: "31-02-2019",
          created_at: "2026-03-05T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        {
          id: 314, // DOB older
          firstName: "GS1_Older",
          surname: "Patel",
          fatherId: 301,
          sonIds: [],
          dateOfBirth: "10/01/2018",
          created_at: "2026-03-08T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        // Twins under SON 2 (302) -> same DOB, tie-break by created_at ascending
        {
          id: 321,
          firstName: "TwinLaterCreated",
          surname: "Patel",
          fatherId: 302,
          sonIds: [],
          dateOfBirth: "2015-06-15",
          created_at: "2026-02-02T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
        {
          id: 322,
          firstName: "TwinEarlierCreated",
          surname: "Patel",
          fatherId: 302,
          sonIds: [],
          dateOfBirth: "15-06-2015",
          created_at: "2026-02-01T10:00:00Z",
          gender: "MALE",
          isDeleted: false,
        },
      ];

      const sortingPool = {
        query: async (sql, params) => {
          if (sql.includes("SELECT id, \"fatherId\" FROM members")) {
            const id = params[0];
            const found = sortingMembers.find((r) => r.id === id && !r.isDeleted);
            return { rowCount: found ? 1 : 0, rows: found ? [found] : [] };
          }
          if (sql.includes("WITH RECURSIVE family_lineage")) {
            assert(sql.includes('m."created_at"') && sql.includes('c."created_at"'));
            const startId = params[0];
            const result = [];
            const queue = [{ id: startId, level: 1 }];
            const visited = new Set();

            while (queue.length > 0) {
              const { id, level } = queue.shift();
              if (visited.has(id)) continue;
              visited.add(id);

              const m = sortingMembers.find((r) => r.id === id && !r.isDeleted);
              if (!m) continue;
              result.push({ ...m, level });

              const children = sortingMembers.filter(
                (c) =>
                  !c.isDeleted &&
                  (c.fatherId === id || (Array.isArray(m.sonIds) && m.sonIds.includes(c.id))),
              );
              for (const child of children) {
                queue.push({ id: child.id, level: level + 1 });
              }
            }
            return { rowCount: result.length, rows: result };
          }
          if (sql.includes('FROM members WHERE id = $1 AND COALESCE("isDeleted", false) = false LIMIT 1')) {
            const found = sortingMembers.find((r) => r.id === params[0] && !r.isDeleted);
            return { rowCount: found ? 1 : 0, rows: found ? [found] : [] };
          }
          if (sql.includes("FROM members WHERE id = ANY($1)")) {
            const ids = params[0];
            const rows = sortingMembers.filter((r) => ids.includes(r.id) && !r.isDeleted);
            return { rowCount: rows.length, rows };
          }
          return { rowCount: 0, rows: [] };
        },
      };

      const ctrl = memberController(sortingPool);

      // Test getFamilyTree recursive sorting
      const reqTree = { member: { id: 300 }, params: {} };
      let statusTree = 0;
      let jsonTree = null;
      await ctrl.getFamilyTree(reqTree, {
        status: (s) => { statusTree = s; return { json: (j) => { jsonTree = j; } }; },
      });

      assert.strictEqual(statusTree, 200);
      const tree = jsonTree.data.tree;
      assert.strictEqual(tree.id, 300);

      // Level 1 sons: DOB oldest->youngest (302 [1990], 305 [1992], 301 [1995]), then no-DOB created_at ASC (304 [Jan 3], 303 [Jan 5])
      assert.deepStrictEqual(
        tree.children.map((c) => c.id),
        [302, 305, 301, 304, 303],
      );

      // Level 2 under Son 2 (302): same DOB tie-break by created_at ASC -> 322 then 321
      const son2Node = tree.children[0];
      assert.deepStrictEqual(
        son2Node.children.map((c) => c.id),
        [322, 321],
      );

      // Level 2 under Son 1 (301): DOB oldest->youngest (314 [2018], 312 [2020]), then invalid/missing DOB by created_at ASC (313 [Mar 5], 311 [Mar 10])
      const son1Node = tree.children[2];
      assert.deepStrictEqual(
        son1Node.children.map((c) => c.id),
        [314, 312, 313, 311],
      );

      console.log("✔ getFamilyTree (Sorting): Sons and grandchildren sorted oldest-to-youngest by DOB first, then missing/invalid DOB by created_at ascending");

      // Test getMyFamily sons sorting matches the same logic
      const reqMyFamily = { member: { id: 300 } };
      let statusMyFamily = 0;
      let jsonMyFamily = null;
      await ctrl.getMyFamily(reqMyFamily, {
        status: (s) => { statusMyFamily = s; return { json: (j) => { jsonMyFamily = j; } }; },
      });

      assert.strictEqual(statusMyFamily, 200);
      assert.deepStrictEqual(
        jsonMyFamily.data.sons.map((s) => s.id),
        [302, 305, 301, 304, 303],
      );
      console.log("✔ getMyFamily (Sorting): Direct sons sorted consistently by DOB oldest-to-youngest then created_at ascending");
    }
  }

  console.log("\n ALL TESTS PASSED SUCCESSFULLY! ✨");
})();
