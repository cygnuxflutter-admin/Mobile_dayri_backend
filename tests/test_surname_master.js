const assert = require("assert");
const { surnameController } = require("../controller/surname.controller");

console.log("=== Running Surname Master CRUD Unit Tests ===");

(async () => {
  let surnamesTable = [];
  let nextId = 1;

  const mockPool = {
    query: async (sql, params = []) => {
      // 1. Duplicate check in createSurname
      if (sql.includes("FROM surnames") && sql.includes("LOWER(TRIM(\"surnameEnglish\")) = LOWER($1)")) {
        const eng = String(params[0]).toLowerCase().trim();
        const guj = String(params[1]).trim();
        const found = surnamesTable.find(
          (s) =>
            !s.isDeleted &&
            (s.surnameEnglish.toLowerCase().trim() === eng || s.surname.trim() === guj),
        );
        return { rowCount: found ? 1 : 0, rows: found ? [found] : [] };
      }

      // 2. Insert into surnames
      if (sql.includes("INSERT INTO surnames")) {
        const newRecord = {
          id: nextId++,
          surname: params[0],
          surnameEnglish: params[1],
          isActive: params[2] ?? true,
          isDeleted: params[3] ?? false,
          created_at: new Date(),
          updated_at: new Date(),
        };
        surnamesTable.push(newRecord);
        return { rowCount: 1, rows: [newRecord] };
      }

      // 3. Get all surnames
      if (sql.includes("FROM surnames s") && !sql.includes("s.id = $1")) {
        let results = surnamesTable.filter((s) => !s.isDeleted);
        if (sql.includes("s.\"isActive\" = $")) {
          const activeFilter = params[0];
          results = results.filter((s) => s.isActive === activeFilter);
        }
        if (sql.includes("ILIKE")) {
          const searchParam = String(params[params.length - 1]).replace(/%/g, "").toLowerCase();
          results = results.filter(
            (s) =>
              s.surnameEnglish.toLowerCase().includes(searchParam) ||
              s.surname.toLowerCase().includes(searchParam),
          );
        }
        return {
          rowCount: results.length,
          rows: results.map((r) => ({ ...r, memberCount: 0 })),
        };
      }

      // 4. Get by ID
      if (sql.includes("FROM surnames") && sql.includes("id = $1")) {
        const id = Number(params[0]);
        const found = surnamesTable.find((s) => s.id === id && !s.isDeleted);
        return { rowCount: found ? 1 : 0, rows: found ? [{ ...found, memberCount: 0 }] : [] };
      }

      // 5. Update duplicate check
      if (sql.includes("FROM surnames") && sql.includes("id != $1")) {
        const id = Number(params[0]);
        const eng = String(params[1]).toLowerCase().trim();
        const guj = String(params[2]).trim();
        const found = surnamesTable.find(
          (s) =>
            s.id !== id &&
            !s.isDeleted &&
            (s.surnameEnglish.toLowerCase().trim() === eng || s.surname.trim() === guj),
        );
        return { rowCount: found ? 1 : 0, rows: found ? [found] : [] };
      }

      // 6. Update surname
      if (sql.includes("UPDATE surnames") && !sql.includes("isDeleted\" = TRUE")) {
        const id = Number(params[3]);
        const found = surnamesTable.find((s) => s.id === id);
        if (found) {
          if (params[0] !== null) found.surname = params[0];
          if (params[1] !== null) found.surnameEnglish = params[1];
          if (params[2] !== null) found.isActive = params[2];
          found.updated_at = new Date();
          return { rowCount: 1, rows: [found] };
        }
        return { rowCount: 0, rows: [] };
      }

      // 7. Delete surname
      if (sql.includes("UPDATE surnames") && sql.includes("isDeleted\" = TRUE")) {
        const id = Number(params[0]);
        const found = surnamesTable.find((s) => s.id === id);
        if (found) {
          found.isDeleted = true;
          found.isActive = false;
          return { rowCount: 1, rows: [found] };
        }
        return { rowCount: 0, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    },
    connect: async () => ({
      query: mockPool.query,
      release: () => {},
    }),
  };

  const controller = surnameController(mockPool);

  // Helper response mock
  function createMockRes() {
    let statusCode = 200;
    let jsonBody = null;
    return {
      res: {
        status: (s) => {
          statusCode = s;
          return {
            json: (j) => {
              jsonBody = j;
            },
          };
        },
      },
      getStatus: () => statusCode,
      getBody: () => jsonBody,
    };
  }

  // Test 1: Validation errors on create
  {
    const { res, getStatus, getBody } = createMockRes();
    await controller.createSurname({ body: { surname: "" } }, res);
    assert.strictEqual(getStatus(), 400);
    assert(getBody().error.includes("surname (in Gujarati) is required"));
    console.log("✔ Validation: Missing Gujarati surname rejected");

    const { res: res2, getStatus: getStatus2, getBody: getBody2 } = createMockRes();
    await controller.createSurname({ body: { surname: "પાનેલીયા", surnameEnglish: "" } }, res2);
    assert.strictEqual(getStatus2(), 400);
    assert(getBody2().error.includes("surnameEnglish (in English) is required"));
    console.log("✔ Validation: Missing English surname rejected");
  }

  // Test 2: Successful creation of surname
  {
    const { res, getStatus, getBody } = createMockRes();
    await controller.createSurname(
      { body: { surname: "પાનેલીયા", surnameEnglish: "PANELIYA" } },
      res,
    );
    assert.strictEqual(getStatus(), 201);
    assert.strictEqual(getBody().data.surname, "પાનેલીયા");
    assert.strictEqual(getBody().data.surnameEnglish, "PANELIYA");
    assert.strictEqual(getBody().data.isActive, true);
    console.log("✔ Create: Surname created with Gujarati and English");
  }

  // Test 3: Duplicate creation rejected (case-insensitive)
  {
    const { res, getStatus, getBody } = createMockRes();
    await controller.createSurname(
      { body: { surname: "પાનેલીયા", surnameEnglish: "paneliya" } },
      res,
    );
    assert.strictEqual(getStatus(), 400);
    assert(getBody().error.includes("already exists"));
    console.log("✔ Create: Duplicate surname rejected case-insensitively");
  }

  // Test 4: Create a second surname
  {
    const { res, getStatus } = createMockRes();
    await controller.createSurname(
      { body: { surname: "પટેલ", surnameEnglish: "PATEL" } },
      res,
    );
    assert.strictEqual(getStatus(), 201);
    console.log("✔ Create: Second surname created");
  }

  // Test 5: Get all surnames & search
  {
    const { res, getStatus, getBody } = createMockRes();
    await controller.getAllSurnames({ query: {} }, res);
    assert.strictEqual(getStatus(), 200);
    assert.strictEqual(getBody().data.length, 2);
    console.log("✔ GetAll: Fetched all surnames");

    // Search by English
    const { res: resSearch, getStatus: getStatusSearch, getBody: getBodySearch } = createMockRes();
    await controller.getAllSurnames({ query: { search: "pane" } }, resSearch);
    assert.strictEqual(getStatusSearch(), 200);
    assert.strictEqual(getBodySearch().data.length, 1);
    assert.strictEqual(getBodySearch().data[0].surnameEnglish, "PANELIYA");
    console.log("✔ Search: Filtered surname by English substring");
  }

  // Test 6: Get by ID
  {
    const { res, getStatus, getBody } = createMockRes();
    await controller.getSurnameById({ params: { id: 1 } }, res);
    assert.strictEqual(getStatus(), 200);
    assert.strictEqual(getBody().data.id, 1);
    assert.strictEqual(getBody().data.surnameEnglish, "PANELIYA");
    console.log("✔ GetById: Fetched surname by ID");
  }

  // Test 7: Update surname
  {
    const { res, getStatus, getBody } = createMockRes();
    await controller.updateSurname(
      { params: { id: 1 }, body: { surnameEnglish: "PANELIA" } },
      res,
    );
    assert.strictEqual(getStatus(), 200);
    assert.strictEqual(getBody().data.surnameEnglish, "PANELIA");
    console.log("✔ Update: Updated surnameEnglish");
  }

  // Test 8: Delete surname (Soft delete)
  {
    const { res, getStatus } = createMockRes();
    await controller.deleteSurname({ params: { id: 2 } }, res);
    assert.strictEqual(getStatus(), 200);

    // Verify it is no longer returned in active list
    const { res: resAll, getBody: getBodyAll } = createMockRes();
    await controller.getAllSurnames({ query: {} }, resAll);
    assert.strictEqual(getBodyAll().data.length, 1);
    assert.strictEqual(getBodyAll().data[0].id, 1);
    console.log("✔ Delete: Soft deleted surname, excluded from active list");
  }

  console.log("\n ALL SURNAME MASTER TESTS PASSED! ✨");
})();
