const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// Setup test environment
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const testPool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '123456',
  database: 'mobile_dayri_test',
});

const {
  createApiRoutes,
  ensureMembersTable,
  ensureEventsTable,
  ensureNotificationsTable,
  ensureUserNotificationsTable,
  ensureEmergencyContactsTable,
  ensureRelationshipRequestsTable,
  ensureVideoUploadsTable,
} = require('../routes/router.routes');

function createToken(memberId, role) {
  return jwt.sign({ memberId, role }, JWT_SECRET, { expiresIn: '1h' });
}

let app;
let server;
let baseUrl;
let admin1Token;
let admin2Token;
let superAdminToken;
let userToken;

async function setupDatabase() {
  console.log('--- Setting up test database ---');
  await ensureMembersTable(testPool);
  await ensureNotificationsTable(testPool);
  await ensureUserNotificationsTable(testPool);
  await ensureEventsTable(testPool);
  await ensureEmergencyContactsTable(testPool);
  await ensureRelationshipRequestsTable(testPool);
  await ensureVideoUploadsTable(testPool);

  // Clear tables for test run
  await testPool.query('DELETE FROM video_upload_chunks');
  await testPool.query('DELETE FROM video_upload_sessions');
  await testPool.query('DELETE FROM events');
  await testPool.query('DELETE FROM members WHERE id IN (10001, 10002, 10003, 10004)');

  // Seed members
  const seedMembers = `
    INSERT INTO members (id, "firstName", "firstNameEnglish", "middleName", "middleNameEnglish", surname, "surnameEnglish", "mobileNumber", gender, "dateOfBirth", role, "isActive", "isApproved", "isDeleted")
    VALUES
      (10001, 'Super', 'Super', 'Admin', 'Admin', 'Master', 'Master', '9999990001', 'Male', '1990-01-01', 'SUPERADMIN', true, true, false),
      (10002, 'Admin1', 'Admin1', 'One', 'One', 'Lead', 'Lead', '9999990002', 'Male', '1990-01-01', 'ADMIN', true, true, false),
      (10003, 'Admin2', 'Admin2', 'Two', 'Two', 'Staff', 'Staff', '9999990003', 'Male', '1990-01-01', 'ADMIN', true, true, false),
      (10004, 'Regular', 'Regular', 'User', 'User', 'Normal', 'Normal', '9999990004', 'Male', '1990-01-01', 'USER', true, true, false)
  `;
  await testPool.query(seedMembers);

  superAdminToken = createToken(10001, 'SUPERADMIN');
  admin1Token = createToken(10002, 'ADMIN');
  admin2Token = createToken(10003, 'ADMIN');
  userToken = createToken(10004, 'USER');
  console.log('Test members and tokens initialized.');
}

