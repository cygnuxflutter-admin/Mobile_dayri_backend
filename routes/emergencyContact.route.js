const { Router } = require("express");
const {
  emergencyContactController,
} = require("../controller/emergencyContact.controller");
const { authMiddleware, authorizeRoles } = require("../middleware/auth.middleware");

function createEmergencyContactRoutes(pool) {
  const router = Router();
  const controller = emergencyContactController(pool);

  router.post("/addEmergencyContact", authMiddleware(pool), authorizeRoles("SUPERADMIN", "ADMIN"), controller.addEmergencyContact);
  router.get("/getEmergencyContacts", authMiddleware(pool), controller.getEmergencyContacts);
  router.get("/getEmergencyContact/:id", authMiddleware(pool), controller.getEmergencyContact);
  router.put("/updateEmergencyContact/:id", authMiddleware(pool), authorizeRoles("SUPERADMIN", "ADMIN"), controller.updateEmergencyContact);
  router.delete("/deleteEmergencyContact/:id", authMiddleware(pool), authorizeRoles("SUPERADMIN"), controller.deleteEmergencyContact);

  return router;
}

module.exports = { createEmergencyContactRoutes };
