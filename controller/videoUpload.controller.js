const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');
const { sendSuccess } = require('../utils/response');

// Configuration constants
const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024; // 5 MiB
const MIN_CHUNK_SIZE = 1 * 1024 * 1024;     // 1 MiB
const MAX_CHUNK_SIZE = 10 * 1024 * 1024;    // 10 MiB
const MAX_FILE_SIZE = 1024 * 1024 * 1024;   // 1 GiB (1,073,741,824 bytes)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp', '.m4v'];

// Storage directories
// Temporary chunks are stored outside the public uploads directory
const TEMP_UPLOAD_BASE = path.resolve(
  process.env.TEMP_UPLOAD_DIR || path.join(__dirname, '..', 'temp_chunks')
);
// Completed video files are stored in the existing event uploads directory
const FINAL_UPLOAD_BASE = path.resolve(
  process.env.VIDEO_UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'events')
);

// Ensure directories exist
if (!fs.existsSync(TEMP_UPLOAD_BASE)) {
  fs.mkdirSync(TEMP_UPLOAD_BASE, { recursive: true });
}
if (!fs.existsSync(FINAL_UPLOAD_BASE)) {
  fs.mkdirSync(FINAL_UPLOAD_BASE, { recursive: true });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function sanitizeChunkIndex(value) {
  if (value === undefined || value === null) return -1;
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : -1;
}

function isSafePath(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

const createVideoUploadTablesSQL = `
  CREATE TABLE IF NOT EXISTS video_upload_sessions (
    id UUID PRIMARY KEY,
    member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    mime_type TEXT,
    file_size BIGINT NOT NULL,
    chunk_size INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    checksum TEXT,
    checksum_algorithm TEXT DEFAULT 'sha256',
    status TEXT NOT NULL DEFAULT 'initialized' CHECK (status IN ('initialized', 'uploading', 'assembling', 'completed', 'cancelled', 'failed', 'expired')),
    storage_path TEXT NOT NULL,
    final_file_name TEXT,
    final_file_path TEXT,
    final_file_url TEXT,
    error_message TEXT,
    metadata JSONB,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS video_upload_chunks (
    upload_id UUID NOT NULL REFERENCES video_upload_sessions(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    size BIGINT NOT NULL,
    checksum TEXT,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (upload_id, chunk_index)
  );

  CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_member_id ON video_upload_sessions(member_id);
  CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_status ON video_upload_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_expires_at ON video_upload_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_video_upload_chunks_upload_id ON video_upload_chunks(upload_id);
`;

async function ensureVideoUploadsTable(pool) {
  await pool.query(createVideoUploadTablesSQL);
}

function videoUploadController(pool) {
  return {
    ensureVideoUploadsTable: () => ensureVideoUploadsTable(pool),

    /**
     * POST /initUpload
     * Initialize a resumable video upload session.
     */
    async initUpload(request, response) {
      const memberId = request.member?.id;
      if (!memberId) {
        return response.status(401).json({ error: 'Unauthorized: Missing authenticated member' });
      }

      const body = request.body || {};
      const fileName = String(body.fileName || body.file_name || '').trim();
      const rawFileSize = body.fileSize !== undefined ? body.fileSize : body.file_size;
      const fileSize = Number(rawFileSize);
      const rawChunkSize = body.chunkSize !== undefined ? body.chunkSize : body.chunk_size;
      const mimeType = body.mimeType || body.mime_type || null;
      const checksum = body.checksum ? String(body.checksum).trim().toLowerCase() : null;
      const checksumAlgorithm = (body.checksumAlgorithm || body.checksum_algorithm || 'sha256').toLowerCase();

      if (!fileName) {
        return response.status(400).json({ error: 'fileName is required' });
      }

      const ext = path.extname(fileName).toLowerCase();
      if (!ALLOWED_VIDEO_EXTENSIONS.includes(ext) && !(mimeType && mimeType.startsWith('video/'))) {
        return response.status(400).json({
          error: `Invalid video file type. Allowed extensions: ${ALLOWED_VIDEO_EXTENSIONS.join(', ')}`,
        });
      }

      if (!Number.isFinite(fileSize) || fileSize <= 0) {
        return response.status(400).json({ error: 'fileSize must be a positive number' });
      }

      if (fileSize > MAX_FILE_SIZE) {
        return response.status(400).json({
          error: `fileSize exceeds maximum allowed limit of 1 GiB (${MAX_FILE_SIZE} bytes)`,
        });
      }

      let configuredChunkSize = DEFAULT_CHUNK_SIZE;
      if (rawChunkSize !== undefined) {
        const parsedChunk = Number(rawChunkSize);
        if (Number.isFinite(parsedChunk) && parsedChunk >= MIN_CHUNK_SIZE && parsedChunk <= MAX_CHUNK_SIZE) {
          configuredChunkSize = parsedChunk;
        } else {
          return response.status(400).json({
            error: `chunkSize must be between ${MIN_CHUNK_SIZE} (1 MiB) and ${MAX_CHUNK_SIZE} (10 MiB) bytes`,
          });
        }
      }

      const totalChunks = Math.ceil(fileSize / configuredChunkSize);
      const uploadId = crypto.randomUUID();
      const sessionDir = path.join(TEMP_UPLOAD_BASE, uploadId);
      const chunksDir = path.join(sessionDir, 'chunks');

      if (!isSafePath(TEMP_UPLOAD_BASE, sessionDir)) {
        return response.status(400).json({ error: 'Invalid upload session path' });
      }

      try {
        await fs.promises.mkdir(chunksDir, { recursive: true });
      } catch (fsErr) {
        console.error('Failed to create session chunk directory:', fsErr.message);
        return response.status(500).json({ error: 'Failed to initialize upload directory' });
      }

      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

      try {
        const insertQuery = `
          INSERT INTO video_upload_sessions (
            id, member_id, file_name, mime_type, file_size, chunk_size, total_chunks,
            checksum, checksum_algorithm, status, storage_path, expires_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, 'initialized', $10, $11
          ) RETURNING id, file_name, file_size, chunk_size, total_chunks, expires_at, created_at
        `;

        const result = await pool.query(insertQuery, [
          uploadId,
          memberId,
          fileName,
          mimeType,
          fileSize,
          configuredChunkSize,
          totalChunks,
          checksum,
          checksumAlgorithm,
          sessionDir,
          expiresAt,
        ]);

        const session = result.rows[0];

        return sendSuccess(response, 201, 'Upload session initialized successfully', {
          uploadId: session.id,
          fileName: session.file_name,
          fileSize: Number(session.file_size),
          chunkSize: session.chunk_size,
          totalChunks: session.total_chunks,
          expiresAt: session.expires_at,
        });
      } catch (dbErr) {
        console.error('Failed to create upload session in database:', dbErr.message);
        try {
          await fs.promises.rm(sessionDir, { recursive: true, force: true });
        } catch (_) {}
        return response.status(500).json({ error: 'Failed to create upload session' });
      }
    },

    /**
     * PUT /:uploadId/chunks/:chunkIndex
     * Upload one chunk at a time using streaming and disk-based temporary storage.
     */
    async uploadChunk(request, response) {
      const { uploadId } = request.params;
      const chunkIndexRaw = request.params.chunkIndex;

      if (!isValidUUID(uploadId)) {
        return response.status(400).json({ error: 'Invalid uploadId format (must be UUID)' });
      }

      const chunkIndex = sanitizeChunkIndex(chunkIndexRaw);
      if (chunkIndex < 0) {
        return response.status(400).json({ error: 'Invalid chunkIndex (must be non-negative integer)' });
      }

      const memberId = request.member?.id;
      const memberRole = request.member?.role;

      let session;
      try {
        const sessionResult = await pool.query(
          `SELECT * FROM video_upload_sessions WHERE id = $1 LIMIT 1`,
          [uploadId]
        );

        if (sessionResult.rowCount === 0) {
          return response.status(404).json({ error: 'Upload session not found' });
        }
        session = sessionResult.rows[0];
      } catch (dbErr) {
        console.error('Failed to query upload session:', dbErr.message);
        return response.status(500).json({ error: 'Database error' });
      }

      // Authorization & Ownership check
      if (Number(session.member_id) !== Number(memberId) && memberRole !== 'SUPERADMIN') {
        return response.status(403).json({ error: 'Forbidden: You do not own this upload session' });
      }

      // Status check
      if (session.status === 'completed') {
        return response.status(400).json({ error: 'Upload session has already been completed' });
      }
      if (session.status === 'cancelled') {
        return response.status(400).json({ error: 'Upload session has been cancelled' });
      }
      if (session.status === 'failed') {
        return response.status(400).json({ error: `Upload session marked failed: ${session.error_message || 'unknown error'}` });
      }
      if (session.status === 'assembling') {
        return response.status(409).json({ error: 'Upload session is currently being assembled' });
      }

      // Expiry check
      if (new Date(session.expires_at).getTime() < Date.now()) {
        return response.status(410).json({ error: 'Upload session has expired' });
      }

      // Chunk index bounds check
      if (chunkIndex >= session.total_chunks) {
        return response.status(400).json({
          error: `chunkIndex ${chunkIndex} out of bounds. Expected 0 to ${session.total_chunks - 1}`,
        });
      }

      const totalFileSize = Number(session.file_size);
      const chunkSize = session.chunk_size;
      const isLastChunk = chunkIndex === session.total_chunks - 1;
      const expectedSize = isLastChunk
        ? totalFileSize - chunkSize * (session.total_chunks - 1)
        : chunkSize;

      const sessionDir = path.resolve(session.storage_path);
      if (!isSafePath(TEMP_UPLOAD_BASE, sessionDir)) {
        return response.status(400).json({ error: 'Invalid session storage directory' });
      }

      const chunksDir = path.join(sessionDir, 'chunks');
      const finalChunkPath = path.join(chunksDir, `chunk_${chunkIndex}`);
      const partChunkPath = path.join(chunksDir, `chunk_${chunkIndex}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}.part`);

      if (!isSafePath(chunksDir, finalChunkPath) || !isSafePath(chunksDir, partChunkPath)) {
        return response.status(400).json({ error: 'Path traversal detected in chunk path' });
      }

      try {
        await fs.promises.mkdir(chunksDir, { recursive: true });
      } catch (err) {
        return response.status(500).json({ error: 'Failed to access chunk storage' });
      }

      // Handle disk streaming
      let bytesWritten = 0;
      let writeStream;
      let finished = false;
      let aborted = false;

      const cleanupPart = async () => {
        try {
          if (fs.existsSync(partChunkPath)) {
            await fs.promises.unlink(partChunkPath);
          }
        } catch (_) {}
      };

      try {
        writeStream = fs.createWriteStream(partChunkPath, { flags: 'w' });
      } catch (fsErr) {
        console.error('Failed to create chunk write stream:', fsErr.message);
        return response.status(500).json({ error: 'Failed to initialize chunk file write' });
      }

      const handleStreamError = async (err, statusCode = 500, msg = 'Stream error') => {
        if (finished) return;
        finished = true;
        try {
          writeStream.destroy();
          await cleanupPart();
        } catch (_) {}
        if (!response.headersSent) {
          response.status(statusCode).json({ error: msg });
        }
      };

      request.on('aborted', async () => {
        aborted = true;
        handleStreamError(new Error('Client aborted request'), 499, 'Client closed connection');
      });

      request.on('error', (err) => {
        handleStreamError(err, 500, 'Incoming request stream error: ' + err.message);
      });

      writeStream.on('error', (err) => {
        handleStreamError(err, 500, 'Disk write error: ' + err.message);
      });

      const contentType = request.headers['content-type'] || '';

      if (contentType.includes('multipart/form-data')) {
        let bb;
        try {
          bb = busboy({ headers: request.headers, limits: { fileSize: expectedSize + 1024 * 1024 } });
        } catch (bbErr) {
          return handleStreamError(bbErr, 400, 'Invalid multipart request: ' + bbErr.message);
        }

        let fileFound = false;

        bb.on('file', (fieldname, fileStream) => {
          fileFound = true;
          fileStream.on('data', (data) => {
            bytesWritten += data.length;
          });
          fileStream.on('error', (err) => {
            handleStreamError(err, 500, 'File stream error: ' + err.message);
          });
          fileStream.pipe(writeStream);
        });

        bb.on('close', async () => {
          if (aborted) return;
          if (!fileFound) {
            return handleStreamError(new Error('No file field in multipart request'), 400, 'No chunk file provided in multipart body');
          }
          await processChunkCompletion();
        });

        bb.on('error', (err) => {
          handleStreamError(err, 400, 'Multipart parse error: ' + err.message);
        });

        request.pipe(bb);
      } else {
        // Raw octet-stream / binary stream
        request.on('data', (data) => {
          bytesWritten += data.length;
        });

        request.pipe(writeStream);

        writeStream.on('finish', async () => {
          if (aborted) return;
          await processChunkCompletion();
        });
      }

      async function processChunkCompletion() {
        if (finished) return;

        try {
          // Verify physical size
          const stat = await fs.promises.stat(partChunkPath);
          if (stat.size !== expectedSize) {
            await cleanupPart();
            finished = true;
            return response.status(400).json({
              error: `Chunk size mismatch. Expected ${expectedSize} bytes, received ${stat.size} bytes`,
              expectedSize,
              receivedSize: stat.size,
            });
          }

          // Atomic rename to final chunk path
          await fs.promises.rename(partChunkPath, finalChunkPath);

          // Persist chunk record in DB
          await pool.query(
            `INSERT INTO video_upload_chunks (upload_id, chunk_index, size, uploaded_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (upload_id, chunk_index)
             DO UPDATE SET size = EXCLUDED.size, uploaded_at = NOW()`,
            [uploadId, chunkIndex, stat.size]
          );

          // Update session status to 'uploading' if it was 'initialized'
          await pool.query(
            `UPDATE video_upload_sessions
             SET status = 'uploading', updated_at = NOW()
             WHERE id = $1 AND status = 'initialized'`,
            [uploadId]
          );

          finished = true;
          return sendSuccess(response, 200, 'Chunk uploaded successfully', {
            uploadId,
            chunkIndex,
            size: stat.size,
          });
        } catch (err) {
          console.error('Error completing chunk:', err.message);
          await cleanupPart();
          finished = true;
          if (!response.headersSent) {
            return response.status(500).json({ error: 'Failed to finalize chunk: ' + err.message });
          }
        }
      }
    },

    /**
     * GET /:uploadId/status
     * Return uploaded and missing chunks so interrupted uploads can resume.
     */
    async getUploadStatus(request, response) {
      const { uploadId } = request.params;

      if (!isValidUUID(uploadId)) {
        return response.status(400).json({ error: 'Invalid uploadId format (must be UUID)' });
      }

      const memberId = request.member?.id;
      const memberRole = request.member?.role;

      let session;
      try {
        const sessionResult = await pool.query(
          `SELECT * FROM video_upload_sessions WHERE id = $1 LIMIT 1`,
          [uploadId]
        );

        if (sessionResult.rowCount === 0) {
          return response.status(404).json({ error: 'Upload session not found' });
        }
        session = sessionResult.rows[0];
      } catch (dbErr) {
        console.error('Failed to query upload session:', dbErr.message);
        return response.status(500).json({ error: 'Database error' });
      }

      if (Number(session.member_id) !== Number(memberId) && memberRole !== 'SUPERADMIN') {
        return response.status(403).json({ error: 'Forbidden: You do not own this upload session' });
      }

      try {
        const chunksResult = await pool.query(
          `SELECT chunk_index, size FROM video_upload_chunks WHERE upload_id = $1 ORDER BY chunk_index ASC`,
          [uploadId]
        );

        const chunksDir = path.join(session.storage_path, 'chunks');
        const verifiedChunks = [];
        const missingFromDisk = [];

        for (const row of chunksResult.rows) {
          const chunkPath = path.join(chunksDir, `chunk_${row.chunk_index}`);
          try {
            const stat = await fs.promises.stat(chunkPath);
            if (stat.size === Number(row.size)) {
              verifiedChunks.push(row.chunk_index);
            } else {
              missingFromDisk.push(row.chunk_index);
            }
          } catch (_) {
            missingFromDisk.push(row.chunk_index);
          }
        }

        // Clean up DB records if files are physically missing on disk
        if (missingFromDisk.length > 0) {
          await pool.query(
            `DELETE FROM video_upload_chunks WHERE upload_id = $1 AND chunk_index = ANY($2::int[])`,
            [uploadId, missingFromDisk]
          );
        }

        const uploadedSet = new Set(verifiedChunks);
        const missingChunks = [];
        for (let i = 0; i < session.total_chunks; i++) {
          if (!uploadedSet.has(i)) {
            missingChunks.push(i);
          }
        }

        const isComplete = missingChunks.length === 0;

        return sendSuccess(response, 200, 'Upload status fetched successfully', {
          uploadId: session.id,
          status: session.status,
          fileName: session.file_name,
          fileSize: Number(session.file_size),
          chunkSize: session.chunk_size,
          totalChunks: session.total_chunks,
          uploadedChunks: verifiedChunks,
          uploadedCount: verifiedChunks.length,
          missingChunks,
          missingCount: missingChunks.length,
          isComplete,
          videoUrl: session.final_file_url || null,
          expiresAt: session.expires_at,
        });
      } catch (err) {
        console.error('Failed to compute upload status:', err.message);
        return response.status(500).json({ error: 'Failed to get upload status' });
      }
    },

    /**
     * POST /:uploadId/complete
     * Verify all chunks, assemble the original video, validate final size and optional checksum,
     * and return the final video URL.
     */
    async completeUpload(request, response) {
      const { uploadId } = request.params;

      if (!isValidUUID(uploadId)) {
        return response.status(400).json({ error: 'Invalid uploadId format (must be UUID)' });
      }

      const memberId = request.member?.id;
      const memberRole = request.member?.role;

      let session;
      try {
        const sessionResult = await pool.query(
          `SELECT * FROM video_upload_sessions WHERE id = $1 LIMIT 1`,
          [uploadId]
        );

        if (sessionResult.rowCount === 0) {
          return response.status(404).json({ error: 'Upload session not found' });
        }
        session = sessionResult.rows[0];
      } catch (dbErr) {
        console.error('Failed to query upload session:', dbErr.message);
        return response.status(500).json({ error: 'Database error' });
      }

      if (Number(session.member_id) !== Number(memberId) && memberRole !== 'SUPERADMIN') {
        return response.status(403).json({ error: 'Forbidden: You do not own this upload session' });
      }

      // Idempotency: If already completed, return existing result
      if (session.status === 'completed') {
        return sendSuccess(response, 200, 'Video upload already completed', {
          uploadId: session.id,
          videoUrl: session.final_file_url,
          fileName: session.final_file_name,
          fileSize: Number(session.file_size),
          checksum: session.checksum,
        });
      }

      if (session.status === 'cancelled') {
        return response.status(400).json({ error: 'Cannot complete a cancelled upload session' });
      }

      // Verify all chunks in DB and on disk
      const chunksDir = path.join(session.storage_path, 'chunks');
      const chunksResult = await pool.query(
        `SELECT chunk_index, size FROM video_upload_chunks WHERE upload_id = $1 ORDER BY chunk_index ASC`,
        [uploadId]
      );

      const dbChunkMap = new Map();
      for (const row of chunksResult.rows) {
        dbChunkMap.set(row.chunk_index, Number(row.size));
      }

      const missingChunks = [];
      for (let i = 0; i < session.total_chunks; i++) {
        if (!dbChunkMap.has(i)) {
          missingChunks.push(i);
          continue;
        }
        const chunkPath = path.join(chunksDir, `chunk_${i}`);
        try {
          const stat = await fs.promises.stat(chunkPath);
          if (stat.size !== dbChunkMap.get(i)) {
            missingChunks.push(i);
          }
        } catch (_) {
          missingChunks.push(i);
        }
      }

      if (missingChunks.length > 0) {
        return response.status(400).json({
          error: 'Upload incomplete: missing or damaged chunks',
          missingChunks,
          missingCount: missingChunks.length,
          totalChunks: session.total_chunks,
        });
      }

      // Safe state transition to prevent concurrent assembly
      const transitionResult = await pool.query(
        `UPDATE video_upload_sessions
         SET status = 'assembling', updated_at = NOW()
         WHERE id = $1 AND status IN ('initialized', 'uploading')
         RETURNING *`,
        [uploadId]
      );

      if (transitionResult.rowCount === 0) {
        const recheck = await pool.query(
          `SELECT status, final_file_url, final_file_name, file_size, checksum FROM video_upload_sessions WHERE id = $1`,
          [uploadId]
        );
        const current = recheck.rows[0];
        if (current?.status === 'completed') {
          return sendSuccess(response, 200, 'Video upload already completed', {
            uploadId,
            videoUrl: current.final_file_url,
            fileName: current.final_file_name,
            fileSize: Number(current.file_size),
            checksum: current.checksum,
          });
        }
        if (current?.status === 'assembling') {
          return response.status(409).json({ error: 'Video is currently being assembled' });
        }
        return response.status(400).json({ error: `Cannot assemble session with status ${current?.status}` });
      }

      // Server-generated random filename
      const originalExt = path.extname(session.file_name).toLowerCase();
      const safeExt = ALLOWED_VIDEO_EXTENSIONS.includes(originalExt) ? originalExt : '.mp4';
      const randomBaseName = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${safeExt}`;
      const tempAssembledPath = path.join(FINAL_UPLOAD_BASE, `${randomBaseName}.assembling`);
      const finalFilePath = path.join(FINAL_UPLOAD_BASE, randomBaseName);
      const finalUrl = `/uploads/events/${randomBaseName}`;

      if (!isSafePath(FINAL_UPLOAD_BASE, finalFilePath) || !isSafePath(FINAL_UPLOAD_BASE, tempAssembledPath)) {
        await pool.query(
          `UPDATE video_upload_sessions SET status = 'failed', error_message = 'Path traversal detected in final destination', updated_at = NOW() WHERE id = $1`,
          [uploadId]
        );
        return response.status(500).json({ error: 'Invalid file assembly destination' });
      }

      const checksumAlgorithm = session.checksum_algorithm || 'sha256';
      const hasher = crypto.createHash(checksumAlgorithm);
      const writeStream = fs.createWriteStream(tempAssembledPath, { flags: 'w' });

      try {
        for (let i = 0; i < session.total_chunks; i++) {
          const chunkPath = path.join(chunksDir, `chunk_${i}`);
          await new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(chunkPath);
            readStream.on('data', (chunk) => {
              hasher.update(chunk);
            });
            readStream.on('error', reject);
            readStream.pipe(writeStream, { end: false });
            readStream.on('end', resolve);
          });
        }

        await new Promise((resolve, reject) => {
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
          writeStream.end();
        });
      } catch (streamErr) {
        console.error('Error during chunk assembly stream:', streamErr.message);
        try {
          if (fs.existsSync(tempAssembledPath)) {
            await fs.promises.unlink(tempAssembledPath);
          }
        } catch (_) {}
        await pool.query(
          `UPDATE video_upload_sessions SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1`,
          [uploadId, 'Assembly error: ' + streamErr.message]
        );
        return response.status(500).json({ error: 'Failed to assemble video chunks: ' + streamErr.message });
      }

      // Validate assembled file size
      try {
        const stat = await fs.promises.stat(tempAssembledPath);
        const expectedTotalSize = Number(session.file_size);

        if (stat.size !== expectedTotalSize) {
          await fs.promises.unlink(tempAssembledPath);
          await pool.query(
            `UPDATE video_upload_sessions SET status = 'failed', error_message = 'Assembled size mismatch', updated_at = NOW() WHERE id = $1`,
            [uploadId]
          );
          return response.status(400).json({
            error: `Assembled file size mismatch. Expected ${expectedTotalSize} bytes, got ${stat.size} bytes`,
            expectedSize: expectedTotalSize,
            actualSize: stat.size,
          });
        }

        // Validate optional checksum
        const computedChecksum = hasher.digest('hex');
        const expectedChecksum = request.body?.checksum
          ? String(request.body.checksum).trim().toLowerCase()
          : session.checksum
            ? String(session.checksum).trim().toLowerCase()
            : null;

        if (expectedChecksum && computedChecksum !== expectedChecksum) {
          await fs.promises.unlink(tempAssembledPath);
          await pool.query(
            `UPDATE video_upload_sessions SET status = 'failed', error_message = 'Checksum verification failed', updated_at = NOW() WHERE id = $1`,
            [uploadId]
          );
          return response.status(400).json({
            error: 'Checksum verification failed: hash mismatch',
            expected: expectedChecksum,
            computed: computedChecksum,
            algorithm: checksumAlgorithm,
          });
        }

        // Rename temp assembled file to final file
        await fs.promises.rename(tempAssembledPath, finalFilePath);

        // Update database session
        await pool.query(
          `UPDATE video_upload_sessions
           SET status = 'completed',
               final_file_name = $2,
               final_file_path = $3,
               final_file_url = $4,
               checksum = $5,
               updated_at = NOW()
           WHERE id = $1`,
          [uploadId, randomBaseName, finalFilePath, finalUrl, computedChecksum]
        );

        // Clean up temporary chunk files and directory
        try {
          const sessionDir = path.resolve(session.storage_path);
          if (isSafePath(TEMP_UPLOAD_BASE, sessionDir) && fs.existsSync(sessionDir)) {
            await fs.promises.rm(sessionDir, { recursive: true, force: true });
          }
        } catch (cleanupErr) {
          console.error('Non-critical: Failed to remove temporary session directory:', cleanupErr.message);
        }

        return sendSuccess(response, 200, 'Video assembled and verified successfully', {
          uploadId,
          videoUrl: finalUrl,
          fileName: randomBaseName,
          fileSize: stat.size,
          checksum: computedChecksum,
        });
      } catch (finalizeErr) {
        console.error('Error finalizing assembled video:', finalizeErr.message);
        try {
          if (fs.existsSync(tempAssembledPath)) await fs.promises.unlink(tempAssembledPath);
        } catch (_) {}
        await pool.query(
          `UPDATE video_upload_sessions SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1`,
          [uploadId, finalizeErr.message]
        );
        return response.status(500).json({ error: 'Failed to finalize video assembly' });
      }
    },

    /**
     * DELETE /:uploadId
     * Cancel an incomplete upload and clean up temporary files.
     */
    async cancelUpload(request, response) {
      const { uploadId } = request.params;

      if (!isValidUUID(uploadId)) {
        return response.status(400).json({ error: 'Invalid uploadId format (must be UUID)' });
      }

      const memberId = request.member?.id;
      const memberRole = request.member?.role;

      let session;
      try {
        const sessionResult = await pool.query(
          `SELECT * FROM video_upload_sessions WHERE id = $1 LIMIT 1`,
          [uploadId]
        );

        if (sessionResult.rowCount === 0) {
          return response.status(404).json({ error: 'Upload session not found' });
        }
        session = sessionResult.rows[0];
      } catch (dbErr) {
        console.error('Failed to query upload session:', dbErr.message);
        return response.status(500).json({ error: 'Database error' });
      }

      if (Number(session.member_id) !== Number(memberId) && memberRole !== 'SUPERADMIN') {
        return response.status(403).json({ error: 'Forbidden: You do not own this upload session' });
      }

      if (session.status === 'completed') {
        return response.status(400).json({ error: 'Cannot cancel an already completed upload' });
      }

      // Clean up temporary chunk files on disk
      try {
        const sessionDir = path.resolve(session.storage_path);
        if (isSafePath(TEMP_UPLOAD_BASE, sessionDir) && fs.existsSync(sessionDir)) {
          await fs.promises.rm(sessionDir, { recursive: true, force: true });
        }
      } catch (fsErr) {
        console.error('Failed to delete temporary chunk files during cancel:', fsErr.message);
      }

      try {
        await pool.query(
          `UPDATE video_upload_sessions SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
          [uploadId]
        );

        return sendSuccess(response, 200, 'Upload session cancelled and temporary files cleaned up', {
          uploadId,
          status: 'cancelled',
        });
      } catch (dbErr) {
        console.error('Failed to update session status on cancel:', dbErr.message);
        return response.status(500).json({ error: 'Failed to cancel upload session' });
      }
    },
  };
}

