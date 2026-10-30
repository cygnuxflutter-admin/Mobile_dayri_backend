const { sendSuccess } = require("../utils/response");

const createSurnamesTableSql = `
  CREATE TABLE IF NOT EXISTS surnames (
    id BIGSERIAL PRIMARY KEY,
    surname TEXT NOT NULL,
    "surnameEnglish" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "isDeleted" BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_surname_english 
  ON surnames (LOWER(TRIM("surnameEnglish"))) 
  WHERE COALESCE("isDeleted", false) = false;

  CREATE INDEX IF NOT EXISTS idx_surnames_gujarati 
  ON surnames (LOWER(TRIM(surname))) 
  WHERE COALESCE("isDeleted", false) = false;

  CREATE INDEX IF NOT EXISTS idx_surnames_active 
  ON surnames ("isActive") 
  WHERE COALESCE("isDeleted", false) = false;
`;

async function ensureSurnamesTable(pool) {
  try {
    await pool.query(createSurnamesTableSql);

    // Auto-seed from existing members table if surnames table is empty
    await pool.query(`
      INSERT INTO surnames (surname, "surnameEnglish", "isActive", "isDeleted", created_at, updated_at)
      SELECT DISTINCT TRIM(m.surname), TRIM(m."surnameEnglish"), TRUE, FALSE, NOW(), NOW()
      FROM members m
      WHERE NULLIF(TRIM(m.surname), '') IS NOT NULL
        AND NULLIF(TRIM(m."surnameEnglish"), '') IS NOT NULL
        AND COALESCE(m."isDeleted", false) = false
      ON CONFLICT (LOWER(TRIM("surnameEnglish"))) WHERE COALESCE("isDeleted", false) = false
      DO NOTHING;
    `);

    console.log("Surnames table ensured successfully");
  } catch (error) {
    console.error("Failed to ensure surnames table:", error.message);
    throw error;
  }
}

