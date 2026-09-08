const { Router } = require("express");
const {
  memberController,
  memberRegistrationUpload,
} = require("../controller/member.controller");
const { authController } = require("../controller/auth.controller");
const {
  authMiddleware,
  superAdminMiddleware,
  bothAdminMiddleware,
  adminMiddleware,
} = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/auth.middleware");

function createMemberRoutes(pool) {
  const router = Router();
  const controller = memberController(pool);
  const authCtrl = authController(pool);

  // Registration routes
  router.post(
    "/register/request-otp",
    memberRegistrationUpload.single("photo"),
    controller.requestRegistrationOtp,
  );
  router.post("/register/verify-otp", controller.verifyRegistrationOtp);

  // Login routes
  router.post("/login/request-otp", authCtrl.requestOtp);
    router.get("/login/request-otp", authCtrl.verifyOtp1);
  router.post("/login/verify-otp", authCtrl.verifyOtp);
  router.patch(
    "/updateRole/:id",
    authMiddleware(pool),
    superAdminMiddleware(),
    controller.updateMemberRole,
  );
  router.patch(
    "/approveMember/:id",
    authMiddleware(pool),
    bothAdminMiddleware(),
    controller.approveMember,
  );
  router.get(
    "/approvalPendingMember",
    authMiddleware(pool),
    bothAdminMiddleware(),
    controller.approvalPendingMember,
  );
  router.get("/getProfile", authMiddleware(pool), controller.getProfile);
  router.get("/getAllMembers", authMiddleware(pool), controller.getAllMembers);
  router.get(
    "/getMemberStats",
    authMiddleware(pool),
    controller.getMemberStats,
  );
                                            
  router.put(
    "/updateMember/:id",
    authMiddleware(pool),
    memberRegistrationUpload.single("photo"),
    controller.updateMember,
  );
   router.put(
    "/updateProfile",
    authMiddleware(pool),
    memberRegistrationUpload.single("photo"),
    controller.updateProfile,
  );
  router.get("/getMember/:id", authMiddleware(pool), controller.getMemberById);
  router.patch(
    "/setMemberActive/:id",
    authMiddleware(pool),
    bothAdminMiddleware(),
    controller.setMemberActive,
  );
  router.delete(
    "/deleteMember/:id",
    authMiddleware(pool),
    bothAdminMiddleware(),
    controller.deleteMember,
  );

  return router;
}

module.exports = { createMemberRoutes };
