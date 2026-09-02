const { Router } = require("express");
const { createMemberRoutes } = require("./member.route");
const { createNotificationRoutes } = require("./notification.route");
const { createEventRoutes } = require("./event.route");
const { createReportRoutes } = require("./report.route");
const { createEmergencyContactRoutes } = require("./emergencyContact.route");
const {
  ensureMembersTable,
  ensureOtpVerificationsTable,
} = require("../controller/member.controller");
const {
  ensureNotificationsTable,
} = require("../controller/notification.controller");
const {
  ensureEmergencyContactsTable,
} = require("../controller/emergencyContact.controller");

function createApiRoutes(pool) {
  const router = Router();

  // Auth routes (public - no middleware needed)
  // router.use("/auth", createAuthRoutes(pool));

  // Protected routes (require auth middleware)
  router.use("/member", createMemberRoutes(pool));
  router.use("/notification", createNotificationRoutes(pool));
  router.use("/event", createEventRoutes(pool));
  router.use("/report", createReportRoutes(pool));
  router.use(
    "/emergencyContact",
    createEmergencyContactRoutes(pool),
  );

  return router;
}

const { ensureEventsTable } = require("../controller/event.controller");

module.exports = {
  createApiRoutes,
  ensureMembersTable,
  ensureOtpVerificationsTable,
  ensureNotificationsTable,
  ensureEventsTable,
  ensureEmergencyContactsTable,
};
