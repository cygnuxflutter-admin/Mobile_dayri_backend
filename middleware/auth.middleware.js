const { verifyToken } = require("../controller/auth.controller");

function authMiddleware(pool) {
  return async (request, response, next) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return response.status(401).json({
        error: "Unauthorized: Missing or invalid authorization header",
      });
    }

    const decoded = verifyToken(authHeader.slice(7));
    if (!decoded?.memberId) {
      return response.status(401).json({ error: "Unauthorized: Invalid or expired token" });
    }

    try {
      const result = await pool.query(
        `SELECT * FROM members
         WHERE id = $1 AND COALESCE("isDeleted", false) = false
         LIMIT 1`,
        [decoded.memberId],
      );

      console.log("Database query result:", result.rows);

      if (result.rowCount === 0 || result.rows[0].isActive === false) {
        return response.status(401).json({ error: "Unauthorized: Inactive or deleted member" });
      }

      if (result.rows[0].isApproved === false) {
        return response.status(403).json({ error: "Member approval is required" });
      }

      request.member = result.rows[0];
      request.admin = request.member;
      next();
    } catch (error) {
      console.error("Failed to authenticate member:", error.message);
      return response.status(500).json({ error: "Failed to authenticate member" });
    }
  };
}

function authorizeRoles(...allowedRoles) {
  return (request, response, next) => {
    if (!request.member || !allowedRoles.includes(request.member.role)) {
      return response.status(403).json({ error: "Forbidden: Insufficient permission" });
    }
    next();
  };
}

function superAdminMiddleware() {
  return authorizeRoles("SUPERADMIN" );
}
function adminMiddleware() {
  return authorizeRoles("ADMIN" );
}
function bothAdminMiddleware() {
  return authorizeRoles("ADMIN", "SUPERADMIN" );
}

module.exports = { authMiddleware, authorizeRoles, superAdminMiddleware, adminMiddleware, bothAdminMiddleware };