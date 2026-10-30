const { Router } = require("express");
const { surnameController } = require("../controller/surname.controller");

function createSurnameRoutes(pool) {
  const router = Router();
  const controller = surnameController(pool);

  // All surname master routes are public (no authentication token required)
  // so that registration screen, guest views, and member filters can access without token
  router.get("/", controller.getAllSurnames);
  router.get("/:id", controller.getSurnameById);
  router.post("/", controller.createSurname);
  router.post("/bulk", controller.bulkCreateSurnames);
  router.put("/:id", controller.updateSurname);
  router.patch("/:id", controller.updateSurname);
  router.delete("/:id", controller.deleteSurname);

  return router;
}

module.exports = { createSurnameRoutes };
