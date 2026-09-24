const { Router } = require('express');
const { notificationController, notificationUpload } = require('../controller/notification.controller');
const { authMiddleware, authorizeRoles } = require('../middleware/auth.middleware');

function createNotificationRoutes(pool) {
  const router = Router();
  const controller = notificationController(pool);

  router.post('/addNotification', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), notificationUpload.array('photos', 5), controller.addNotification);
  router.post('/updateNotification/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), notificationUpload.array('photos', 5), controller.updateNotification);
  router.post('/setNotificationActive/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.setNotificationActive);
  router.post('/deleteNotification/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.deleteNotification);
  router.get('/getNotifications', authMiddleware(pool), controller.getAllNotifications);
  router.get('/getNotification/:id', authMiddleware(pool), controller.getNotificationById);
  router.get('/myNotifications', authMiddleware(pool), controller.getUserNotifications);
  router.get('/unreadCount', authMiddleware(pool), controller.getUnreadNotificationCount);
  router.post('/:id/read', authMiddleware(pool), controller.markUserNotificationRead);
  router.post('/readAll', authMiddleware(pool), controller.markAllUserNotificationsRead);

  return router;
}

module.exports = { createNotificationRoutes };
