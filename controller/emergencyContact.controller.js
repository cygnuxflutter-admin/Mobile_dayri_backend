const { sendSuccess } = require("../utils/response");

const emergencyContactFields = [
  "name",
  "number",
  "occupation",
  "designation",
  "category",
  "village",
  "address",
  "email",
  "notes",
  "isActive",
];

const createEmergencyContactsTable = `
  CREATE TABLE IF NOT EXISTS emergency_contacts (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    number TEXT NOT NULL,
    occupation TEXT NOT NULL,
    designation TEXT,
    category TEXT,
    village TEXT,
    address TEXT,
    email TEXT,
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

async function ensureEmergencyContactsTable(pool) {
  await pool.query(createEmergencyContactsTable);

  await pool.query(`
    ALTER TABLE emergency_contacts
    ADD COLUMN IF NOT EXISTS designation TEXT,
    ADD COLUMN IF NOT EXISTS category TEXT,
    ADD COLUMN IF NOT EXISTS village TEXT,
    ADD COLUMN IF NOT EXISTS address TEXT,
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS notes TEXT,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);
}

function parseEmergencyContactId(request, response) {
  const emergencyContactId = Number.parseInt(request.params.id, 10);

  if (!Number.isInteger(emergencyContactId) || emergencyContactId < 1) {
    response
      .status(400)
      .json({ error: "Emergency contact id must be a positive integer" });
    return null;
  }

  return emergencyContactId;
}

function validateEmergencyContact(payload, isUpdate = false) {
  if (!isUpdate) {
    const missing = [];
    if (!payload.name || !String(payload.name).trim()) missing.push("name");
    if (!payload.number || !String(payload.number).trim()) missing.push("number");
    if (!payload.occupation || !String(payload.occupation).trim()) {
      missing.push("occupation");
    }

    if (missing.length > 0) {
      return { error: "Missing required fields", fields: missing };
    }
  }

  if (payload.name !== undefined && payload.name !== null) {
    if (!String(payload.name).trim()) {
      return { error: "name cannot be empty" };
    }
  }

  if (payload.number !== undefined && payload.number !== null) {
    if (!String(payload.number).trim()) {
      return { error: "number cannot be empty" };
    }
  }

  if (payload.occupation !== undefined && payload.occupation !== null) {
    if (!String(payload.occupation).trim()) {
      return { error: "occupation cannot be empty" };
    }
  }

  if (payload.isActive !== undefined && payload.isActive !== null) {
    if (typeof payload.isActive !== "boolean") {
      return { error: "isActive must be a boolean" };
    }
  }

  return null;
}

function buildEmergencyContactPayload(body) {
  return {
    name: body.name?.trim() || null,
    number: body.number?.trim() || null,
    occupation: body.occupation?.trim() || null,
    designation: body.designation?.trim() || null,
    category: body.category?.trim() || null,
    village: body.village?.trim() || null,
    address: body.address?.trim() || null,
    email: body.email?.trim() || null,
    notes: body.notes?.trim() || null,
    isActive:
      body.isActive === undefined ? undefined : Boolean(body.isActive),
  };
}

function emergencyContactController(pool) {
  return {
    async addEmergencyContact(request, response) {
      const payload = buildEmergencyContactPayload(request.body);
      const validationError = validateEmergencyContact(payload);

      if (validationError) {
        return response.status(400).json(validationError);
      }

      try {
        const result = await pool.query(
          `INSERT INTO emergency_contacts (
            name, number, occupation, designation, category, village, address, email, notes, is_active, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
          RETURNING *`,
          [
            payload.name,
            payload.number,
            payload.occupation,
            payload.designation,
            payload.category,
            payload.village,
            payload.address,
            payload.email,
            payload.notes,
            payload.isActive ?? true,
          ],
        );

        return sendSuccess(
          response,
          201,
          "Emergency contact added successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to add emergency contact:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to add emergency contact" });
      }
    },

    async getEmergencyContacts(request, response) {
      try {
        const result = await pool.query(
          `SELECT * FROM emergency_contacts ORDER BY is_active DESC, name ASC, id ASC`,
        );

        return sendSuccess(
          response,
          200,
          "Emergency contacts fetched successfully",
          result.rows,
        );
      } catch (error) {
        console.error("Failed to fetch emergency contacts:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to fetch emergency contacts" });
      }
    },

    async getEmergencyContact(request, response) {
      const emergencyContactId = parseEmergencyContactId(request, response);
      if (!emergencyContactId) {
        return;
      }

      try {
        const result = await pool.query(
          "SELECT * FROM emergency_contacts WHERE id = $1",
          [emergencyContactId],
        );

        if (result.rowCount === 0) {
          return response
            .status(404)
            .json({ error: "Emergency contact not found" });
        }

        return sendSuccess(
          response,
          200,
          "Emergency contact fetched successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to fetch emergency contact:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to fetch emergency contact" });
      }
    },

    async updateEmergencyContact(request, response) {
      const emergencyContactId = parseEmergencyContactId(request, response);
      if (!emergencyContactId) {
        return;
      }

      const payload = buildEmergencyContactPayload(request.body);
      const fields = [];
      const values = [];

      const allowedFields = [
        "name",
        "number",
        "occupation",
        "designation",
        "category",
        "village",
        "address",
        "email",
        "notes",
        "isActive",
      ];

      for (const field of allowedFields) {
        if (request.body[field] !== undefined) {
          fields.push(`${field === "isActive" ? "is_active" : field} = $${values.length + 1}`);
          values.push(field === "isActive" ? Boolean(request.body[field]) : payload[field]);
        }
      }

      if (fields.length === 0) {
        return response.status(400).json({
          error: "At least one emergency contact field is required for update",
        });
      }

      const validationError = validateEmergencyContact(payload, true);
      if (validationError) {
        return response.status(400).json(validationError);
      }

      fields.push("updated_at = NOW()");
      values.push(emergencyContactId);

      try {
        const result = await pool.query(
          `UPDATE emergency_contacts
           SET ${fields.join(", ")}
           WHERE id = $${values.length}
           RETURNING *`,
          values,
        );

        if (result.rowCount === 0) {
          return response
            .status(404)
            .json({ error: "Emergency contact not found" });
        }

        return sendSuccess(
          response,
          200,
          "Emergency contact updated successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to update emergency contact:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to update emergency contact" });
      }
    },

    async deleteEmergencyContact(request, response) {
      const emergencyContactId = parseEmergencyContactId(request, response);
      if (!emergencyContactId) {
        return;
      }

      try {
        const result = await pool.query(
          "DELETE FROM emergency_contacts WHERE id = $1 RETURNING id",
          [emergencyContactId],
        );

        if (result.rowCount === 0) {
          return response
            .status(404)
            .json({ error: "Emergency contact not found" });
        }

        return sendSuccess(response, 200, "Emergency contact deleted successfully", {
          id: result.rows[0].id,
        });
      } catch (error) {
        console.error("Failed to delete emergency contact:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to delete emergency contact" });
      }
    },
  };
}

module.exports = { emergencyContactController, ensureEmergencyContactsTable };
