const { Router } = require('express');
const { notificationController, notificationUpload } = require('../controller/notification.controller');
const { authMiddleware, authorizeRoles } = require('../middleware/auth.middleware');

function createNotificationRoutes(pool) {
  const router = Router();
  const controller = notificationController(pool);

  router.post('/addNotification', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), notificationUpload.array('photos', 5), controller.addNotification);
  router.put('/updateNotification/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), notificationUpload.array('photos', 5), controller.updateNotification);
  router.patch('/setNotificationActive/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.setNotificationActive);
  router.delete('/deleteNotification/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.deleteNotification);
  router.get('/getNotifications', authMiddleware(pool), controller.getAllNotifications);
  router.get('/getNotification/:id', authMiddleware(pool), controller.getNotificationById);

  return router;
}

module.exports = { createNotificationRoutes };
