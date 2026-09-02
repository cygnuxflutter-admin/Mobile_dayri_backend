// const { Router } = require("express");
// const { authController } = require("../controller/auth.controller");

// function createAuthRoutes(pool) {
//   const router = Router();
//   const controller = authController(pool);

//   // Public authentication routes
//   router.post("/login", controller.login);
//   router.post("/request-otp", controller.requestOtp);
//   router.post("/verify-otp", controller.verifyOtp);
//   router.post("/createSuperAdmin", controller.createSuperAdmin);

//   return router;
// }

// module.exports = { createAuthRoutes };
