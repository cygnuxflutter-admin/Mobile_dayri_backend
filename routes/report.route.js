const { Router } = require('express');
const { reportController } = require('../controller/report.controller');
const { authMiddleware } = require('../middleware/auth.middleware');

function createReportRoutes(pool) {
  const router = Router();
  const controller = reportController(pool);

  router.get('/dashboard', authMiddleware(pool), controller.getDashboard);

  return router;
}

module.exports = { createReportRoutes };
