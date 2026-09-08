const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { sendSuccess } = require("../utils/response");

function hashOtp(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function normalizeMobileNumber(value) {
  return String(value || "").replace(/[\s()-]/g, "");
}

async function sendLoginOtp(mobileNumber, otp) {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_CONSOLE_OTP === "true"
  ) {
    console.log(`Login OTP for ${mobileNumber}: ${otp}`);
    return;
  }

  throw new Error("OTP SMS provider is not configured");
}

const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";
const JWT_EXPIRY = "7d";

function generateToken(member) {
  return jwt.sign({ memberId: member.id, role: member.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}


function memberResponse(member) {
  return {
    id: member.id,
    firstName: member.firstName,
    firstNameEnglish: member.firstNameEnglish,
    surname: member.surname,
    surnameEnglish: member.surnameEnglish,
    mobileNumber: member.mobileNumber,
    role: member.role,
    DateOfBirth: member.dateOfBirth,
    gender: member.gender,
    isActive: member.isActive,
    isApproved: member.isApproved,
    profilePhoto: member.photo_url,
    createdAt: member.created_at,
    updatedAt: member.updated_at,
  };
}

function authController(pool) {
  return {
    async login(request, response) {
      const { mobileNumber, password } = request.body;

      if (!mobileNumber || !password) {
        return response.status(400).json({
          error: "mobileNumber and password are required",
        });
      }

      try {
        const result = await pool.query(
          `SELECT * FROM members
           WHERE "mobileNumber" = $1
             AND COALESCE("isDeleted", false) = false
             AND COALESCE("isActive", true) = true
           LIMIT 1`,
          [String(mobileNumber).replace(/[\s()-]/g, "")],
        );

        if (result.rowCount === 0) {
          return response
            .status(401)
            .json({ error: "Invalid login credentials" });
        }

        const member = result.rows[0];
        if (!member.passwordHash) {
          return response.status(401).json({
            error: "Password login is not configured for this member",
          });
        }

        if (!(await bcrypt.compare(String(password), member.passwordHash))) {
          return response
            .status(401)
            .json({ error: "Invalid login credentials" });
        }

        if (member.isApproved === false) {
          return response
            .status(403)
            .json({ error: "Member approval is required" });
        }

        return sendSuccess(response, 200, "Login successful", {
          member: memberResponse(member),
          token: generateToken(member),
        });
      } catch (error) {
        console.error("Failed to login member:", error.message);
        return response.status(500).json({ error: "Failed to login" });
      }
    },

    async createSuperAdmin(request, response) {
      const { memberId, password, setupKey } = request.body;
      const id = Number.parseInt(memberId, 10);

      if (!setupKey || setupKey !== process.env.SUPERADMIN_SETUP_KEY) {
        return response
          .status(403)
          .json({ error: "Invalid super admin setup key" });
      }
      if (!Number.isInteger(id) || !password || String(password).length < 6) {
        return response.status(400).json({
          error: "memberId and password of at least 6 characters are required",
        });
      }

      try {
        const passwordHash = await bcrypt.hash(String(password), 12);
        const result = await pool.query(
          `UPDATE members
           SET "role" = 'SUPERADMIN', "passwordHash" = $1, "updated_at" = NOW()
           WHERE id = $2 AND COALESCE("isDeleted", false) = false
           RETURNING *`,
          [passwordHash, id],
        );

        if (result.rowCount === 0) {
          return response.status(404).json({ error: "Member not found" });
        }

        const member = result.rows[0];
        return sendSuccess(response, 200, "Super admin created successfully", {
          member: memberResponse(member),
          token: generateToken(member),
        });
      } catch (error) {
        console.error("Failed to create super admin:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to create super admin" });
      }
    },

    async requestOtp(request, response) {
      const mobileNumber = normalizeMobileNumber(request.body?.mobileNumber);

      if (!mobileNumber) {
        return response.status(400).json({ error: "mobileNumber is required" });
      }

      try {
        const result = await pool.query(
          `SELECT id, "isActive", "isApproved", "isDeleted" FROM members
           WHERE "mobileNumber" = $1
           ORDER BY id DESC
           LIMIT 1`,
          [mobileNumber],
        );

        if (result.rowCount === 0) {
          return response
            .status(404)
            .json({ error: "Member not found with this mobile number" });
        }

        const member = result.rows[0];

        if (member.isDeleted === true) {
          return response
            .status(403)
            .json({ error: "USER IS DELETED BY ADMIN" });
        }

        if (member.isActive === false) {
          return response.status(403).json({ error: "USER IS NOT ACTIVE" });
        }

        if (member.isApproved === false) {
          return response.status(403).json({ error: "USER IS NOT APPROVE" });
        }

        const otp = generateOtp();
        await sendLoginOtp(mobileNumber, otp);

        await pool.query(
          "DELETE FROM otp_verifications WHERE mobile_number = $1 AND verified_at IS NULL",
          [mobileNumber],
        );
        await pool.query(
          `INSERT INTO otp_verifications
             (mobile_number, otp_hash, pending_member, expires_at)
           VALUES ($1, $2, $3::jsonb, NOW() + INTERVAL '5 minutes')`,
          [
            mobileNumber,
            hashOtp(otp),
            JSON.stringify({ type: "LOGIN", memberId: member.id }),
          ],
        );

        const responseData = {
          mobileNumber,
          expiresInSeconds: 300,
        };

        if (process.env.NODE_ENV !== "production") {
          responseData.otp = otp;
        }

        return sendSuccess(
          response,
          200,
          "Login OTP sent successfully",
          responseData,
        );
      } catch (error) {
        console.error("Failed to send login OTP:", error.message);
        return response.status(500).json({ error: "Failed to send login OTP" });
      }
    },

    async verifyOtp1(request, response) {

      try {

        return sendSuccess(response, 200, "Login successful", {
          
        });
      } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to verify login OTP:", error.message);
        return response.status(500).json({ error: "Failed to verify login OTP" });
      } finally {
        client.release();
      }
    },

    async verifyOtp(request, response) {
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
          `SELECT *
       FROM otp_verifications
       WHERE mobile_number = $1
         AND verified_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
          [mobileNumber],
        );

        if (otpResult.rowCount === 0) {
          await client.query("ROLLBACK");
          return response.status(400).json({
            error: "OTP not found or already used",
          });
        }

        const otpRecord = otpResult.rows[0];

        // Check expiry
        if (new Date(otpRecord.expires_at) <= new Date()) {
          await client.query("ROLLBACK");
          return response.status(400).json({
            error: "OTP has expired",
          });
        }

        // Check attempts
        if (otpRecord.attempts >= 5) {
          await client.query("ROLLBACK");
          return response.status(429).json({
            error: "Too many invalid OTP attempts",
          });
        }

        // Verify OTP
        if (hashOtp(otp) !== otpRecord.otp_hash) {
          await client.query(
            `UPDATE otp_verifications
         SET attempts = attempts + 1
         WHERE id = $1`,
            [otpRecord.id],
          );

          await client.query("COMMIT");

          return response.status(400).json({
            error: "Invalid OTP",
          });
        }

        // Get member
        const memberResult = await client.query(
          `SELECT *
       FROM members
       WHERE "mobileNumber" = $1
       ORDER BY id DESC
       LIMIT 1`,
          [mobileNumber],
        );

        if (memberResult.rowCount === 0) {
          await client.query("ROLLBACK");

          return response.status(404).json({
            error: "Member not found",
          });
        }

        const member = memberResult.rows[0];

        // Optional: verify member status again
        if (member.isDeleted === true) {
          await client.query("ROLLBACK");

          return response.status(403).json({
            error: "USER IS DELETED BY ADMIN",
          });
        }

        if (member.isActive === false) {
          await client.query("ROLLBACK");

          return response.status(403).json({
            error: "USER IS NOT ACTIVE",
          });
        }

        if (member.isApproved === false) {
          await client.query("ROLLBACK");

          return response.status(403).json({
            error: "USER IS NOT APPROVE",
          });
        }

        // Mark OTP as verified
        await client.query(
          `UPDATE otp_verifications
       SET verified_at = NOW()
       WHERE id = $1`,
          [otpRecord.id],
        );

        await client.query("COMMIT");

        const token = generateToken(member);

        return sendSuccess(response, 200, "Login successful", {
          member,
          token,
        });
      } catch (error) {
        await client.query("ROLLBACK");

        console.error("Failed to verify login OTP:", error);

        return response.status(500).json({
          error: "Failed to verify login OTP",
        });
      } finally {
        client.release();
      }
    },
  };
}

module.exports = {
  authController,
  generateToken,
  verifyToken,
  JWT_SECRET,
};