async function startServer() {
  app = express();
  app.use(express.json());
  app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
  app.use('/api/v1', createApiRoutes(testPool));

  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}/api/v1`;
      console.log(`Test server running at ${baseUrl}`);
      resolve();
    });
  });
}

async function cleanup() {
  if (server) {
    server.close();
  }
  await testPool.end();
}

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`✅ PASS: ${message}`);
}

async function runTests() {
  try {
    await setupDatabase();
    await startServer();

    console.log('\n========================================');
    console.log('1. AUTHENTICATION & AUTHORIZATION TESTS');
    console.log('========================================');

    // Test 1.1: Unauthorized without token
    {
      const res = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'test.mp4', fileSize: 1000000 }),
      });
      assert(res.status === 401, 'POST /initUpload without token returns 401 Unauthorized');
    }

    // Test 1.2: Forbidden with USER role
    {
      const res = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ fileName: 'test.mp4', fileSize: 1000000 }),
      });
      assert(res.status === 403, 'POST /initUpload with USER role returns 403 Forbidden');
    }

    // Test 1.3: Allowed with ADMIN role
    let testUploadId;
    {
      const res = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({ fileName: 'intro.mp4', fileSize: 15 * 1024 * 1024 }),
      });
      const data = await res.json();
      assert(res.status === 201, 'POST /initUpload with ADMIN role returns 201 Created');
      assert(data.success === true, 'Response contains success=true');
      assert(Boolean(data.data.uploadId), 'Response returns uploadId');
      assert(data.data.totalChunks === 3, 'Response calculates totalChunks=3 for 15 MiB file');
      testUploadId = data.data.uploadId;
    }

    // Test 1.4: Ownership verification - Admin 2 cannot access Admin 1 session
    {
      const res = await fetch(`${baseUrl}/event/${testUploadId}/status`, {
        headers: { Authorization: `Bearer ${admin2Token}` },
      });
      assert(res.status === 403, 'GET /:uploadId/status returns 403 Forbidden when accessed by different admin');
    }

    // Test 1.5: SUPERADMIN can access session owned by Admin 1
    {
      const res = await fetch(`${baseUrl}/event/${testUploadId}/status`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      assert(res.status === 200, 'GET /:uploadId/status returns 200 OK when accessed by SUPERADMIN');
    }

    // Test 1.6: Path traversal attempt in uploadId
    {
      const res = await fetch(`${baseUrl}/event/..%2F..%2Fetc%2Fpasswd/status`, {
        headers: { Authorization: `Bearer ${admin1Token}` },
      });
      assert(res.status === 400, 'Invalid / traversal uploadId returns 400 Bad Request');
    }

    console.log('\n========================================');
    console.log('2. VALIDATION & SIZE LIMIT TESTS');
    console.log('========================================');

    // Test 2.1: Missing fileName
    {
      const res = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({ fileSize: 1000000 }),
      });
      assert(res.status === 400, 'Missing fileName returns 400 Bad Request');
    }

    // Test 2.2: Non-video file rejection
    {
      const res = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({ fileName: 'malicious.exe', fileSize: 1000000 }),
      });
      assert(res.status === 400, 'Non-video file extension returns 400 Bad Request');
    }

    // Test 2.3: Oversized file rejection (> 1 GiB)
    {
      const res = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({ fileName: 'huge.mp4', fileSize: 1024 * 1024 * 1024 + 1 }),
      });
      const data = await res.json();
      assert(res.status === 400, 'File > 1 GiB returns 400 Bad Request');
      assert(data.error.includes('1 GiB'), 'Error message specifies 1 GiB limit');
    }

    // Test 2.4: Out of bounds chunk size
    {
      const res = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({ fileName: 'video.mp4', fileSize: 20000000, chunkSize: 20 * 1024 * 1024 }),
      });
      assert(res.status === 400, 'Chunk size > 10 MiB returns 400 Bad Request');
    }

    console.log('\n========================================');
    console.log('3. SMALL VIDEO CHUNK UPLOAD & CHECKSUM');
    console.log('========================================');

    {
      const smallContent = crypto.randomBytes(500 * 1024); // 500 KiB
      const smallHash = crypto.createHash('sha256').update(smallContent).digest('hex');

      // Init
      const initRes = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({
          fileName: 'small_clip.mp4',
          fileSize: smallContent.length,
          checksum: smallHash,
        }),
      });
      const initData = await initRes.json();
      assert(initRes.status === 201, 'Small video session initialized');
      const smallUploadId = initData.data.uploadId;
      assert(initData.data.totalChunks === 1, 'Small video requires 1 chunk');

      // Upload Chunk 0
      const chunkRes = await fetch(`${baseUrl}/event/${smallUploadId}/chunks/0`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: smallContent,
      });
      const chunkData = await chunkRes.json();
      assert(chunkRes.status === 200, 'Chunk 0 uploaded with 200 OK');
      assert(chunkData.data.size === smallContent.length, 'Chunk size recorded correctly');

      // Status check
      const statusRes = await fetch(`${baseUrl}/event/${smallUploadId}/status`, {
        headers: { Authorization: `Bearer ${admin1Token}` },
      });
      const statusData = await statusRes.json();
      assert(statusData.data.uploadedChunks.length === 1, 'Status shows 1 uploaded chunk');
      assert(statusData.data.isComplete === true, 'Status shows upload isComplete=true');

      // Complete
      const compRes = await fetch(`${baseUrl}/event/${smallUploadId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({}),
      });
      const compData = await compRes.json();
      assert(compRes.status === 200, 'POST /complete returns 200 OK');
      assert(compData.data.checksum === smallHash, 'Checksum matches expected SHA-256');
      assert(compData.data.videoUrl.startsWith('/uploads/events/'), 'Final videoUrl starts with /uploads/events/');

      // Verify physical file on disk
      const diskPath = path.join(__dirname, '..', compData.data.videoUrl.replace(/^\//, ''));
      assert(fs.existsSync(diskPath), 'Assembled file exists on disk');
      assert(fs.statSync(diskPath).size === smallContent.length, 'Physical file size matches original');

      // Idempotency: re-calling complete returns same URL
      const retryComp = await fetch(`${baseUrl}/event/${smallUploadId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({}),
      });
      const retryData = await retryComp.json();
      assert(retryComp.status === 200, 'Re-calling complete is idempotent and returns 200');
      assert(retryData.data.videoUrl === compData.data.videoUrl, 'Returns identical videoUrl');
    }

    console.log('\n========================================');
    console.log('4. MULTI-CHUNK UPLOAD, MISSING, DUPLICATE & RESUME');
    console.log('========================================');

    {
      const chunkSize = 5 * 1024 * 1024; // 5 MiB
      const chunk0 = crypto.randomBytes(chunkSize);
      const chunk1 = crypto.randomBytes(chunkSize);
      const chunk2 = crypto.randomBytes(2 * 1024 * 1024); // 2 MiB (total 12 MiB)
      const fullVideo = Buffer.concat([chunk0, chunk1, chunk2]);
      const fullHash = crypto.createHash('sha256').update(fullVideo).digest('hex');

      // Init
      const initRes = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({
          fileName: 'presentation.mp4',
          fileSize: fullVideo.length,
          chunkSize,
          checksum: fullHash,
        }),
      });
      const initData = await initRes.json();
      const multiUploadId = initData.data.uploadId;
      assert(initData.data.totalChunks === 3, 'Total chunks calculated as 3');

      // Upload Chunk 0
      const c0Res = await fetch(`${baseUrl}/event/${multiUploadId}/chunks/0`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: chunk0,
      });
      assert(c0Res.status === 200, 'Chunk 0 uploaded successfully');

      // Upload Chunk 2 (skip Chunk 1 to test missing chunk)
      const c2Res = await fetch(`${baseUrl}/event/${multiUploadId}/chunks/2`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: chunk2,
      });
      assert(c2Res.status === 200, 'Chunk 2 uploaded successfully');

      // Status check should report chunk 1 missing
      const statusRes1 = await fetch(`${baseUrl}/event/${multiUploadId}/status`, {
        headers: { Authorization: `Bearer ${admin1Token}` },
      });
      const statusData1 = await statusRes1.json();
      assert(statusData1.data.uploadedChunks.includes(0), 'Chunk 0 in uploadedChunks');
      assert(statusData1.data.uploadedChunks.includes(2), 'Chunk 2 in uploadedChunks');
      assert(statusData1.data.missingChunks.includes(1), 'Chunk 1 identified in missingChunks');
      assert(statusData1.data.isComplete === false, 'isComplete is false');

      // Attempt complete with missing chunk -> should fail
      const incompleteRes = await fetch(`${baseUrl}/event/${multiUploadId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({}),
      });
      assert(incompleteRes.status === 400, 'POST /complete with missing chunks rejected with 400');
      const incompleteData = await incompleteRes.json();
      assert(incompleteData.missingChunks.includes(1), 'Error specifies missing chunk 1');

      // Duplicate chunk upload (re-upload chunk 0)
      const dupRes = await fetch(`${baseUrl}/event/${multiUploadId}/chunks/0`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: chunk0,
      });
      assert(dupRes.status === 200, 'Duplicate chunk 0 upload handled safely');

      // Resume: upload missing chunk 1
      const c1Res = await fetch(`${baseUrl}/event/${multiUploadId}/chunks/1`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: chunk1,
      });
      assert(c1Res.status === 200, 'Missing Chunk 1 uploaded on resume');

      // Status check should now report all chunks present
      const statusRes2 = await fetch(`${baseUrl}/event/${multiUploadId}/status`, {
        headers: { Authorization: `Bearer ${admin1Token}` },
      });
      const statusData2 = await statusRes2.json();
      assert(statusData2.data.missingChunks.length === 0, 'No missing chunks after resume');
      assert(statusData2.data.isComplete === true, 'Upload is now complete');

      // Complete assembly
      const compRes = await fetch(`${baseUrl}/event/${multiUploadId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({}),
      });
      const compData = await compRes.json();
      assert(compRes.status === 200, 'Assembled 12 MiB video completed successfully');
      assert(compData.data.fileSize === fullVideo.length, 'Assembled file size exactly matches');
      assert(compData.data.checksum === fullHash, 'Assembled SHA-256 hash matches original');

      // Verify temp chunks cleaned up
      const tempDir = path.join(__dirname, '..', 'temp_chunks', multiUploadId);
      assert(!fs.existsSync(tempDir), 'Temporary chunks directory cleaned up from disk');
    }

    console.log('\n========================================');
    console.log('5. OVERSIZED CHUNK & CHECKSUM MISMATCH TESTS');
    console.log('========================================');

    // Test 5.1: Oversized chunk payload
    {
      const initRes = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({ fileName: 'chunktest.mp4', fileSize: 10 * 1024 * 1024 }),
      });
      const { data } = await initRes.json();

      // Send 100 bytes instead of 5 MiB for chunk 0
      const badChunk = await fetch(`${baseUrl}/event/${data.uploadId}/chunks/0`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: crypto.randomBytes(100),
      });
      assert(badChunk.status === 400, 'Mismatched chunk payload size rejected with 400 Bad Request');
    }

    // Test 5.2: Checksum mismatch on completion
    {
      const wrongHash = 'a'.repeat(64);
      const content = crypto.randomBytes(1024 * 1024);

      const initRes = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({
          fileName: 'hash_test.mp4',
          fileSize: content.length,
          checksum: wrongHash,
        }),
      });
      const { data } = await initRes.json();

      await fetch(`${baseUrl}/event/${data.uploadId}/chunks/0`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: content,
      });

      const compRes = await fetch(`${baseUrl}/event/${data.uploadId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({}),
      });
      assert(compRes.status === 400, 'Checksum mismatch rejects assembly with 400');
    }

    console.log('\n========================================');
    console.log('6. CANCELLATION & DISK CLEANUP (DELETE /:uploadId)');
    console.log('========================================');

    {
      const content = crypto.randomBytes(5 * 1024 * 1024);
      const initRes = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({ fileName: 'cancel_me.mp4', fileSize: 10 * 1024 * 1024 }),
      });
      const { data } = await initRes.json();
      const cancelUploadId = data.uploadId;

      await fetch(`${baseUrl}/event/${cancelUploadId}/chunks/0`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: content,
      });

      const chunkFile = path.join(__dirname, '..', 'temp_chunks', cancelUploadId, 'chunks', 'chunk_0');
      assert(fs.existsSync(chunkFile), 'Chunk file exists on disk prior to cancel');

      // Cancel
      const delRes = await fetch(`${baseUrl}/event/${cancelUploadId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${admin1Token}` },
      });
      assert(delRes.status === 200, 'DELETE /:uploadId returns 200 OK');

      // Check file removed
      const sessionDir = path.join(__dirname, '..', 'temp_chunks', cancelUploadId);
      assert(!fs.existsSync(sessionDir), 'Session directory removed from disk on cancel');

      // Cannot upload chunk to cancelled session
      const postCancelPut = await fetch(`${baseUrl}/event/${cancelUploadId}/chunks/1`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: content,
      });
      assert(postCancelPut.status === 400, 'Uploading chunk to cancelled session rejected');
    }

    console.log('\n========================================');
    console.log('7. EXISTING /addEvent API & MULTIPART COMPATIBILITY');
    console.log('========================================');

    // Test 7.1: Existing multipart single image upload
    {
      const formData = new FormData();
      formData.append('name', 'Community Gathering');
      formData.append('event_date', '15-11-2026');
      const fakeImage = new Blob([Buffer.from('fake image content')], { type: 'image/jpeg' });
      formData.append('photos', fakeImage, 'pic1.jpg');

      const res = await fetch(`${baseUrl}/event/addEvent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin1Token}` },
        body: formData,
      });
      const data = await res.json();
      assert(res.status === 201, 'Existing /addEvent with image upload returns 201 Created');
      assert(data.data.name === 'Community Gathering', 'Event name saved correctly');
      assert(Boolean(data.data.image_url), 'image_url populated');
      assert(Array.isArray(data.data.image_urls) && data.data.image_urls.length === 1, 'image_urls is array');
    }

    // Test 7.2: Multiple images upload via multipart
    {
      const formData = new FormData();
      formData.append('name', 'Festival Celebration');
      formData.append('event_date', '20-11-2026');
      formData.append('photos', new Blob([Buffer.from('img1')], { type: 'image/jpeg' }), 'img1.jpg');
      formData.append('photos', new Blob([Buffer.from('img2')], { type: 'image/jpeg' }), 'img2.jpg');
      formData.append('photos', new Blob([Buffer.from('img3')], { type: 'image/jpeg' }), 'img3.jpg');

      const res = await fetch(`${baseUrl}/event/addEvent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin1Token}` },
        body: formData,
      });
      const data = await res.json();
      assert(res.status === 201, 'Multiple images upload returns 201 Created');
      assert(data.data.image_urls.length === 3, 'All 3 images saved in image_urls');
    }

    // Test 7.3: Video links array support
    {
      const res = await fetch(`${baseUrl}/event/addEvent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({
          name: 'Virtual Seminar',
          event_date: '25-11-2026',
          video_links: ['https://youtube.com/watch?v=123', 'https://vimeo.com/456'],
        }),
      });
      const data = await res.json();
      assert(res.status === 201, 'Event with video_links returns 201 Created');
      assert(data.data.video_links.length === 2, 'video_links stored correctly');
    }

    // Test 7.4: Date format validation
    {
      const res = await fetch(`${baseUrl}/event/addEvent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({
          name: 'Invalid Date Event',
          event_date: '2026-11-25', // wrong format, expects DD-MM-YYYY
        }),
      });
      assert(res.status === 400, 'Invalid date format rejected with 400 Bad Request');
    }

    console.log('\n========================================');
    console.log('8. INTEGRATED CHUNK UPLOAD + EVENT CREATION FLOW');
    console.log('========================================');

    // Test 8.1: Full integration with upload_id
    {
      const videoChunk = crypto.randomBytes(2 * 1024 * 1024);
      // 1. Init upload
      const initRes = await fetch(`${baseUrl}/event/initUpload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({ fileName: 'annual_gala.mp4', fileSize: videoChunk.length }),
      });
      const { data: initData } = await initRes.json();
      const galaUploadId = initData.uploadId;

      // 2. Upload chunk
      await fetch(`${baseUrl}/event/${galaUploadId}/chunks/0`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: videoChunk,
      });

      // 3. Complete
      const compRes = await fetch(`${baseUrl}/event/${galaUploadId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({}),
      });
      const { data: compData } = await compRes.json();
      const generatedVideoUrl = compData.videoUrl;

      // 4. Create event passing upload_id AND multipart photos
      const formData = new FormData();
      formData.append('name', 'Annual Gala 2026');
      formData.append('event_date', '30-11-2026');
      formData.append('upload_id', galaUploadId);
      formData.append('photos', new Blob([Buffer.from('cover image')], { type: 'image/jpeg' }), 'gala_cover.jpg');

      const eventRes = await fetch(`${baseUrl}/event/addEvent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin1Token}` },
        body: formData,
      });
      const eventData = await eventRes.json();
      assert(eventRes.status === 201, 'Event created with upload_id and multipart photos returns 201');
      assert(eventData.data.video_url === generatedVideoUrl, 'Event video_url matches completed chunk video URL');
      assert(eventData.data.video_urls.includes(generatedVideoUrl), 'Event video_urls contains completed video URL');
      assert(Boolean(eventData.data.image_url), 'Event image_url populated from multipart file');
    }

    // Test 8.2: Create event passing video_url directly in JSON body
    {
      const directVideoUrl = '/uploads/events/preuploaded_video.mp4';
      const eventRes = await fetch(`${baseUrl}/event/addEvent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin1Token}`,
        },
        body: JSON.stringify({
          name: 'Conference 2026',
          event_date: '05-12-2026',
          video_url: directVideoUrl,
        }),
      });
      const eventData = await eventRes.json();
      assert(eventRes.status === 201, 'Event created with direct video_url returns 201');
      assert(eventData.data.video_url === directVideoUrl, 'Event video_url matches direct body value');
      assert(eventData.data.video_urls.includes(directVideoUrl), 'video_urls contains direct video_url');
    }

    console.log('\n========================================');
    console.log(`ALL TESTS PASSED: ${passedTests}/${totalTests}`);
    console.log('========================================\n');
  } catch (err) {
    console.error('\n❌ Test execution failed with error:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

runTests();
