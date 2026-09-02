const { Router } = require('express');
const { eventController } = require('../controller/event.controller');
const { authMiddleware, authorizeRoles } = require('../middleware/auth.middleware');

function createEventRoutes(pool) {
  const router = Router();
  const controller = eventController(pool);

  // Accept any files (handles different client field names like 'photos', 'photos[]', 'photo', etc.)
  router.post('/addEvent', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.eventUpload.any(), controller.addEvent);
  router.get('/getEvents', authMiddleware(pool), controller.getEvents);
  router.put('/updateEvent/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.eventUpload.any(), controller.updateEvent);
  router.delete('/deleteEvent/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.deleteEvent);

  return router;
}

module.exports = { createEventRoutes };