function surnameController(pool) {
  return {
    /**
     * Create a new surname (both Gujarati and English required)
     * POST /api/v1/surname
     * Public endpoint (no auth required)
     */
    async createSurname(request, response) {
      const body = request.body || {};
      const surname = String(body.surname || "").trim();
      const surnameEnglish = String(body.surnameEnglish || "").trim();

      if (!surname) {
        return response.status(400).json({
          error: "surname (in Gujarati) is required",
        });
      }

      if (!surnameEnglish) {
        return response.status(400).json({
          error: "surnameEnglish (in English) is required",
        });
      }

      try {
        // Check duplicate by English surname (case-insensitive) or Gujarati surname
        const dupCheck = await pool.query(
          `SELECT id, surname, "surnameEnglish" FROM surnames
           WHERE (LOWER(TRIM("surnameEnglish")) = LOWER($1) OR LOWER(TRIM(surname)) = LOWER($2))
             AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [surnameEnglish, surname],
        );

        if (dupCheck.rowCount > 0) {
          const existing = dupCheck.rows[0];
          return response.status(400).json({
            error: `Surname already exists (${existing.surnameEnglish} / ${existing.surname})`,
          });
        }

        const result = await pool.query(
          `INSERT INTO surnames (surname, "surnameEnglish", "isActive", "isDeleted", created_at, updated_at)
           VALUES ($1, $2, TRUE, FALSE, NOW(), NOW())
           RETURNING id, surname, "surnameEnglish", "isActive", created_at, updated_at`,
          [surname, surnameEnglish],
        );

        return sendSuccess(
          response,
          201,
          "Surname created successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to create surname:", error.message);
        return response.status(500).json({ error: "Failed to create surname" });
      }
    },

    /**
     * Bulk create surnames
     * POST /api/v1/surname/bulk
     * Body: { surnames: [ { surname: "પાનેલીયા", surnameEnglish: "PANELIYA" }, ... ] }
     */
    async bulkCreateSurnames(request, response) {
      const body = request.body || {};
      const list = Array.isArray(body.surnames) ? body.surnames : [];

      if (list.length === 0) {
        return response.status(400).json({
          error: "surnames array is required and must contain at least one item",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = [];
        const skipped = [];

        for (const item of list) {
          const sGuj = String(item.surname || "").trim();
          const sEng = String(item.surnameEnglish || "").trim();

          if (!sGuj || !sEng) {
            skipped.push({ item, reason: "Both surname and surnameEnglish are required" });
            continue;
          }

          const dup = await client.query(
            `SELECT id FROM surnames
             WHERE (LOWER(TRIM("surnameEnglish")) = LOWER($1) OR LOWER(TRIM(surname)) = LOWER($2))
               AND COALESCE("isDeleted", false) = false
             LIMIT 1`,
            [sEng, sGuj],
          );

          if (dup.rowCount > 0) {
            skipped.push({ item, reason: "Already exists" });
            continue;
          }

          const res = await client.query(
            `INSERT INTO surnames (surname, "surnameEnglish", "isActive", "isDeleted", created_at, updated_at)
             VALUES ($1, $2, TRUE, FALSE, NOW(), NOW())
             RETURNING id, surname, "surnameEnglish", "isActive"`,
            [sGuj, sEng],
          );
          inserted.push(res.rows[0]);
        }

        await client.query("COMMIT");

        return sendSuccess(response, 201, `Bulk surnames processed: ${inserted.length} added, ${skipped.length} skipped`, {
          addedCount: inserted.length,
          skippedCount: skipped.length,
          added: inserted,
          skipped,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to bulk create surnames:", error.message);
        return response.status(500).json({ error: "Failed to bulk create surnames" });
      } finally {
        client.release();
      }
    },

    /**
     * Get all surnames (supports search by Gujarati or English, and filter by active)
     * GET /api/v1/surname?search=pan&isActive=true
     * Public endpoint for registration dropdown and user search
     */
    async getAllSurnames(request, response) {
      const search = request.query.search ? String(request.query.search).trim() : "";
      const rawIsActive = request.query.isActive;
      const sortBy = String(request.query.sortBy || "english").toLowerCase().trim();
      const order = String(request.query.order || "ASC").toUpperCase().trim() === "DESC" ? "DESC" : "ASC";

      const queryParams = [];
      let whereConditions = ['COALESCE(s."isDeleted", false) = false'];

      if (rawIsActive !== undefined) {
        queryParams.push(rawIsActive === true || String(rawIsActive).toLowerCase() === "true");
        whereConditions.push(`s."isActive" = $${queryParams.length}`);
      }

      if (search) {
        queryParams.push(`%${search}%`);
        const p = `$${queryParams.length}`;
        whereConditions.push(`(s."surnameEnglish" ILIKE ${p} OR s.surname ILIKE ${p})`);
      }

      const orderByClause =
        sortBy === "gujarati"
          ? `ORDER BY s.surname ${order}, s."surnameEnglish" ${order}`
          : `ORDER BY s."surnameEnglish" ${order}, s.surname ${order}`;

      const sql = `
        SELECT 
          s.id,
          s.surname,
          s."surnameEnglish",
          s."isActive",
          s.created_at,
          s.updated_at,
          COUNT(m.id)::INTEGER AS "memberCount"
        FROM surnames s
        LEFT JOIN members m 
          ON (
            LOWER(TRIM(m."surnameEnglish")) = LOWER(TRIM(s."surnameEnglish"))
            OR TRIM(m.surname) = TRIM(s.surname)
          ) AND COALESCE(m."isDeleted", false) = false
        WHERE ${whereConditions.join(" AND ")}
        GROUP BY s.id, s.surname, s."surnameEnglish", s."isActive", s.created_at, s.updated_at
        ${orderByClause}
      `;

      try {
        const result = await pool.query(sql, queryParams);
        return sendSuccess(response, 200, "Surnames fetched successfully", result.rows);
      } catch (error) {
        console.error("Failed to fetch surnames:", error.message);
        return response.status(500).json({ error: "Failed to fetch surnames" });
      }
    },

    /**
     * Get single surname by ID
     * GET /api/v1/surname/:id
     */
    async getSurnameById(request, response) {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return response.status(400).json({ error: "Valid surname ID is required" });
      }

      try {
        const result = await pool.query(
          `SELECT 
            s.id,
            s.surname,
            s."surnameEnglish",
            s."isActive",
            s.created_at,
            s.updated_at,
            COUNT(m.id)::INTEGER AS "memberCount"
           FROM surnames s
           LEFT JOIN members m 
             ON (
               LOWER(TRIM(m."surnameEnglish")) = LOWER(TRIM(s."surnameEnglish"))
               OR TRIM(m.surname) = TRIM(s.surname)
             ) AND COALESCE(m."isDeleted", false) = false
           WHERE s.id = $1 AND COALESCE(s."isDeleted", false) = false
           GROUP BY s.id, s.surname, s."surnameEnglish", s."isActive", s.created_at, s.updated_at
           LIMIT 1`,
          [id],
        );

        if (result.rowCount === 0) {
          return response.status(404).json({ error: "Surname not found" });
        }

        return sendSuccess(response, 200, "Surname retrieved successfully", result.rows[0]);
      } catch (error) {
        console.error("Failed to get surname by ID:", error.message);
        return response.status(500).json({ error: "Failed to get surname" });
      }
    },

    /**
     * Update surname details
     * PUT/PATCH /api/v1/surname/:id
     */
    async updateSurname(request, response) {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return response.status(400).json({ error: "Valid surname ID is required" });
      }

      const body = request.body || {};
      const surname = body.surname !== undefined ? String(body.surname).trim() : undefined;
      const surnameEnglish = body.surnameEnglish !== undefined ? String(body.surnameEnglish).trim() : undefined;
      const isActive =
        body.isActive !== undefined
          ? Boolean(body.isActive === true || String(body.isActive).toLowerCase() === "true")
          : undefined;

      if (surname === undefined && surnameEnglish === undefined && isActive === undefined) {
        return response.status(400).json({
          error: "At least one field (surname, surnameEnglish, isActive) is required to update",
        });
      }

      if (surname !== undefined && !surname) {
        return response.status(400).json({ error: "surname cannot be empty" });
      }

      if (surnameEnglish !== undefined && !surnameEnglish) {
        return response.status(400).json({ error: "surnameEnglish cannot be empty" });
      }

      try {
        // Check existence
        const existing = await pool.query(
          `SELECT id, surname, "surnameEnglish" FROM surnames WHERE id = $1 AND COALESCE("isDeleted", false) = false LIMIT 1`,
          [id],
        );

        if (existing.rowCount === 0) {
          return response.status(404).json({ error: "Surname not found" });
        }

        // Duplicate check if name is being changed
        const checkEng = surnameEnglish ?? existing.rows[0].surnameEnglish;
        const checkGuj = surname ?? existing.rows[0].surname;

        const dup = await pool.query(
          `SELECT id FROM surnames
           WHERE id != $1
             AND (LOWER(TRIM("surnameEnglish")) = LOWER($2) OR LOWER(TRIM(surname)) = LOWER($3))
             AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [id, checkEng, checkGuj],
        );

        if (dup.rowCount > 0) {
          return response.status(400).json({
            error: "Another surname already exists with this name",
          });
        }

        const updateResult = await pool.query(
          `UPDATE surnames
           SET surname = COALESCE($1, surname),
               "surnameEnglish" = COALESCE($2, "surnameEnglish"),
               "isActive" = COALESCE($3, "isActive"),
               updated_at = NOW()
           WHERE id = $4
           RETURNING id, surname, "surnameEnglish", "isActive", created_at, updated_at`,
          [
            surname ?? null,
            surnameEnglish ?? null,
            isActive !== undefined ? isActive : null,
            id,
          ],
        );

        return sendSuccess(response, 200, "Surname updated successfully", updateResult.rows[0]);
      } catch (error) {
        console.error("Failed to update surname:", error.message);
        return response.status(500).json({ error: "Failed to update surname" });
      }
    },

    /**
     * Soft delete surname
     * DELETE /api/v1/surname/:id
     */
    async deleteSurname(request, response) {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return response.status(400).json({ error: "Valid surname ID is required" });
      }

      try {
        const existing = await pool.query(
          `SELECT id, surname, "surnameEnglish" FROM surnames WHERE id = $1 AND COALESCE("isDeleted", false) = false LIMIT 1`,
          [id],
        );

        if (existing.rowCount === 0) {
          return response.status(404).json({ error: "Surname not found" });
        }

        const result = await pool.query(
          `UPDATE surnames
           SET "isDeleted" = TRUE,
               "isActive" = FALSE,
               updated_at = NOW()
           WHERE id = $1
           RETURNING id, surname, "surnameEnglish"`,
          [id],
        );

        return sendSuccess(response, 200, "Surname deleted successfully", result.rows[0]);
      } catch (error) {
        console.error("Failed to delete surname:", error.message);
        return response.status(500).json({ error: "Failed to delete surname" });
      }
    },
  };
}

module.exports = {
  surnameController,
  ensureSurnamesTable,
};
