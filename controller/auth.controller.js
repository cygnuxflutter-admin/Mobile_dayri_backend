const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { sendSuccess } = require("../utils/response");

function normalizeMobileNumber(value) {
  return String(value || "").replace(/[\s()-]/g, "");
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


function calculateAgeFromDob(dateOfBirth) {
  if (!dateOfBirth) return null;

  const value = String(dateOfBirth).trim();
  if (!value) return null;

  let dobDate;
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmyMatch = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);

  if (isoMatch) {
    dobDate = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00`);
  } else if (dmyMatch) {
    dobDate = new Date(`${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}T00:00:00`);
  } else {
    dobDate = new Date(value);
  }

  if (Number.isNaN(dobDate.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - dobDate.getFullYear();
  const monthDiff = today.getMonth() - dobDate.getMonth();

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < dobDate.getDate())
  ) {
    age -= 1;
  }

  return age >= 0 ? age : null;
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
    age: calculateAgeFromDob(member.dateOfBirth),
    DateOfBirth: member.dateOfBirth,
    gender: member.gender,
    isActive: member.isActive,
    isApproved: member.isApproved,
    profilePhoto: member.photo_url,
    createdAt: member.created_at,
    updatedAt: member.updated_at,
    isPasswordChange: member.isPasswordChange,
  };
}

function authController(pool) {
  return {
    async login(request, response) {
      const body = request.body || {};
      const mobileNumber = body.mobileNumber;
      const password = body.password;
      const fcmToken = body.fcmToken ?? body.fcm_token;

      if (!mobileNumber || !password) {
        return response.status(400).json({
          error: "mobileNumber and password are required",
        });
      }

      try {
        const result = await pool.query(
          `SELECT * FROM members
           WHERE "mobileNumber" = $1
           LIMIT 1`,
          [String(mobileNumber).replace(/[\s()-]/g, "")],
        );

        if (result.rowCount === 0) {
          return response
            .status(401)
            .json({ error: "No user Found!" });
        }

        const member = result.rows[0];

        if (!(await bcrypt.compare(String(password), member.passwordHash))) {
          return response
            .status(401)
            .json({ error: "Invalid login credentials!" });
        }

        if (member.isDeleted === true) {
          return response.status(403).json({
            error: "Account is deleted",
          });
        }

        if (member.isActive === false) {
          return response.status(403).json({
            error: "Account is inactive",
          });
        }

        if (member.isApproved === false) {
          return response.status(403).json({
            error: "Account approval is required",
          });
        }

        if (!member.passwordHash) {
          return response.status(401).json({
            error: "Password login is not configured for this member",
          });
        }

        

        if (typeof fcmToken === "string" && fcmToken.trim()) {
          const updatedMemberResult = await pool.query(
            `UPDATE members
             SET "fcmToken" = $1, "updated_at" = NOW()
             WHERE id = $2
             RETURNING *`,
            [fcmToken.trim(), member.id],
          );

          if (updatedMemberResult.rowCount === 0) {
            return response.status(500).json({
              error: "Unable to update FCM token",
            });
          }

          member.fcmToken = updatedMemberResult.rows[0].fcmToken;
          member.updated_at = updatedMemberResult.rows[0].updated_at;
        }

        console.log("Member logged in successfully:", member.created_at);

        return sendSuccess(response, 200, "Login successfully", {
          member: memberResponse(member),
          token: generateToken(member),
        });
      } catch (error) {
        console.error("Failed to login member:", error.message);
        return response.status(500).json({ error: "Failed to login" });
      }
    },

    async logout(request, response) {
      try {
        await pool.query(
          `UPDATE members
           SET "fcmToken" = NULL, "updated_at" = NOW()
           WHERE id = $1`,
          [request.member.id],
        );

        return sendSuccess(response, 200, "Logout successfully");
      } catch (error) {
        console.error("Failed to logout member:", error.message);
        return response.status(500).json({ error: "Failed to logout" });
      }
    },

    async hashPassword(request, response) {
      if (process.env.NODE_ENV === "production") {
        return response.status(404).json({ error: "Endpoint not found" });
      }

      const password = String(request.body?.password || "");
      if (!password) {
        return response.status(400).json({ error: "password is required" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      return response.status(200).json({
        success: true,
        message: "Password hashed successfully",
        data: {
          passwordHash,
        },
      });
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

    /* Legacy OTP handlers are disabled; password login is the only auth flow.
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

        if (
          process.env.NODE_ENV !== "production" ||
          process.env.ALLOW_CONSOLE_OTP === "true"
        ) {
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
    */
  };
}

module.exports = {
  authController,
  generateToken,
  verifyToken,
  JWT_SECRET,
  memberResponse,
  calculateAgeFromDob,
};
