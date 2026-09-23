const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { sendSuccess } = require("../utils/response");
const {
  generateToken,
  memberResponse,
  calculateAgeFromDob,
} = require("./auth.controller");
const { processRelationshipRequest } = require("./relationship.controller");

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
    age INTEGER CHECK (age >= 0),
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
  "role" TEXT NOT NULL DEFAULT 'USER' CHECK ("role" IN ('USER', 'ADMIN', 'SUPERADMIN')),
    "sonIds" BIGINT[],
  "fatherId" BIGINT REFERENCES members(id) ON DELETE SET NULL,
    "fcmToken" TEXT,
    "passwordHash" TEXT,
  "isPasswordChange" BOOLEAN NOT NULL DEFAULT FALSE
  )
`;

function normalizeMobileNumber(value) {
  return String(value || "").replace(/[\s()-]/g, "");
}

function parseRegistrationArray(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "number") return [value];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(Number);
    if (Number.isInteger(Number(parsed))) return [Number(parsed)];
    return [];
  } catch {
    const values = String(value)
      .split(",")
      .map((item) => Number(item.trim()));
    return values.every(Number.isFinite) ? values : [];
  }
}

function normalizeSonIds(body) {
  const rawValue =
    body?.sonIds ?? body?.["sonIds[]"] ?? body?.sons ?? body?.["sons[]"];

  if (
    rawValue === undefined ||
    rawValue === null ||
    rawValue === "" ||
    rawValue === "null" ||
    rawValue === "[]"
  ) {
    return { provided: rawValue !== undefined, value: null };
  }

  const parsedIds = parseRegistrationArray(rawValue).filter(
    (id) => Number.isInteger(id) && id > 0,
  );

  return { provided: true, value: [...new Set(parsedIds)] };
}

function withComputedAge(member) {
  if (!member) return member;

  return {
    ...member,
    age: calculateAgeFromDob(member.dateOfBirth ?? member.DateOfBirth),
  };
}

function buildRegistrationPayload(body, file) {
  const sonIds = parseRegistrationArray(body?.sonIds);

  return {
    ...body,
    age:
      body?.age === undefined || body.age === "" || body.age === null
        ? null
        : Number(body.age),
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

async function syncMemberSequence(pool) {
  await pool.query(`
    SELECT setval(
      pg_get_serial_sequence('members', 'id'),
      COALESCE((SELECT MAX(id) FROM members), 0) + 1,
      false
    );
  `);
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
    ADD COLUMN IF NOT EXISTS "firstName" TEXT,
    ADD COLUMN IF NOT EXISTS "firstNameEnglish" TEXT,
    ADD COLUMN IF NOT EXISTS "middleName" TEXT,
    ADD COLUMN IF NOT EXISTS "middleNameEnglish" TEXT,
    ADD COLUMN IF NOT EXISTS surname TEXT,
    ADD COLUMN IF NOT EXISTS "surnameEnglish" TEXT,
    ADD COLUMN IF NOT EXISTS "mobileNumber" TEXT,
    ADD COLUMN IF NOT EXISTS gender TEXT,
    ADD COLUMN IF NOT EXISTS "dateOfBirth" TEXT,
    ADD COLUMN IF NOT EXISTS age INTEGER,
    ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "deletedBy" BIGINT REFERENCES members(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "isApproved" BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "approvedBy" BIGINT REFERENCES members(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS "photo_url" TEXT,
    ADD COLUMN IF NOT EXISTS "currentAddress" TEXT,
    ADD COLUMN IF NOT EXISTS latlng TEXT,
    ADD COLUMN IF NOT EXISTS "role" TEXT DEFAULT 'USER',
    ADD COLUMN IF NOT EXISTS "sonIds" BIGINT[],
    ADD COLUMN IF NOT EXISTS "fatherId" BIGINT REFERENCES members(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "fcmToken" TEXT,
    ADD COLUMN IF NOT EXISTS "passwordHash" TEXT,
    ADD COLUMN IF NOT EXISTS "isPasswordChange" BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await pool.query(`
    UPDATE members SET "isApproved" = FALSE WHERE "isApproved" IS NULL;
    ALTER TABLE members
    ALTER COLUMN "isApproved" SET DEFAULT FALSE;
  `);
  await pool.query(`
    ALTER TABLE members DROP CONSTRAINT IF EXISTS members_age_check;
    ALTER TABLE members ALTER COLUMN age DROP NOT NULL;
    ALTER TABLE members ALTER COLUMN age DROP DEFAULT;
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

  if (member.age !== undefined && member.age !== null) {
    const parsedAge = Number(member.age);
    if (!Number.isInteger(parsedAge) || parsedAge < 0) {
      return { error: "age must be a non-negative integer" };
    }
  }
  if (!/^\d{10}$/.test(member.mobileNumber)) {
    return { error: "mobileNumber must be a valid 10-digit number" };
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

async function handleRelationshipUpdate(
  pool,
  memberId,
  existingMember,
  updateData,
) {
  const existingFatherId = existingMember.fatherId
    ? Number(existingMember.fatherId)
    : null;
  const existingSonIds = Array.isArray(existingMember.sonIds)
    ? existingMember.sonIds.map(Number)
    : [];
  const pendingRequestsCreated = [];

  // 1. Father handling
  if (updateData.fatherId !== undefined) {
    if (
      updateData.fatherId === null ||
      updateData.fatherId === "" ||
      updateData.fatherId === "null" ||
      updateData.fatherId === 0 ||
      updateData.fatherId === "0"
    ) {
      // Immediate removal of existing father
      if (existingFatherId) {
        await pool.query(
          `UPDATE members SET "sonIds" = array_remove("sonIds", $1::bigint), "updated_at" = NOW() WHERE id = $2`,
          [memberId, existingFatherId],
        );
      }
      // Cancel pending father requests if any
      await pool.query(
        `UPDATE relationship_requests SET status = 'CANCELLED', updated_at = NOW() WHERE requester_id = $1 AND relationship_type = 'FATHER' AND status = 'PENDING'`,
        [memberId],
      );
      updateData.fatherId = null;
    } else {
      const requestedFatherId = Number(updateData.fatherId);
      if (requestedFatherId === existingFatherId) {
        // No change, omit from direct column update
        delete updateData.fatherId;
      } else {
        // Approval-based: Do NOT set fatherId on member immediately
        delete updateData.fatherId;
        const reqRecord = await processRelationshipRequest(
          pool,
          memberId,
          requestedFatherId,
          "FATHER",
        );
        pendingRequestsCreated.push({
          type: "FATHER",
          targetId: requestedFatherId,
          requestId: reqRecord.id,
        });
      }
    }
  }

  // 2. Son handling
  if (updateData.sonIds !== undefined) {
    const requestedSonIds = Array.isArray(updateData.sonIds)
      ? updateData.sonIds.map(Number).filter(Number.isInteger)
      : [];

    // A) Removed sons (was in existing, but not in requested) -> immediate unlinking
    const removedSons = existingSonIds.filter(
      (id) => !requestedSonIds.includes(id),
    );
    for (const sonId of removedSons) {
      await pool.query(
        `UPDATE members SET "fatherId" = NULL, "updated_at" = NOW() WHERE id = $1 AND "fatherId" = $2`,
        [sonId, memberId],
      );
    }

    // B) Retained sons (in both)
    const retainedSons = existingSonIds.filter((id) =>
      requestedSonIds.includes(id),
    );

    // C) Newly added sons (in requested, not in existing) -> pending approval
    const newlyAddedSons = requestedSonIds.filter(
      (id) => !existingSonIds.includes(id),
    );
    for (const sonId of newlyAddedSons) {
      const reqRecord = await processRelationshipRequest(
        pool,
        memberId,
        sonId,
        "SON",
      );
      pendingRequestsCreated.push({
        type: "SON",
        targetId: sonId,
        requestId: reqRecord.id,
      });
    }

    // Active sonIds column retains only approved sons
    updateData.sonIds = retainedSons.length > 0 ? retainedSons : null;
  }

  return pendingRequestsCreated;
}

async function updateRelationshipsDirectly(
  pool,
  memberId,
  existingMember,
  updateData,
) {
  const existingFatherId = existingMember.fatherId
    ? Number(existingMember.fatherId)
    : null;
  const existingSonIds = Array.isArray(existingMember.sonIds)
    ? existingMember.sonIds.map(Number)
    : [];

  if (updateData.fatherId !== undefined) {
    const fatherId =
      updateData.fatherId === null ? null : Number(updateData.fatherId);

    if (fatherId === memberId) {
      throw new Error("fatherId cannot be the member itself");
    }

    if (fatherId !== null) {
      const fatherResult = await pool.query(
        `SELECT id FROM members
         WHERE id = $1 AND COALESCE("isDeleted", false) = false
         LIMIT 1`,
        [fatherId],
      );
      if (fatherResult.rowCount === 0) {
        throw new Error("fatherId does not reference an existing member");
      }
    }

    if (existingFatherId && existingFatherId !== fatherId) {
      await pool.query(
        `UPDATE members
         SET "sonIds" = array_remove(COALESCE("sonIds", ARRAY[]::bigint[]), $1::bigint),
             "updated_at" = NOW()
         WHERE id = $2`,
        [memberId, existingFatherId],
      );
    }

    if (fatherId && fatherId !== existingFatherId) {
      await pool.query(
        `UPDATE members
         SET "sonIds" = array_append(
               array_remove(COALESCE("sonIds", ARRAY[]::bigint[]), $1::bigint),
               $1::bigint
             ), "updated_at" = NOW()
         WHERE id = $2`,
        [memberId, fatherId],
      );
    }

    updateData.fatherId = fatherId;
  }

  if (updateData.sonIds !== undefined) {
    const sonIds = Array.isArray(updateData.sonIds)
      ? [...new Set(updateData.sonIds.map(Number))]
      : [];

    if (
      sonIds.some(
        (sonId) => !Number.isInteger(sonId) || sonId < 1 || sonId === memberId,
      )
    ) {
      throw new Error(
        "sonIds must contain valid member IDs and cannot include the member itself",
      );
    }

    if (sonIds.length > 0) {
      const sonsResult = await pool.query(
        `SELECT id FROM members
         WHERE id = ANY($1::bigint[]) AND COALESCE("isDeleted", false) = false`,
        [sonIds],
      );
      if (sonsResult.rowCount !== sonIds.length) {
        throw new Error("sonIds contains a member that does not exist");
      }
    }

    const removedSonIds = existingSonIds.filter(
      (sonId) => !sonIds.includes(sonId),
    );
    if (removedSonIds.length > 0) {
      await pool.query(
        `UPDATE members
         SET "fatherId" = NULL, "updated_at" = NOW()
         WHERE id = ANY($1::bigint[]) AND "fatherId" = $2`,
        [removedSonIds, memberId],
      );
    }

    if (sonIds.length > 0) {
      await pool.query(
        `UPDATE members AS father
         SET "sonIds" = ARRAY(
               SELECT son_id
               FROM unnest(COALESCE(father."sonIds", ARRAY[]::bigint[])) AS son_id
               WHERE son_id <> ALL($1::bigint[])
             ), "updated_at" = NOW()
         WHERE father.id IN (
           SELECT "fatherId"
           FROM members
           WHERE id = ANY($1::bigint[])
             AND "fatherId" IS NOT NULL
             AND "fatherId" <> $2
         )`,
        [sonIds, memberId],
      );

      await pool.query(
        `UPDATE members
         SET "fatherId" = $1, "updated_at" = NOW()
         WHERE id = ANY($2::bigint[])`,
        [memberId, sonIds],
      );
    }

    updateData.sonIds = sonIds.length > 0 ? sonIds : null;
  }
}

function memberController(pool) {
  return {
    async register(request, response) {
      const payload = buildRegistrationPayload(request.body, request.file);
      const isAdminAddMember =
        request.route?.path === "/addMember" &&
        ["ADMIN", "SUPERADMIN"].includes(
          String(request.member?.role || "").toUpperCase(),
        );
      const password = String(
        request.body?.password || (isAdminAddMember ? "123456" : ""),
      );
      const confirmPassword = String(
        request.body?.confirmPassword ||
          (isAdminAddMember ? "123456" : ""),
      );

      if (!password || !confirmPassword) {
        return response.status(400).json({
          error: "password and confirmPassword are required",
        });
      }
      if (password !== confirmPassword) {
        return response.status(400).json({ error: "Passwords do not match" });
      }
      const validationError = validateMember(payload);
      if (validationError) {
        return response.status(400).json(validationError);
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existingMember = await client.query(
          `SELECT id FROM members
           WHERE "mobileNumber" = $1 AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [payload.mobileNumber],
        );
        if (existingMember.rowCount > 0) {
          await client.query("ROLLBACK");
          return response.status(409).json({
            error: "Mobile number is already registered",
          });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        await syncMemberSequence(client);
        const memberResult = await client.query(
          `INSERT INTO members (
              "firstName", "firstNameEnglish", "middleName", "middleNameEnglish",
              surname, "surnameEnglish", "mobileNumber", "passwordHash", gender,
              "dateOfBirth", "currentAddress", "latlng", "sonIds", "fatherId",
              "photo_url", "created_at", "fcmToken"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $12, $13, $14, $15, $16, NOW(), $17)
            RETURNING *`,
          [
            payload.firstName,
            payload.firstNameEnglish,
            payload.middleName,
            payload.middleNameEnglish,
            payload.surname,
            payload.surnameEnglish,
            payload.mobileNumber,
            passwordHash,
            payload.gender,
            payload.dateOfBirth,
            payload.currentAddress,
            payload.latlng,
            payload.sonIds,
            payload.fatherId,
            payload.photoUrl,
            payload.fcmToken,
          ],
        );
        await client.query("COMMIT");

        const member = memberResult.rows[0];
        return sendSuccess(response, 200, "Register Successfully", {
          member: memberResponse(member),
          token: generateToken(member),
        });
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23503") {
          return response.status(400).json({
            error: "fatherId does not reference an existing member",
          });
        }
        console.error("Failed to register member:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to register member" });
      } finally {
        client.release();
      }
    },

    async changePassword(request, response) {
      const oldPassword = String(request.body?.oldPassword || "");
      const newPassword = String(request.body?.newPassword || "");
      const confirmPassword = String(request.body?.confirmPassword || "");
      const dateOfBirth = request.body?.dateOfBirth;

      if (!oldPassword || !newPassword || !confirmPassword) {
        return response.status(400).json({
          error: "oldPassword, newPassword and confirmPassword are required",
        });
      }
      if (newPassword !== confirmPassword) {
        return response.status(400).json({ error: "Passwords do not match" });
      }
      if (newPassword === oldPassword) {
        return response.status(400).json({
          error: "New password must be different from old password",
        });
      }

      try {
        const memberResult = await pool.query(
          `SELECT id, "passwordHash" FROM members
           WHERE id = $1 AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [request.member.id],
        );

        if (memberResult.rowCount === 0 || !memberResult.rows[0].passwordHash) {
          return response.status(401).json({ error: "Invalid old password" });
        }

        const passwordMatches = await bcrypt.compare(
          oldPassword,
          memberResult.rows[0].passwordHash,
        );
        if (!passwordMatches) {
          return response.status(401).json({ error: "Invalid old password" });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        const updateValues = [passwordHash, request.member.id];
        const dateOfBirthUpdate =
          dateOfBirth !== undefined && dateOfBirth !== null && dateOfBirth !== ""
            ? `, "dateOfBirth" = $${updateValues.push(String(dateOfBirth))}`
            : "";
        const updatedMemberResult = await pool.query(
          `UPDATE members
           SET "passwordHash" = $1, "updated_at" = NOW(), "isPasswordChange" = true${dateOfBirthUpdate}
           WHERE id = $2
           RETURNING *`,
          updateValues,
        );

        const updatedMember = updatedMemberResult.rows[0];
        return sendSuccess(response, 200, "Password changed successfully", {
          member: memberResponse(updatedMember),
          token: generateToken(updatedMember),
        });
      } catch (error) {
        console.error("Failed to change member password:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to change password" });
      }
    },

    async setPassword(request, response) {
      const hasIdParam =
        request.params?.id !== undefined &&
        request.params?.id !== null &&
        request.params?.id !== "";
      const oldPassword = String(request.body?.oldPassword || "");
      const newPassword = String(request.body?.newPassword || "");
      const confirmPassword = String(request.body?.confirmPassword || "");

      let memberId;
      let isSelfChange = false;

      if (!hasIdParam) {
        // URL ma :id nathi -> token mathi logged-in user no id levano
        memberId = Number(request.member?.id);
        isSelfChange = true;

        if (!memberId) {
          return response
            .status(401)
            .json({ error: "Invalid or missing user token" });
        }
      } else {
        // URL ma :id che -> requester ADMIN/SUPERADMIN j hovo joie
        const requesterRole = String(request.member?.role || "").toUpperCase();
        const isAdmin =
          requesterRole === "ADMIN" || requesterRole === "SUPERADMIN";

        if (!isAdmin) {
          return response.status(403).json({
            error:
              "Only ADMIN or SUPERADMIN can set password for other accounts",
          });
        }

        memberId = parseMemberId(request, response);
        if (!memberId) {
          return;
        }
      }

      if (!oldPassword || !newPassword || !confirmPassword) {
        return response.status(400).json({
          error: "oldPassword, newPassword and confirmPassword are required",
        });
      }
      if (newPassword !== confirmPassword) {
        return response.status(400).json({ error: "Passwords do not match" });
      }
      if (newPassword.length < 6) {
        return response.status(400).json({
          error: "Password must be at least 6 characters",
        });
      }

      try {
        const memberResult = await pool.query(
          `SELECT "passwordHash" FROM members
           WHERE id = $1 AND COALESCE("isDeleted", false) = false
           LIMIT 1`,
          [memberId],
        );

        if (
          memberResult.rowCount === 0 ||
          !memberResult.rows[0].passwordHash ||
          !(await bcrypt.compare(
            oldPassword,
            memberResult.rows[0].passwordHash,
          ))
        ) {
          return response.status(401).json({ error: "Invalid old password" });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);

        const queryText = `UPDATE members
         SET "passwordHash" = $1, "isPasswordChange" = true, "updated_at" = NOW()
         WHERE id = $2
           AND COALESCE("isDeleted", false) = false
         RETURNING id`;

        const result = await pool.query(queryText, [passwordHash, memberId]);

        if (result.rowCount === 0) {
          return response.status(409).json({
            error: isSelfChange
              ? "Unable to update password for this account"
              : "Password is already set for this account",
          });
        }

        return sendSuccess(response, 200, "Password set successfully");
      } catch (error) {
        console.error("Failed to set member password:", error.message);
        return response.status(500).json({ error: "Failed to set password" });
      }
    },

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

    /* Legacy OTP registration handlers are disabled; registration is direct.
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

        const createdMember = withComputedAge(memberWithFather.rows[0]);

        return sendSuccess(
          response,
          201,
          "Member registered successfully",
          createdMember,
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

    */
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

        const maleMembers = groupedMembers.male.map(withComputedAge);
        const femaleMembers = groupedMembers.female.map(withComputedAge);

        await enrichMembersWithSonsNames(maleMembers, pool);
        await enrichMembersWithSonsNames(femaleMembers, pool);

        return sendSuccess(response, 200, "Members fetched successfully", [
          { male: maleMembers, female: femaleMembers },
        ]);
      } catch (error) {
        console.error("Failed to fetch members:", error.message);

        return response.status(500).json({
          error: "Failed to fetch members",
        });
      }
    },

    async getUpcomingBirthdays(request, response) {
      try {
        const result = await pool.query(`
          WITH parsed_members AS (
            SELECT
              m.*,
              CASE
                WHEN TRIM(m."dateOfBirth") ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$'
                  THEN TO_DATE(TRIM(m."dateOfBirth"), 'DD-MM-YYYY')
                WHEN TRIM(m."dateOfBirth") ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN TO_DATE(TRIM(m."dateOfBirth"), 'YYYY-MM-DD')
                ELSE NULL
              END AS birth_date
            FROM members m
            WHERE COALESCE(m."isDeleted", false) = false
              AND COALESCE(m."isActive", true) = true
          )
          SELECT
            p.*,
            upcoming.day::date AS "upcomingBirthday"
          FROM parsed_members p
          CROSS JOIN LATERAL (
            SELECT day
            FROM generate_series(
              CURRENT_DATE - INTERVAL '1 day',
              CURRENT_DATE + INTERVAL '7 days',
              INTERVAL '1 day'
            ) AS day
            WHERE TO_CHAR(day, 'MMDD') = TO_CHAR(p.birth_date, 'MMDD')
            ORDER BY day
            LIMIT 1
          ) upcoming
          ORDER BY upcoming.day, p."firstName", p.surname
        `);

        return sendSuccess(
          response,
          200,
          "Upcoming birthdays fetched successfully",
          result.rows,
        );
      } catch (error) {
        console.error("Failed to fetch upcoming birthdays:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to fetch upcoming birthdays" });
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

        // Fetch pending outgoing relationship requests
        const pendingOutgoing = await pool.query(
          `SELECT r.id, r.target_id, r.relationship_type, r.status, r.created_at,
                  CONCAT(m."firstName", ' ', m."middleName", ' ', m."surname") AS "targetName",
                  m."photo_url" AS "targetPhotoUrl"
           FROM relationship_requests r
           JOIN members m ON r.target_id = m.id
           WHERE r.requester_id = $1 AND r.status = 'PENDING'
           ORDER BY r.created_at DESC`,
          [memberId],
        );

        // Fetch pending incoming relationship requests
        const pendingIncoming = await pool.query(
          `SELECT r.id, r.requester_id, r.relationship_type, r.status, r.created_at,
                  CONCAT(m."firstName", ' ', m."middleName", ' ', m."surname") AS "requesterName",
                  m."photo_url" AS "requesterPhotoUrl"
           FROM relationship_requests r
           JOIN members m ON r.requester_id = m.id
           WHERE r.target_id = $1 AND r.status = 'PENDING'
           ORDER BY r.created_at DESC`,
          [memberId],
        );

        member.pendingOutgoingRequests = pendingOutgoing.rows;
        member.pendingIncomingRequests = pendingIncoming.rows;

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
                SELECT m.id, m."firstName", m."firstNameEnglish", m."middleName", m."middleNameEnglish", m."surname", m."surnameEnglish", m."mobileNumber", m.gender, m."dateOfBirth",
                       CASE
                         WHEN m."dateOfBirth" IS NULL OR TRIM(m."dateOfBirth") = '' THEN NULL
                         WHEN TRIM(m."dateOfBirth") ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$'
                           THEN DATE_PART('year', AGE(CURRENT_DATE, TO_DATE(TRIM(m."dateOfBirth"), 'DD-MM-YYYY')))
                         WHEN TRIM(m."dateOfBirth") ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                           THEN DATE_PART('year', AGE(CURRENT_DATE, TO_DATE(TRIM(m."dateOfBirth"), 'YYYY-MM-DD')))
                         ELSE NULL
                       END AS age,
                       m."fatherId", m."sonIds", m.created_at,
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
        const lastThreeMembers = (row.last_three || []).map(withComputedAge);
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
    async getSurnames(request, response) {
      try {
        const result = await pool.query(`
          SELECT
            TRIM(surname) AS surname,
            COUNT(*)::INTEGER AS "memberCount"
          FROM members
          WHERE NULLIF(TRIM(surname), '') IS NOT NULL
          GROUP BY TRIM(surname)
          ORDER BY LOWER(TRIM(surname)), TRIM(surname)
        `);

        return sendSuccess(response, 200, "Surnames fetched successfully", {
          surnameWiseCounts: result.rows,
        });
      } catch (error) {
        console.error("Failed to fetch surnames:", error.message);
        return response.status(500).json({ error: "Failed to fetch surnames" });
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

    async deleteAccount(request, response) {
      const memberId = Number(request.member?.id);

      if (!Number.isInteger(memberId) || memberId <= 0) {
        return response.status(401).json({ error: "Unauthorized" });
      }

      try {
        const result = await pool.query(
          `UPDATE members
           SET "isDeleted" = TRUE,
               "deletedBy" = $1,
               "isActive" = FALSE,
               "fcmToken" = NULL,
               "updated_at" = NOW()
           WHERE id = $1
             AND COALESCE("isDeleted", false) = false
           RETURNING id, "isDeleted", "isActive", "deletedBy", "updated_at"`,
          [memberId],
        );

        if (result.rowCount === 0) {
          return response.status(404).json({ error: "Member not found" });
        }

        return sendSuccess(response, 200, "Account deleted successfully", {
          id: result.rows[0].id,
          isDeleted: result.rows[0].isDeleted,
          isActive: result.rows[0].isActive,
          deletedBy: result.rows[0].deletedBy,
        });
      } catch (error) {
        console.error("Failed to delete account:", error.message);
        return response.status(500).json({ error: "Failed to delete account" });
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

      const callerRole = String(caller?.role || "")
        .trim()
        .toUpperCase();
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
          `SELECT id, "isDeleted", "mobileNumber", "fatherId", "sonIds"
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

        if (updateData.fcmToken === undefined && updateData.fcm_token !== undefined) {
          updateData.fcmToken = updateData.fcm_token;
          delete updateData.fcm_token;
        }

        if (typeof updateData.fcmToken === "string") {
          updateData.fcmToken = updateData.fcmToken.trim();
        }

        // -----------------------------
        // Parse / Normalize Fields
        // -----------------------------

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
        const normalizedSonIds = normalizeSonIds(updateData);
        if (normalizedSonIds.provided) {
          updateData.sonIds = normalizedSonIds.value;
          delete updateData["sonIds[]"];
          delete updateData.sons;
          delete updateData["sons[]"];
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
        // Handle Approval-based Relationships
        // -----------------------------
        let pendingRequestsCreated = [];
        if (
          updateData.fatherId !== undefined ||
          updateData.sonIds !== undefined
        ) {
          try {
            if (isElevatedUser && callerId !== memberId) {
              await updateRelationshipsDirectly(
                pool,
                memberId,
                existingResult.rows[0],
                updateData,
              );
            } else {
              pendingRequestsCreated = await handleRelationshipUpdate(
                pool,
                memberId,
                existingResult.rows[0],
                updateData,
              );
            }
          } catch (relError) {
            return response.status(400).json({ error: relError.message });
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

          // Mobile side fields
          "currentAddress",
          "latlng",

          "sonIds",
          "fatherId",
          "photo_url",
          "fcmToken",
        ];

        const fieldsToUpdate = allowedFields.filter(
          (field) => updateData[field] !== undefined,
        );

        if (
          fieldsToUpdate.length === 0 &&
          pendingRequestsCreated.length === 0
        ) {
          return response.status(400).json({
            error: "At least one valid member field is required to update",
          });
        }

        // -----------------------------
        // Build Dynamic UPDATE Query
        // -----------------------------

        if (fieldsToUpdate.length > 0) {
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
        }

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
        // Enrich Sons Names & Pending Requests
        // -----------------------------

        await enrichMembersWithSonsNames(memberWithFather.rows, pool);

        const pendingOutgoing = await pool.query(
          `SELECT r.id, r.target_id, r.relationship_type, r.status, r.created_at,
                  CONCAT(m."firstName", ' ', m."middleName", ' ', m."surname") AS "targetName",
                  m."photo_url" AS "targetPhotoUrl"
           FROM relationship_requests r
           JOIN members m ON r.target_id = m.id
           WHERE r.requester_id = $1 AND r.status = 'PENDING'
           ORDER BY r.created_at DESC`,
          [memberId],
        );
        memberWithFather.rows[0].pendingOutgoingRequests = pendingOutgoing.rows;

        // -----------------------------
        // Success Response
        // -----------------------------

        const successMessage =
          pendingRequestsCreated.length > 0
            ? "Member updated. Relationship requests have been sent for approval."
            : "Member profile updated successfully";

        const updatedMember = withComputedAge(memberWithFather.rows[0]);

        return sendSuccess(
          response,
          200,
          successMessage,
          updatedMember,
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
          `SELECT id, "isDeleted", "mobileNumber", "fatherId", "sonIds"
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

        if (updateData.fcmToken === undefined && updateData.fcm_token !== undefined) {
          updateData.fcmToken = updateData.fcm_token;
          delete updateData.fcm_token;
        }

        // -----------------------------
        // Parse / Normalize Fields
        // -----------------------------

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
        const normalizedSonIds = normalizeSonIds(updateData);
        if (normalizedSonIds.provided) {
          updateData.sonIds = normalizedSonIds.value;
          delete updateData["sonIds[]"];
          delete updateData.sons;
          delete updateData["sons[]"];
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
        // Handle Approval-based Relationships
        // -----------------------------
        let pendingRequestsCreated = [];
        if (
          updateData.fatherId !== undefined ||
          updateData.sonIds !== undefined
        ) {
          try {
            if (isElevatedUser && callerId !== memberId) {
              await updateRelationshipsDirectly(
                pool,
                memberId,
                existingResult.rows[0],
                updateData,
              );
            } else {
              pendingRequestsCreated = await handleRelationshipUpdate(
                pool,
                memberId,
                existingResult.rows[0],
                updateData,
              );
            }
          } catch (relError) {
            return response.status(400).json({ error: relError.message });
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

          // Mobile side fields
          "currentAddress",
          "latlng",

          "sonIds",
          "fatherId",
          "photo_url",
          "fcmToken",
        ];

        const fieldsToUpdate = allowedFields.filter(
          (field) => updateData[field] !== undefined,
        );

        if (
          fieldsToUpdate.length === 0 &&
          pendingRequestsCreated.length === 0
        ) {
          return response.status(400).json({
            error: "At least one valid member field is required to update",
          });
        }

        // -----------------------------
        // Build Dynamic UPDATE Query
        // -----------------------------

        if (fieldsToUpdate.length > 0) {
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
        }

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
        // Enrich Sons Names & Pending Requests
        // -----------------------------

        await enrichMembersWithSonsNames(memberWithFather.rows, pool);

        const pendingOutgoing = await pool.query(
          `SELECT r.id, r.target_id, r.relationship_type, r.status, r.created_at,
                  CONCAT(m."firstName", ' ', m."middleName", ' ', m."surname") AS "targetName",
                  m."photo_url" AS "targetPhotoUrl"
           FROM relationship_requests r
           JOIN members m ON r.target_id = m.id
           WHERE r.requester_id = $1 AND r.status = 'PENDING'
           ORDER BY r.created_at DESC`,
          [memberId],
        );
        memberWithFather.rows[0].pendingOutgoingRequests = pendingOutgoing.rows;

        // -----------------------------
        // Success Response
        // -----------------------------

        const successMessage =
          pendingRequestsCreated.length > 0
            ? "Profile updated. Relationship requests have been sent for approval."
            : "Member profile updated successfully";

        const updatedMember = withComputedAge(memberWithFather.rows[0]);

        return sendSuccess(
          response,
          200,
          successMessage,
          updatedMember,
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
};
