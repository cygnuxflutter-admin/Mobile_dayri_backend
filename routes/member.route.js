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
    "/register",
    memberRegistrationUpload.single("photo"),
    controller.register,
  );

  // Login routes
  router.post("/login", authCtrl.login);
  router.post("/sample/hashPassword", authCtrl.hashPassword);
  router.post(
    "/changePassword",
    authMiddleware(pool),
    controller.changePassword,
  );
  router.post(
  "/setPassword/:id?",
  authMiddleware(pool),
  controller.setPassword,
);
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
                                            
  router.post(
    "/updateMember/:id",
    authMiddleware(pool),
    memberRegistrationUpload.single("photo"),
    controller.updateMember,
  );
   router.post(
    "/updateProfile",
    authMiddleware(pool),
    memberRegistrationUpload.single("photo"),
    controller.updateProfile,
  );
  router.get("/getMember/:id", authMiddleware(pool), controller.getMemberById);
  router.post(
    "/setMemberActive/:id",
    authMiddleware(pool),
    bothAdminMiddleware(),
    controller.setMemberActive,
  );
  router.patch(
    "/setMemberActive/:id",
    authMiddleware(pool),
    bothAdminMiddleware(),
    controller.setMemberActive,
  );
  router.post(
    "/deleteMember/:id",
    authMiddleware(pool),
    bothAdminMiddleware(),
    controller.deleteMember,
  );

  return router;
}

module.exports = { createMemberRoutes };