/**
 * Periodically cleans up expired sessions and abandoned chunk directories.
 */
async function cleanupExpiredUploadSessions(pool) {
  try {
    const expiredResult = await pool.query(
      `SELECT id, storage_path, status FROM video_upload_sessions
       WHERE (expires_at < NOW() AND status IN ('initialized', 'uploading', 'failed'))
          OR (status = 'cancelled' AND updated_at < NOW() - INTERVAL '1 hour')`
    );

    for (const row of expiredResult.rows) {
      try {
        const sessionDir = path.resolve(row.storage_path);
        if (isSafePath(TEMP_UPLOAD_BASE, sessionDir) && fs.existsSync(sessionDir)) {
          await fs.promises.rm(sessionDir, { recursive: true, force: true });
        }
      } catch (fsErr) {
        console.error(`Error deleting expired session dir ${row.id}:`, fsErr.message);
      }

      if (row.status !== 'cancelled') {
        await pool.query(
          `UPDATE video_upload_sessions SET status = 'expired', updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
      }
    }
  } catch (err) {
    console.error('Error during expired upload cleanup:', err.message);
  }
}

function startUploadCleanupJob(pool, intervalMs = 60 * 60 * 1000) {
  // Run once shortly after startup
  setTimeout(() => cleanupExpiredUploadSessions(pool).catch(() => {}), 10000);
  const timer = setInterval(() => {
    cleanupExpiredUploadSessions(pool).catch(() => {});
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  videoUploadController,
  ensureVideoUploadsTable,
  cleanupExpiredUploadSessions,
  startUploadCleanupJob,
  DEFAULT_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MAX_FILE_SIZE,
};
