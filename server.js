const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const { Pool } = require('pg');
const { createApiRoutes, ensureMembersTable, ensureOtpVerificationsTable, ensureNotificationsTable, ensureEventsTable, ensureEmergencyContactsTable } = require('./routes/router.routes');

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use((request, response, next) => {
  response.on('finish', () => {
    console.log("API URL:", request.originalUrl);
    console.log("API Body:", request.body);
    console.log("API Response:", response.body);

  });
  next();
});
app.use('/uploads', express.static('uploads'));
app.get('/', (req, res) => {
  res.status(200).json({ status: 'success', message: 'Mobile Dairy Backend API is running' });
});
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
  await ensureOtpVerificationsTable(pool);
  await ensureNotificationsTable(pool);
  await ensureEventsTable(pool);
  await ensureEmergencyContactsTable(pool);
  app.listen(5050, () => {
    console.log(`PostgreSQL API listening on port 5050`);
  });
}