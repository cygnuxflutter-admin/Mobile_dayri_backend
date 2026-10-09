const { Router } = require('express');
const { videoUploadController } = require('../controller/videoUpload.controller');
const { authMiddleware, authorizeRoles } = require('../middleware/auth.middleware');

function createUploadRoutes(pool) {
  const router = Router();
  const controller = videoUploadController(pool);

  router.post('/initUpload', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.initUpload);
  router.put('/:uploadId/chunks/:chunkIndex', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.uploadChunk);
  router.get('/:uploadId/status', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.getUploadStatus);
  router.post('/:uploadId/complete', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.completeUpload);
  router.delete('/:uploadId', authMiddleware(pool), authorizeRoles('SUPERADMIN', 'ADMIN'), controller.cancelUpload);

  return router;
}

module.exports = { createUploadRoutes };
