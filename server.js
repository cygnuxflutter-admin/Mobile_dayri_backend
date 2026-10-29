const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const { Pool } = require('pg');
const { createApiRoutes, ensureMembersTable, ensureNotificationsTable, ensureUserNotificationsTable, ensureEventsTable, ensureEmergencyContactsTable, ensureRelationshipRequestsTable, ensureVideoUploadsTable } = require('./routes/router.routes');
const { startUploadCleanupJob } = require('./controller/videoUpload.controller');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl:  false
});

// CORS middleware
app.use((request, response, next) => {
  response.header("Access-Control-Allow-Origin", "*");
  response.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (request.method === "OPTIONS") {
    return response.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((request, response, next) => {
  const clientIp = request.ip || request.headers['x-forwarded-for'] || request.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] ---> Incoming ${request.method} ${request.originalUrl} from ${clientIp}`);
  response.on('finish', () => {
    console.log(`[${new Date().toISOString()}] <--- Completed ${request.method} ${request.originalUrl} -> Status ${response.statusCode}`);
  });
  next();
});
app.use('/uploads', express.static('uploads'));
app.use('/api/v1', createApiRoutes(pool));

// Global error handler
app.use((err, request, response, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled error on ${request.method} ${request.originalUrl}:`, err);
  if (response.headersSent) {
    return next(err);
  }
  const statusCode = err.status || err.statusCode || (err.name === "MulterError" ? 400 : 500);
  response.status(statusCode).json({
    success: false,
    error: err.message || "Internal server error",
    code: err.code || undefined,
  });
});


startServer().catch((error) => {
  console.error('Unable to start server:', error.message);
  process.exit(1);
});

async function startServer() {
  const requiredConfig = ['PGDATABASE', 'PGUSER', 'PGPASSWORD'];
  const missingConfig = requiredConfig.filter((name) => !process.env[name]);

  if (missingConfig.length > 0) {
    throw new Error(`Missing PostgreSQL configuration: ${missingConfig.join(', ')}`);
  }

  await ensureMembersTable(pool);
  await ensureNotificationsTable(pool);
  await ensureUserNotificationsTable(pool);
  await ensureEventsTable(pool);
  await ensureEmergencyContactsTable(pool);
  await ensureRelationshipRequestsTable(pool);
  await ensureVideoUploadsTable(pool);
  startUploadCleanupJob(pool);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`PostgreSQL API listening on 0.0.0.0:${port}`);
  });
  server.requestTimeout = 30 * 60 * 1000;
}