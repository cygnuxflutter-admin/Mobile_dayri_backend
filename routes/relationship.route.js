const { Router } = require("express");
const { relationshipController } = require("../controller/relationship.controller");
const { authMiddleware } = require("../middleware/auth.middleware");

function createRelationshipRoutes(pool) {
  const router = Router();
  const controller = relationshipController(pool);

  // All relationship routes require authentication
  router.use(authMiddleware(pool));

  router.post("/request", controller.createRequest);
  router.get("/pending", controller.getPendingRequests);
  router.get("/outgoing", controller.getOutgoingRequests);
  router.post("/:id/accept", controller.acceptRequest);
  router.post("/:id/reject", controller.rejectRequest);
  router.post("/:id/cancel", controller.cancelRequest);

  return router;
}

module.exports = { createRelationshipRoutes };
