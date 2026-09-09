const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { sendSuccess } = require("../utils/response");
const { generateToken } = require("./auth.controller");

const memberUploadDir = path.join(__dirname, "..", "uploads", "members");
if (!fs.existsSync(memberUploadDir)) {
  fs.mkdirSync(memberUploadDir, { recursive: true });
}

const memberRegistrationUpload = multer({
  storage: multer.diskStorage({
    destination: (request, file, callback) => callback(null, memberUploadDir),
    filename: (request, file, callback) => {
      const safeName = file.originalname.replace(/\s+/g, "_");
      callback(null, `${Date.now()}-${safeName}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const memberFields = [
  "firstName",
  "firstNameEnglish",
  "middleName",
  "middleNameEnglish",
  "surname",
  "surnameEnglish",
  "mobileNumber",
  "gender",
  "dateOfBirth",
  "age",
  "isActive",
  "isDeleted",
  "deletedBy",
  "isApproved",
  "approvedBy",
  "created_at",
  "updated_at",
  "sonIds",
  "fatherId",
  "fcmToken",
];

const requiredMemberFields = [
  "firstName",
  "firstNameEnglish",
  "middleName",
  "middleNameEnglish",
  "surname",
  "surnameEnglish",
  "mobileNumber",
  "gender",
  "dateOfBirth",
  "age",
  "currentAddress",
  "latlng",
  "fcmToken",
];

const insertMemberFields = [
  ...requiredMemberFields.filter((field) => field !== "fcmToken"),
  "sonIds",
  "fatherId",
];

const createMembersTable = `
  CREATE TABLE IF NOT EXISTS members (
    id BIGSERIAL PRIMARY KEY,
    "firstName" TEXT NOT NULL,
    "firstNameEnglish" TEXT NOT NULL,
    "middleName" TEXT NOT NULL,
    "middleNameEnglish" TEXT NOT NULL,
    surname TEXT NOT NULL,
    "surnameEnglish" TEXT NOT NULL,
    "mobileNumber" TEXT NOT NULL,
    gender TEXT NOT NULL,
    "dateOfBirth" TEXT NOT NULL,
    age INTEGER NOT NULL CHECK (age >= 0),
    "isActive" BOOLEAN DEFAULT TRUE,
    "isDeleted" BOOLEAN DEFAULT FALSE,
    "deletedBy" BIGINT REFERENCES members(id) ON DELETE SET NULL,
    "isApproved" BOOLEAN DEFAULT FALSE,
    "approvedBy" BIGINT REFERENCES members(id) ON DELETE SET NULL,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ DEFAULT NOW(),
    "photo_url" TEXT,
    "currentAddress" TEXT,
    "latlng" TEXT,
    "fcmToken" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER' CHECK ("role" IN ('USER', 'ADMIN', 'SUPERADMIN')),
    "sonIds" BIGINT[],
    "fatherId" BIGINT REFERENCES members(id) ON DELETE SET NULL
  )
`;

const createOtpVerificationsTable = `
  CREATE TABLE IF NOT EXISTS otp_verifications (
    id BIGSERIAL PRIMARY KEY,
    mobile_number TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    pending_member JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

function normalizeMobileNumber(value) {
  return String(value || "").replace(/[\s()-]/g, "");
}

function parseRegistrationArray(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.map(Number);

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return String(value)
      .split(",")
      .map((item) => Number(item.trim()));
  }
}

function buildRegistrationPayload(body, file) {
  const sonIds = parseRegistrationArray(body?.sonIds);

  return {
    ...body,
    age:
      body?.age === undefined || body.age === "" ? body.age : Number(body.age),
    fatherId:
      body?.fatherId === undefined ||
      body.fatherId === "" ||
      body.fatherId === null
        ? null
        : Number(body.fatherId),
    sonIds: sonIds.length > 0 ? sonIds : null,
    mobileNumber: normalizeMobileNumber(body?.mobileNumber),
    photoUrl: file ? `/uploads/members/${file.filename}` : null,
  };
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

async function syncMemberSequence(pool) {
  await pool.query(`
    SELECT setval(
      pg_get_serial_sequence('members', 'id'),
      COALESCE((SELECT MAX(id) FROM members), 0) + 1,
      false
    );
  `);
}

async function ensureOtpVerificationsTable(pool) {
  await pool.query(createOtpVerificationsTable);
}

async function sendRegistrationOtp(mobileNumber, otp) {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_CONSOLE_OTP === "true"
  ) {
    console.log(`Registration OTP for ${mobileNumber}: ${otp}`);
    return;
  }

  throw new Error("OTP SMS provider is not configured");
}

async function ensureMembersTable(pool) {
  const result = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'members'
    ) AS "exists"
  `);

  if (!result.rows[0].exists) {
    await pool.query(createMembersTable);
    console.log("Members table created");
  }

  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "deletedBy" BIGINT REFERENCES members(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "isApproved" BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "approvedBy" BIGINT REFERENCES members(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "sonIds" BIGINT[],
    ADD COLUMN IF NOT EXISTS "fatherId" BIGINT REFERENCES members(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS "photo_url" TEXT,
    ADD COLUMN IF NOT EXISTS "fcmToken" TEXT,
    ADD COLUMN IF NOT EXISTS "role" TEXT DEFAULT 'USER'
  `);
  await pool.query(`
    UPDATE members SET "isApproved" = FALSE WHERE "isApproved" IS NULL;
    ALTER TABLE members
    ALTER COLUMN "isApproved" SET DEFAULT FALSE;
  `);
  await pool.query(`
    UPDATE members SET "role" = 'USER' WHERE "role" IS NULL
  `);
  await pool.query(`
    ALTER TABLE members DROP CONSTRAINT IF EXISTS members_role_check;
    ALTER TABLE members
    ADD CONSTRAINT members_role_check CHECK ("role" IN ('USER', 'ADMIN', 'SUPERADMIN'));
  `);

  if (result.rows[0].exists) {
    console.log("Members table already exists");
  }
}

function validateMember(member) {
  const missingFields = requiredMemberFields.filter(
    (field) => member?.[field] === undefined,
  );

  if (missingFields.length > 0) {
    return { error: "Missing required fields", fields: missingFields };
  }

  if (!Number.isInteger(member.age) || member.age < 0) {
    return { error: "age must be a non-negative integer" };
  }
  console.log("Validating member:", member.fatherId);
  // if (
  //   member.fatherId !== undefined &&
  //   member.fatherId !== NaN &&
  //   member.fatherId !== 'null' && (!Number.isInteger(member.fatherId) || member.fatherId < 1)
  // ) {
  //   return { error: "fatherId must be a positive integer" };
  // }
  // if (
  //   member.sonIds !== undefined &&
  //   member.sonIds !== null &&
  //   member.sonIds !== "null"
  // ) {
  //   if (
  //     !Array.isArray(member.sonIds) ||
  //     !member.sonIds.every((id) => Number.isInteger(id) && id >= 1)
  //   ) {
  //     return { error: "sonIds must be an array of positive integers or null" };
  //   }
  // }
  // allow explicit null to represent no father
  if (member.fatherId === null) {
    // treat as OK
  }

  return null;
}

function validateMemberUpdate(member) {
  const fieldsToUpdate = memberFields.filter(
    (field) => member?.[field] !== undefined,
  );

  if (fieldsToUpdate.length === 0) {
    return { error: "At least one member field is required" };
  }

  if (
    member.age !== undefined &&
    (!Number.isInteger(member.age) || member.age < 0)
  ) {
    return { error: "age must be a non-negative integer" };
  }

  // Allow null or positive integer for fatherId on update
  if (member.fatherId !== undefined && member.fatherId !== null) {
    if (!Number.isInteger(member.fatherId) || member.fatherId < 1) {
      return { error: "fatherId must be a positive integer or null" };
    }
  }

  // Allow null or array of positive integers for sonIds on update
  if (member.sonIds !== undefined && member.sonIds !== null) {
    if (
      !Array.isArray(member.sonIds) ||
      !member.sonIds.every((id) => Number.isInteger(id) && id >= 1)
    ) {
      return { error: "sonIds must be an array of positive integers or null" };
    }
  }

  return null;
}

function parseMemberId(request, response) {
  const memberId = Number.parseInt(request.params.id, 10);

  if (!Number.isInteger(memberId) || memberId < 1) {
    response
      .status(400)
      .json({ error: "Member id must be a positive integer" });
    return null;
  }

  return memberId;
}

async function enrichMembersWithSonsNames(members, pool) {
  if (!members || members.length === 0) return members;

  members.forEach((member) => {
    member.fatherName = member.fatherName?.trim() || null;
    if (!Array.isArray(member.sonIds) || member.sonIds.length === 0) {
      member.sonIds = null;
    }
  });

  // Collect all unique son IDs
  const allSonIds = new Set();
  members.forEach((member) => {
    if (Array.isArray(member.sonIds) && member.sonIds.length > 0) {
      member.sonIds.forEach((id) => allSonIds.add(id));
    }
  });

  // If no sons, return null for a missing relationship.
  if (allSonIds.size === 0) {
    members.forEach((member) => {
      member.sonsName = null;
    });
    return members;
  }

  // Fetch all son names in one query
  const sonIds = Array.from(allSonIds);
  const result = await pool.query(
    `SELECT id, CONCAT("firstName", ' ', "middleName", ' ', "surname") AS "fullName" FROM members WHERE id = ANY($1)`,
    [sonIds],
  );

  // Create a map of id -> fullName
  const sonNamesMap = {};
  result.rows.forEach((row) => {
    sonNamesMap[row.id] = row.fullName;
  });

  // Add sonsName to each member
  members.forEach((member) => {
    if (Array.isArray(member.sonIds) && member.sonIds.length > 0) {
      const sonsNames = member.sonIds
        .map((id) => sonNamesMap[id])
        .filter(Boolean);
      member.sonsName = sonsNames.length > 0 ? sonsNames : null;
    } else {
      member.sonsName = null;
    }
  });

  return members;
}

function memberController(pool) {
  return {
    async updateMemberRole(request, response) {
      const memberId = parseMemberId(request, response);
      const { role } = request.body;

      if (!memberId) {
        return;
      }

      const validRoles = ["USER", "ADMIN", "SUPERADMIN"];
      if (!role || !validRoles.includes(String(role).toUpperCase())) {
        return response.status(400).json({
          error: `Invalid role. Allowed roles are: ${validRoles.join(", ")}`,
        });
      }

      const normalizedRole = String(role).toUpperCase();

      try {
        const existingResult = await pool.query(
          `SELECT id, "role", "isApproved" FROM members
           WHERE id = $1 AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [memberId],
        );

        if (existingResult.rowCount === 0) {
          return response.status(404).json({ error: "Member not found" });
        }

        const member = existingResult.rows[0];
        if (member.role === normalizedRole) {
          return response.status(400).json({
            error: `Member is already a ${normalizedRole}`,
          });
        }

        const result = await pool.query(
          `UPDATE members
           SET "role" = $1, "updated_at" = NOW()
           WHERE id = $2 AND COALESCE("isDeleted", false) = false
           RETURNING *`,
          [normalizedRole, memberId],
        );

        await enrichMembersWithSonsNames(result.rows, pool);
        return sendSuccess(
          response,
          200,
          `Member role updated to ${normalizedRole} successfully`,
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to update member role:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to update member role" });
      }
    },

    async approveMember(request, response) {
      const memberId = parseMemberId(request, response);

      if (!memberId) {
        return;
      }

      try {
        const existingResult = await pool.query(
          `SELECT id, "isApproved" FROM members
           WHERE id = $1 AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [memberId],
        );

        if (existingResult.rowCount === 0) {
          return response.status(404).json({ error: "Member not found" });
        }

        const existingMember = existingResult.rows[0];
        if (existingMember.isApproved === true) {
          return response
            .status(400)
            .json({ error: "Member is already approved" });
        }

        const result = await pool.query(
          `UPDATE members
           SET "isApproved" = TRUE, "approvedBy" = $1, "updated_at" = NOW()
           WHERE id = $2 AND COALESCE("isDeleted", false) = false
           RETURNING *`,
          [request.member?.id || null, memberId],
        );

        await enrichMembersWithSonsNames(result.rows, pool);
        return sendSuccess(
          response,
          200,
          "Member approved successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to approve member:", error.message);
        return response.status(500).json({ error: "Failed to approve member" });
      }
    },

    async approvalPendingMember(request, response) {
      try {
        const data = await pool.query(
          `SELECT * FROM members WHERE "isApproved" = FALSE AND COALESCE("isDeleted", false) = false ORDER BY "created_at" DESC`,
        );
        return sendSuccess(
          response,
          200,
          "Pending approval members retrieved successfully",
          data.rows,
        );
      } catch (error) {
        console.error("Failed to send registration OTP:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to send registration OTP" });
      }
    },

    async requestRegistrationOtp1(request, response) {
      const payload = buildRegistrationPayload(request.body, request.file);
      const validationError = validateMember(payload);

      if (validationError) {
        return response.status(400).json(validationError);
      }

      try {
        const existingMember = await pool.query(
          `SELECT id FROM members
           WHERE "mobileNumber" = $1 AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [payload.mobileNumber],
        );

        if (existingMember.rowCount > 0) {
          return response
            .status(409)
            .json({ error: "Mobile number is already registered" });
        }

        const otp = generateOtp();
        await sendRegistrationOtp(payload.mobileNumber, otp);

        await pool.query(
          "DELETE FROM otp_verifications WHERE mobile_number = $1 AND verified_at IS NULL",
          [payload.mobileNumber],
        );
        await pool.query(
          `INSERT INTO otp_verifications
             (mobile_number, otp_hash, pending_member, expires_at)
           VALUES ($1, $2, $3::jsonb, NOW() + INTERVAL '5 minutes')`,
          [payload.mobileNumber, hashOtp(otp), JSON.stringify(payload)],
        );

        const responseData = {
          mobileNumber: payload.mobileNumber,
          expiresInSeconds: 300,
        };

        if (process.env.NODE_ENV !== "production") {
          responseData.otp = otp;
        }

        return sendSuccess(
          response,
          200,
          "OTP sent successfully",
          responseData,
        );
      } catch (error) {
        console.error("Failed to send registration OTP:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to send registration OTP" });
      }
    },

    async requestRegistrationOtp(request, response) {
      const payload = buildRegistrationPayload(request.body, request.file);

      // --------------------------------
      // Normalize fatherId
      // --------------------------------
      if (
        payload.fatherId === undefined ||
        payload.fatherId === null ||
        payload.fatherId === "" ||
        payload.fatherId === "null"
      ) {
        payload.fatherId = null;
      } else {
        payload.fatherId = Number(payload.fatherId);
      }

      // --------------------------------
      // Normalize sonIds
      // --------------------------------
      if (
        payload.sonIds === undefined ||
        payload.sonIds === null ||
        payload.sonIds === "" ||
        payload.sonIds === "null" ||
        payload.sonIds === "[]"
      ) {
        payload.sonIds = null;
      } else if (Array.isArray(payload.sonIds) && payload.sonIds.length === 0) {
        payload.sonIds = null;
      } else {
        payload.sonIds = parseRegistrationArray(payload.sonIds);
      }

      // --------------------------------
      // Validate Member
      // --------------------------------
      const validationError = validateMember(payload);

      if (validationError) {
        return response.status(400).json(validationError);
      }

      try {
        // --------------------------------
        // Check Existing Member
        // --------------------------------
        const existingMember = await pool.query(
          `SELECT id
       FROM members
       WHERE "mobileNumber" = $1
         AND COALESCE("isDeleted", false) = false
       LIMIT 1`,
          [payload.mobileNumber],
        );

        if (existingMember.rowCount > 0) {
          return response.status(409).json({
            error: "Mobile number is already registered",
          });
        }

        // --------------------------------
        // Generate OTP
        // --------------------------------
        const otp = generateOtp();

        await sendRegistrationOtp(payload.mobileNumber, otp);

        // --------------------------------
        // Delete Previous OTP
        // --------------------------------
        await pool.query(
          `DELETE FROM otp_verifications
       WHERE mobile_number = $1
         AND verified_at IS NULL`,
          [payload.mobileNumber],
        );

        // --------------------------------
        // Store OTP + Pending Member
        // --------------------------------
        await pool.query(
          `INSERT INTO otp_verifications
         (mobile_number, otp_hash, pending_member, expires_at)
       VALUES ($1, $2, $3::jsonb, NOW() + INTERVAL '5 minutes')`,
          [payload.mobileNumber, hashOtp(otp), JSON.stringify(payload)],
        );

        // --------------------------------
        // Response
        // --------------------------------
        const responseData = {
          mobileNumber: payload.mobileNumber,
          expiresInSeconds: 300,
        };

        if (process.env.NODE_ENV !== "production") {
          responseData.otp = otp;
        }

        return sendSuccess(
          response,
          200,
          "OTP sent successfully",
          responseData,
        );
      } catch (error) {
        console.error("Failed to send registration OTP:", error.message);
        return response.status(500).json({
          error: "Failed to send registration OTP",
        });
      }
    },

    async verifyRegistrationOtp(request, response) {
      const mobileNumber = normalizeMobileNumber(request.body?.mobileNumber);
      const otp = String(request.body?.otp || "").trim();

      if (!mobileNumber || !/^\d{6}$/.test(otp)) {
        return response.status(400).json({
          error: "mobileNumber and a 6-digit otp are required",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const otpResult = await client.query(
          `SELECT * FROM otp_verifications
           WHERE mobile_number = $1 AND verified_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [mobileNumber],
        );

        if (otpResult.rowCount === 0) {
          await client.query("ROLLBACK");
          return response
            .status(400)
            .json({ error: "OTP not found or already used" });
        }

        const otpRecord = otpResult.rows[0];
        if (new Date(otpRecord.expires_at) <= new Date()) {
          await client.query("ROLLBACK");
          return response.status(400).json({ error: "OTP has expired" });
        }

        if (otpRecord.attempts >= 5) {
          await client.query("ROLLBACK");
          return response
            .status(429)
            .json({ error: "Too many invalid OTP attempts" });
        }

        if (hashOtp(otp) !== otpRecord.otp_hash) {
          await client.query(
            "UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = $1",
            [otpRecord.id],
          );
          await client.query("COMMIT");
          return response.status(400).json({ error: "Invalid OTP" });
        }

        const pendingMember = { ...otpRecord.pending_member };
        delete pendingMember.id;
        delete pendingMember.created_at;
        delete pendingMember.updated_at;

        const existingMember = await client.query(
          `SELECT id FROM members
           WHERE "mobileNumber" = $1 AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [mobileNumber],
        );

        if (existingMember.rowCount > 0) {
          await client.query("ROLLBACK");
          return response
            .status(409)
            .json({ error: "Mobile number is already registered" });
        }

        await syncMemberSequence(client);

        const memberResult = await client.query(
          `INSERT INTO members (
              "firstName", "firstNameEnglish", "middleName", "middleNameEnglish",
              surname, "surnameEnglish", "mobileNumber", gender, "dateOfBirth", age, "currentAddress", "latlng",
              "sonIds", "fatherId", "photo_url", "created_at", "fcmToken"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), $16)
           RETURNING id`,
          [
            ...insertMemberFields.map((field) => pendingMember[field] ?? null),
            pendingMember.photoUrl ?? null,
            pendingMember.fcmToken ?? null,
          ],
        );

        await client.query(
          "UPDATE otp_verifications SET verified_at = NOW() WHERE id = $1",
          [otpRecord.id],
        );
        await client.query("COMMIT");

        const memberWithFather = await pool.query(
          `SELECT m.*, CONCAT(f."firstName", ' ', f."surname") AS "fatherName"
           FROM members m
           LEFT JOIN members f ON m."fatherId" = f.id
           WHERE m.id = $1`,
          [memberResult.rows[0].id],
        );
        await enrichMembersWithSonsNames(memberWithFather.rows, pool);

        return sendSuccess(
          response,
          201,
          "Member registered successfully",
          memberWithFather.rows[0],
        );
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23503") {
          return response.status(400).json({
            error: "fatherId does not reference an existing member",
          });
        }
        console.error("Failed to verify registration OTP:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to verify registration OTP" });
      } finally {
        client.release();
      }
    },

    async getAllMembers(request, response) {
      const requestedGender = request.query.gender?.trim();
      const requestedSurname = request.query.surname?.trim();

      try {
        const loggedInUser = request.member;
        const userRole = loggedInUser?.role?.trim()?.toUpperCase();

        const isAdmin = userRole === "ADMIN" || userRole === "SUPERADMIN";

        const selectClause = `
      m.*, 
      CONCAT(
        f."firstName", ' ',
        f."middleName", ' ',
        f."surname"
      ) AS "fatherName"
    `;

        const conditions = [];
        const values = [];

        // USER -> only approved, active and non-deleted members
        // ADMIN / SUPERADMIN -> no restriction
        if (!isAdmin) {
          conditions.push(`
        COALESCE(m."isApproved", false) = true
      `);

          conditions.push(`
        COALESCE(m."isActive", false) = true
      `);

          conditions.push(`
        COALESCE(m."isDeleted", false) = false
      `);
        }

        // Gender filter
        if (requestedGender) {
          values.push(requestedGender);

          conditions.push(`
        LOWER(TRIM(m.gender)) = LOWER(TRIM($${values.length}))
      `);
        }

        // Surname filter
        if (requestedSurname) {
          values.push(requestedSurname);

          conditions.push(`
        LOWER(TRIM(m.surname)) = LOWER(TRIM($${values.length}))
      `);
        }

        const whereClause =
          conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const query = `
      SELECT ${selectClause}
      FROM members m
      LEFT JOIN members f ON m."fatherId" = f.id
      ${whereClause}
      ORDER BY
        CASE LOWER(m.gender)
          WHEN 'male' THEN 1
          WHEN 'female' THEN 2
          ELSE 3
        END,
        m.surname ASC,
        m.id ASC
    `;

        console.log("Logged in role:", userRole);
        console.log("Is admin:", isAdmin);
        console.log("Gender:", requestedGender);
        console.log("Surname:", requestedSurname);
        console.log("Query:", query);
        console.log("Values:", values);

        const result = await pool.query(query, values);

        // Always return same response format
        const groupedMembers = {
          male: [],
          female: [],
        };

        for (const member of result.rows) {
          const normalizedGender = member.gender?.trim()?.toLowerCase();

          if (normalizedGender === "male") {
            groupedMembers.male.push(member);
          } else if (normalizedGender === "female") {
            groupedMembers.female.push(member);
          }
        }

        await enrichMembersWithSonsNames(groupedMembers.male, pool);

        await enrichMembersWithSonsNames(groupedMembers.female, pool);

        return sendSuccess(response, 200, "Members fetched successfully", [
          groupedMembers,
        ]);
      } catch (error) {
        console.error("Failed to fetch members:", error.message);

        return response.status(500).json({
          error: "Failed to fetch members",
        });
      }
    },

    async getProfile(request, response) {
      try {
        // Member ID comes from Authorization header
        const caller = request.member;

        if (!caller || !caller.id) {
          return response.status(401).json({
            error: "Unauthorized: Invalid or missing authorization token",
          });
        }

        const memberId = Number(caller.id);

        if (!Number.isInteger(memberId) || memberId <= 0) {
          return response.status(401).json({
            error: "Unauthorized: Invalid member ID",
          });
        }

        // Fetch complete member profile
        const result = await pool.query(
          `SELECT
         m.*,
         CONCAT(
           f."firstName",
           ' ',
           f."middleName",
           ' ',
           f."surname"
         ) AS "fatherName"
       FROM members m
       LEFT JOIN members f
         ON m."fatherId" = f.id
       WHERE m.id = $1
         AND COALESCE(m."isDeleted", false) = false
       LIMIT 1`,
          [memberId],
        );

        if (result.rowCount === 0) {
          return response.status(404).json({
            error: "Member not found",
          });
        }

        const member = result.rows[0];

        // Get sons names
        await enrichMembersWithSonsNames([member], pool);

        return sendSuccess(
          response,
          200,
          "Members fetched successfully",
          member,
        );
      } catch (error) {
        console.error("Failed to fetch profile:", error.message);

        return response.status(500).json({
          error: "Failed to fetch profile",
        });
      }
    },
    async getMemberStats(request, response) {
      try {
        const query = `
          SELECT
            COUNT(*) AS total_members,
            COUNT(*) FILTER (
              WHERE created_at >= date_trunc('month', NOW()) AND created_at <= NOW()
            ) AS new_this_month,
            (
              SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
              FROM (
                SELECT m.id, m."firstName", m."firstNameEnglish", m."middleName", m."middleNameEnglish", m."surname", m."surnameEnglish", m."mobileNumber", m.gender, m."dateOfBirth", m.age, m."fatherId", m."sonIds", m.created_at,
                       CONCAT(f."firstName", ' ',f."middleName", ' ',f."surname") AS "fatherName"
                FROM members m
                LEFT JOIN members f ON m."fatherId" = f.id
                ORDER BY m.created_at DESC NULLS LAST, m.id DESC
                LIMIT 3
              ) t
            ) AS last_three
          FROM members
        `;

        const result = await pool.query(query);
        const row = result.rows[0] || {
          total_members: "0",
          new_this_month: "0",
          last_three: [],
        };

        // Enrich last three members with sons names
        const lastThreeMembers = row.last_three || [];
        await enrichMembersWithSonsNames(lastThreeMembers, pool);

        return sendSuccess(
          response,
          200,
          "Member statistics fetched successfully",
          {
            totalMembers: Number(row.total_members) || 0,
            newMembersThisMonth: Number(row.new_this_month) || 0,
            lastThreeMembers: lastThreeMembers,
          },
        );
      } catch (error) {
        console.error("Failed to fetch member stats:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to fetch member statistics" });
      }
    },

     async getAllMembersBySurname(request, response) {
      const surname = request.query.surname?.trim();
      const gender = request.query.gender?.trim()?.toLowerCase();

      if (!surname) {
        return response
          .status(400)
          .json({ error: 'Query parameter "surname" is required' });
      }

      // Validate gender if provided
      if (gender && gender !== "male" && gender !== "female") {
        return response.status(400).json({
          error: 'Query parameter "gender" must be either "male" or "female"',
        });
      }

      try {
        let query = `
      SELECT 
        m.*, 
        CONCAT(
          f."firstName", ' ',
          f."middleName", ' ',
          f."surname"
        ) AS "fatherName"
      FROM members m
      LEFT JOIN members f ON m."fatherId" = f.id
      WHERE m.surname ILIKE '%' || $1 || '%'
    `;

        const queryParams = [surname];

        // Apply gender filter only if gender is passed
        if (gender) {
          query += ` AND LOWER(TRIM(m.gender)) = $2`;
          queryParams.push(gender);
        }

        query += `
      ORDER BY 
        CASE LOWER(m.gender)
          WHEN 'male' THEN 1
          WHEN 'female' THEN 2
          ELSE 3
        END,
        m.surname ASC,
        m.id ASC
    `;

        const result = await pool.query(query, queryParams);

        // Keep the same response format
        const groupedMembers = {
          male: [],
          female: [],
        };

        for (const member of result.rows) {
          const genderKey = member.gender?.trim() || "Other";

          const normalizedGender =
            genderKey.toLowerCase() === "male"
              ? "male"
              : genderKey.toLowerCase() === "female"
                ? "female"
                : null;

          if (normalizedGender) {
            groupedMembers[normalizedGender].push(member);
          }
        }

        // Enrich with sons names
        await enrichMembersWithSonsNames(groupedMembers.male, pool);
        await enrichMembersWithSonsNames(groupedMembers.female, pool);

        return sendSuccess(
          response,
          200,
          "Members fetched by gender and surname successfully",
          [groupedMembers],
        );
      } catch (error) {
        console.error("Failed to fetch members by surname:", error.message);

        return response
          .status(500)
          .json({ error: "Failed to fetch members by surname" });
      }
    },

    async setMemberActive(request, response) {
      const memberId = parseMemberId(request, response);

      if (!memberId) {
        return;
      }

      const { isActive, is_active } = request.body;
      const targetActive = isActive !== undefined ? isActive : is_active;

      if (targetActive !== undefined && typeof targetActive !== "boolean") {
        return response
          .status(400)
          .json({ error: "isActive must be a boolean (true or false)" });
      }

      try {
        const existingResult = await pool.query(
          `SELECT id, "role", "isActive", "isDeleted" FROM members
           WHERE id = $1 AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [memberId],
        );

        if (existingResult.rowCount === 0) {
          return response.status(404).json({ error: "Member not found" });
        }

        const currentMember = existingResult.rows[0];
        const caller = request.member;

        // 1. Prevent self-deactivation
        if (caller && caller.id === currentMember.id) {
          return response.status(400).json({
            error: "You cannot change the active status of your own account",
          });
        }

        // 2. An ADMIN cannot activate/deactivate an ADMIN or SUPERADMIN
        if (
          caller &&
          caller.role === "ADMIN" &&
          (currentMember.role === "ADMIN" ||
            currentMember.role === "SUPERADMIN")
        ) {
          return response.status(403).json({
            error:
              "Forbidden: Admins can only activate or deactivate regular Users. Only a Super Admin can modify an Admin's status.",
          });
        }

        // 3. Prevent deactivating a SUPERADMIN
        if (currentMember.role === "SUPERADMIN") {
          return response.status(403).json({
            error: "Forbidden: Super Admin accounts cannot be deactivated.",
          });
        }

        const newActiveState =
          targetActive !== undefined ? targetActive : !currentMember.isActive;

        const result = await pool.query(
          `UPDATE members
           SET "isActive" = $1, "updated_at" = NOW()
           WHERE id = $2 AND COALESCE("isDeleted", false) = false
           RETURNING *`,
          [newActiveState, memberId],
        );

        await enrichMembersWithSonsNames(result.rows, pool);
        return sendSuccess(
          response,
          200,
          newActiveState
            ? "Member activated successfully"
            : "Member deactivated successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to update member active status:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to update member active status" });
      }
    },

    async deleteMember(request, response) {
      const memberId = parseMemberId(request, response);

      if (!memberId) {
        return;
      }

      try {
        const existingResult = await pool.query(
          `SELECT id, "role", "isDeleted" FROM members WHERE id = $1 LIMIT 1`,
          [memberId],
        );

        if (existingResult.rowCount === 0) {
          return response.status(404).json({ error: "Member not found" });
        }

        const currentMember = existingResult.rows[0];
        const caller = request.member;

        if (currentMember.isDeleted === true) {
          return response
            .status(400)
            .json({ error: "Member is already deleted" });
        }

        // 1. Prevent self-deletion
        if (caller && caller.id === currentMember.id) {
          return response
            .status(400)
            .json({ error: "You cannot delete your own account" });
        }

        // 2. An ADMIN cannot delete an ADMIN or SUPERADMIN
        if (
          caller &&
          caller.role === "ADMIN" &&
          (currentMember.role === "ADMIN" ||
            currentMember.role === "SUPERADMIN")
        ) {
          return response.status(403).json({
            error:
              "Forbidden: Admins can only delete regular Users. Only a Super Admin can delete an Admin.",
          });
        }

        // 3. Prevent deleting a SUPERADMIN
        if (currentMember.role === "SUPERADMIN") {
          return response.status(403).json({
            error: "Forbidden: Super Admin accounts cannot be deleted.",
          });
        }

        const result = await pool.query(
          `UPDATE members
           SET "isDeleted" = TRUE, "deletedBy" = $1, "isActive" = FALSE, "updated_at" = NOW()
           WHERE id = $2
           RETURNING id, "firstName", "surname", "isDeleted", "deletedBy", "updated_at"`,
          [request.member?.id || null, memberId],
        );

        return sendSuccess(response, 200, "Member deleted successfully", {
          id: result.rows[0].id,
          isDeleted: result.rows[0].isDeleted,
          deletedBy: result.rows[0].deletedBy,
        });
      } catch (error) {
        console.error("Failed to delete member:", error.message);
        return response.status(500).json({ error: "Failed to delete member" });
      }
    },

    async getMemberById(request, response) {
      const memberId = parseMemberId(request, response);

      console.log("Parsed memberId:", memberId);

      if (!memberId) {
        return;
      }

      try {
        const role = request.member?.role;
        console.log("User role:", role);

        if (!role) {
          return response.status(401).json({
            error: "Unauthorized",
          });
        }

        let query;
        let params;

        // ADMIN / SUPERADMIN can get any member
        if (role === "ADMIN" || role === "SUPERADMIN") {
          query = `
        SELECT
          m.*,
          CONCAT(
            f."firstName",
            ' ',
            f."middleName",
            ' ',
            f."surname"
          ) AS "fatherName"
        FROM members m
        LEFT JOIN members f
          ON m."fatherId" = f.id
        WHERE m.id = $1
        LIMIT 1
      `;

          params = [memberId];
        } else {
          // Normal USER can only get active,
          // approved and non-deleted members
          query = `
        SELECT
          m.*,
          CONCAT(
            f."firstName",
            ' ',
            f."middleName",
            ' ',
            f."surname"
          ) AS "fatherName"
        FROM members m
        LEFT JOIN members f
          ON m."fatherId" = f.id
        WHERE m.id = $1
          AND COALESCE(m."isActive", false) = true
          AND COALESCE(m."isDeleted", false) = false
          AND COALESCE(m."isApproved", false) = true
        LIMIT 1
      `;

          params = [memberId];
        }

        const result = await pool.query(query, params);

        if (result.rowCount === 0) {
          return response.status(404).json({
            error: "Member not found",
          });
        }

        const member = result.rows[0];

        // Get sons names
        await enrichMembersWithSonsNames([member], pool);

        return sendSuccess(
          response,
          200,
          "Members fetched successfully",
          member,
        );
      } catch (error) {
        console.error("Failed to get member by ID:", error.message);

        return response.status(500).json({
          error: "Failed to get member",
        });
      }
    },

     async updateMember(request, response) {
      // Member ID comes from URL params
      const memberId = parseMemberId(request, response);

      if (!memberId) {
        return;
      }

      // Logged-in user from auth middleware
      const caller = request.member;

      const callerRole = String(caller?.role || "").trim().toUpperCase();
      const callerId = Number(caller?.id);

      // ADMIN and SUPERADMIN can update any member
      const isElevatedUser =
        callerRole === "ADMIN" || callerRole === "SUPERADMIN";

      // USER can update only their own profile
      if (!isElevatedUser && callerId !== memberId) {
        return response.status(403).json({
          error: "Forbidden: You are only allowed to update your own profile",
        });
      }

      try {
        // Check target member exists and is not deleted
        const existingResult = await pool.query(
          `SELECT id, "isDeleted", "mobileNumber"
       FROM members
       WHERE id = $1
         AND COALESCE("isDeleted", false) = false
       LIMIT 1`,
          [memberId],
        );

        if (existingResult.rowCount === 0) {
          return response.status(404).json({
            error: "Member not found",
          });
        }

        const updateData = { ...request.body };

        delete updateData.facmToken;
        delete updateData.fcmToken;

        // -----------------------------
        // Parse / Normalize Fields
        // -----------------------------

        if (updateData.age !== undefined && updateData.age !== "") {
          updateData.age = Number(updateData.age);
        }

        // fatherId
        if (updateData.fatherId !== undefined) {
          if (
            updateData.fatherId === null ||
            updateData.fatherId === "" ||
            updateData.fatherId === "null"
          ) {
            updateData.fatherId = null;
          } else {
            updateData.fatherId = Number(updateData.fatherId);
          }
        }

        // sonIds
        if (updateData.sonIds !== undefined) {
          if (
            updateData.sonIds === null ||
            updateData.sonIds === "" ||
            updateData.sonIds === "null" ||
            (Array.isArray(updateData.sonIds) &&
              updateData.sonIds.length === 0) ||
            updateData.sonIds === "[]"
          ) {
            updateData.sonIds = null;
          } else {
            updateData.sonIds = parseRegistrationArray(updateData.sonIds);
          }
        }

        if (updateData.mobileNumber !== undefined) {
          updateData.mobileNumber = normalizeMobileNumber(
            updateData.mobileNumber,
          );
        }

        // If photo is uploaded
        if (request.file) {
          updateData.photo_url = `/uploads/members/${request.file.filename}`;
        }

        // -----------------------------
        // Validate Update Data
        // -----------------------------

        const validationError = validateMemberUpdate(updateData);

        if (validationError && !request.file) {
          return response.status(400).json(validationError);
        }

        // -----------------------------
        // Check Duplicate Mobile Number
        // -----------------------------

        const existingMobileNumber = normalizeMobileNumber(
          existingResult.rows[0].mobileNumber,
        );

        if (
          updateData.mobileNumber &&
          updateData.mobileNumber !== existingMobileNumber
        ) {
          const duplicateCheck = await pool.query(
            `SELECT id
         FROM members
         WHERE "mobileNumber" = $1
           AND id != $2
           AND COALESCE("isDeleted", false) = false
         LIMIT 1`,
            [updateData.mobileNumber, memberId],
          );

          if (duplicateCheck.rowCount > 0) {
            return response.status(409).json({
              error: "Mobile number is already registered to another member",
            });
          }
        }

        // -----------------------------
        // Allowed Editable Fields
        // -----------------------------

        const allowedFields = [
          "firstName",
          "firstNameEnglish",
          "middleName",
          "middleNameEnglish",
          "surname",
          "surnameEnglish",
          "mobileNumber",
          "gender",
          "dateOfBirth",
          "age",

          // Mobile side fields
          "currentAddress",
          "latlng",

          "sonIds",
          "fatherId",
          "photo_url",
        ];

        const fieldsToUpdate = allowedFields.filter(
          (field) => updateData[field] !== undefined,
        );

        if (fieldsToUpdate.length === 0) {
          return response.status(400).json({
            error: "At least one valid member field is required to update",
          });
        }

        // -----------------------------
        // Build Dynamic UPDATE Query
        // -----------------------------

        const values = fieldsToUpdate.map((field) => updateData[field]);

        const assignments = fieldsToUpdate.map(
          (field, index) => `"${field}" = $${index + 1}`,
        );

        await pool.query(
          `UPDATE members
       SET ${assignments.join(", ")},
           "updated_at" = NOW()
       WHERE id = $${fieldsToUpdate.length + 1}`,
          [...values, memberId],
        );

        // -----------------------------
        // Get Updated Member
        // -----------------------------

        const memberWithFather = await pool.query(
          `SELECT
         m.*,
         CONCAT(
           f."firstName",
           ' ',
           f."middleName",
           ' ',
           f."surname"
         ) AS "fatherName"
       FROM members m
       LEFT JOIN members f
         ON m."fatherId" = f.id
       WHERE m.id = $1`,
          [memberId],
        );

        // -----------------------------
        // Enrich Sons Names
        // -----------------------------

        await enrichMembersWithSonsNames(memberWithFather.rows, pool);

        // -----------------------------
        // Success Response
        // -----------------------------

        return sendSuccess(
          response,
          200,
          "Member profile updated successfully",
          memberWithFather.rows[0],
        );
      } catch (error) {
        // Foreign key error
        if (error.code === "23503") {
          return response.status(400).json({
            error: "fatherId does not reference an existing member",
          });
        }

        console.error("Failed to update profile:", error.message);

        return response.status(500).json({
          error: "Failed to update profile",
        });
      }
    },

    async updateProfile(request, response) {
      // Member ID comes from Authorization token
      const caller = request.member;

      if (!caller || !caller.id) {
        return response.status(401).json({
          error: "Unauthorized: Invalid or missing authorization token",
        });
      }

      const memberId = Number(caller.id);

      if (!Number.isInteger(memberId) || memberId <= 0) {
        return response.status(401).json({
          error: "Unauthorized: Invalid member ID in authorization token",
        });
      }

      // Logged-in user from auth middleware
      const callerRole = caller?.role?.trim()?.toUpperCase();
      const callerId = Number(caller?.id);

      // ADMIN and SUPERADMIN can update any member
      const isElevatedUser =
        callerRole === "ADMIN" || callerRole === "SUPERADMIN";

      // USER can update only their own profile
      if (!isElevatedUser && callerId !== memberId) {
        return response.status(403).json({
          error: "Forbidden: You are only allowed to update your own profile",
        });
      }

      try {
        // Check target member exists and is not deleted
        const existingResult = await pool.query(
          `SELECT id, "isDeleted", "mobileNumber"
       FROM members
       WHERE id = $1
         AND COALESCE("isDeleted", false) = false
       LIMIT 1`,
          [memberId],
        );

        if (existingResult.rowCount === 0) {
          return response.status(404).json({
            error: "Member not found",
          });
        }

        const updateData = { ...request.body };

        // -----------------------------
        // Parse / Normalize Fields
        // -----------------------------

        if (updateData.age !== undefined && updateData.age !== "") {
          updateData.age = Number(updateData.age);
        }

        // fatherId
        if (updateData.fatherId !== undefined) {
          if (
            updateData.fatherId === null ||
            updateData.fatherId === "" ||
            updateData.fatherId === "null"
          ) {
            updateData.fatherId = null;
          } else {
            updateData.fatherId = Number(updateData.fatherId);
          }
        }

        // sonIds
        if (updateData.sonIds !== undefined) {
          if (
            updateData.sonIds === null ||
            updateData.sonIds === "" ||
            updateData.sonIds === "null" ||
            (Array.isArray(updateData.sonIds) &&
              updateData.sonIds.length === 0) ||
            updateData.sonIds === "[]"
          ) {
            updateData.sonIds = null;
          } else {
            updateData.sonIds = parseRegistrationArray(updateData.sonIds);
          }
        }

        if (updateData.mobileNumber !== undefined) {
          updateData.mobileNumber = normalizeMobileNumber(
            updateData.mobileNumber,
          );
        }

        // If photo is uploaded
        if (request.file) {
          updateData.photo_url = `/uploads/members/${request.file.filename}`;
        }

        // -----------------------------
        // Validate Update Data
        // -----------------------------

        const validationError = validateMemberUpdate(updateData);

        if (validationError && !request.file) {
          return response.status(400).json(validationError);
        }

        // -----------------------------
        // Check Duplicate Mobile Number
        // -----------------------------

        const existingMobileNumber = normalizeMobileNumber(
          existingResult.rows[0].mobileNumber,
        );

        if (
          updateData.mobileNumber &&
          updateData.mobileNumber !== existingMobileNumber
        ) {
          const duplicateCheck = await pool.query(
            `SELECT id
         FROM members
         WHERE "mobileNumber" = $1
           AND id != $2
           AND COALESCE("isDeleted", false) = false
         LIMIT 1`,
            [updateData.mobileNumber, memberId],
          );

          if (duplicateCheck.rowCount > 0) {
            return response.status(409).json({
              error: "Mobile number is already registered to another member",
            });
          }
        }

        // -----------------------------
        // Allowed Editable Fields
        // -----------------------------

        const allowedFields = [
          "firstName",
          "firstNameEnglish",
          "middleName",
          "middleNameEnglish",
          "surname",
          "surnameEnglish",
          "mobileNumber",
          "gender",
          "dateOfBirth",
          "age",

          // Mobile side fields
          "currentAddress",
          "latlng",

          "sonIds",
          "fatherId",
          "photo_url",
        ];

        const fieldsToUpdate = allowedFields.filter(
          (field) => updateData[field] !== undefined,
        );

        if (fieldsToUpdate.length === 0) {
          return response.status(400).json({
            error: "At least one valid member field is required to update",
          });
        }

        // -----------------------------
        // Build Dynamic UPDATE Query
        // -----------------------------

        const values = fieldsToUpdate.map((field) => updateData[field]);

        const assignments = fieldsToUpdate.map(
          (field, index) => `"${field}" = $${index + 1}`,
        );

        await pool.query(
          `UPDATE members
       SET ${assignments.join(", ")},
           "updated_at" = NOW()
       WHERE id = $${fieldsToUpdate.length + 1}`,
          [...values, memberId],
        );

        // -----------------------------
        // Get Updated Member
        // -----------------------------

        const memberWithFather = await pool.query(
          `SELECT
         m.*,
         CONCAT(
           f."firstName",
           ' ',
           f."middleName",
           ' ',
           f."surname"
         ) AS "fatherName"
       FROM members m
       LEFT JOIN members f
         ON m."fatherId" = f.id
       WHERE m.id = $1`,
          [memberId],
        );

        // -----------------------------
        // Enrich Sons Names
        // -----------------------------

        await enrichMembersWithSonsNames(memberWithFather.rows, pool);

        // -----------------------------
        // Success Response
        // -----------------------------

        return sendSuccess(
          response,
          200,
          "Member profile updated successfully",
          memberWithFather.rows[0],
        );
      } catch (error) {
        // Foreign key error
        if (error.code === "23503") {
          return response.status(400).json({
            error: "fatherId does not reference an existing member",
          });
        }

        console.error("Failed to update profile:", error.message);

        return response.status(500).json({
          error: "Failed to update profile",
        });
      }
    },

    async uploadPhoto(request, response) {
      if (!request.file) {
        return response.status(400).json({ error: "No photo provided" });
      }
      const photoUrl = `/uploads/members/${request.file.filename}`;
      return sendSuccess(response, 200, "Photo uploaded successfully", {
        photoUrl,
      });
    },
  };
}

module.exports = {
  memberController,
  memberRegistrationUpload,

  ensureMembersTable,
  ensureOtpVerificationsTable,
};
