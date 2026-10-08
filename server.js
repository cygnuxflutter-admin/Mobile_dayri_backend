const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');
const { createApiRoutes, ensureMembersTable, ensureNotificationsTable, ensureUserNotificationsTable, ensureEventsTable, ensureEmergencyContactsTable, ensureRelationshipRequestsTable } = require('./routes/router.routes');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl:  false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});

app.use(compression());
app.use(express.json());
app.use((request, response, next) => {
  response.on('finish', () => {
    console.log("API URL:", request.originalUrl);
    console.log("API Response:", response.body);

  });
  next();
});
app.use('/uploads', express.static('uploads'));
app.use('/api/v1', createApiRoutes(pool));


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
  const server = app.listen(port, () => {
    console.log(`PostgreSQL API listening on port ${port}`);
  });
  server.requestTimeout = 30 * 60 * 1000;
}