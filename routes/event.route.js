const { Router } = require('express');
const { eventController } = require('../controller/event.controller');
const { authMiddleware, authorizeRoles } = require('../middleware/auth.middleware');

function createEventRoutes(pool) {
  const router = Router();
  const controller = eventController(pool);

  // Accept any files (handles different client field names like 'photos', 'photos[]', 'photo', etc.)
  router.post('/addEvent', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.eventUpload.any(), controller.addEvent);
  router.get('/getEvents', authMiddleware(pool), controller.getEvents);
  router.post('/updateEvent/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.eventUpload.any(), controller.updateEvent);
  router.delete('/deleteEvent/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.deleteEvent);
  router.post('/deleteEvent/:id', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.deleteEvent);

  // Resumable Chunk-based Video Upload APIs
  router.post('/initUpload', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.initUpload);
  router.put('/:uploadId/chunks/:chunkIndex', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.uploadChunk);
  router.get('/:uploadId/status', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.getUploadStatus);
  router.post('/:uploadId/complete', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.completeUpload);
  router.delete('/:uploadId', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.cancelUpload);

  return router;
}

module.exports = { createEventRoutes };
