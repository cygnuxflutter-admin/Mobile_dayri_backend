const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { sendSuccess } = require("../utils/response");

const uploadDir = path.join(__dirname, "..", "uploads", "events");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");
    const timestamp = Date.now();
    cb(null, `${timestamp}-${safeName}`);
  },
});

const eventUpload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const createEventsTable = `
  CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    event_date TIMESTAMPTZ NOT NULL,
    image_url TEXT,
    image_urls JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

async function ensureEventsTable(pool) {
  await pool.query(createEventsTable);
  await pool.query(
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS image_urls JSONB`,
  );
}

function normalizeFilesInput(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  if (typeof files === "object") {
    // multer.fields() produces an object like { photos: [File], 'photos[]': [File] }
    return Object.values(files).flat();
  }
  return [];
}

function buildEventPayload(body, files) {
  const fileList = normalizeFilesInput(files);
  const imageUrls = fileList.length
    ? fileList.map((f) => `/uploads/events/${f.filename}`)
    : null;

  return {
    name: body.name?.trim() || null,
    eventDate: body.event_date || body.eventDate || null,
    imageUrl: imageUrls ? imageUrls[0] : null,
    imageUrls,
  };
}

function validateEvent(payload) {
  if (!payload.name) {
    return { error: "Missing required field", fields: ["name"] };
  }

  if (!payload.eventDate) {
    return { error: "Missing required field", fields: ["event_date"] };
  }

  const dateString = String(payload.eventDate).trim();

  // Expected format: DD-MM-YYYY
  const match = dateString.match(/^(\d{2})-(\d{2})-(\d{4})$/);

  if (!match) {
    return {
      error: "event_date must be in DD-MM-YYYY format",
    };
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  // Validate actual calendar date
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return {
      error: "event_date must be a valid date",
    };
  }

  // Convert DD-MM-YYYY -> YYYY-MM-DDT00:00:00+05:30
  payload.eventDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+05:30`;

  return null;
}

function eventController(pool) {
  return {
    eventUpload,
    async addEvent(request, response) {
      const payload = buildEventPayload(request.body, request.files);
      const validationError = validateEvent(payload);

      console.log(validationError, "validationError");

      if (validationError) {
        return response.status(400).json(validationError);
      }

      try {
        const result = await pool.query(
          `INSERT INTO events (name, event_date, image_url, image_urls) VALUES ($1, $2::timestamptz, $3, $4::jsonb) RETURNING *`,
          [
            payload.name,
            payload.eventDate,
            payload.imageUrl,
            payload.imageUrls ? JSON.stringify(payload.imageUrls) : null,
          ],
        );

        return sendSuccess(
          response,
          201,
          "Event created successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to add event:", error.message);
        return response.status(500).json({ error: "Failed to add event" });
      }
    },

    async getEvents(request, response) {
      try {
        const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
        const limit = Math.min(
          100,
          Math.max(1, Number.parseInt(request.query.limit, 10) || 20),
        );
        const offset = (page - 1) * limit;

        const query = `
          SELECT id, name, event_date, image_url, image_urls, created_at, updated_at,
                 COUNT(*) OVER() AS total_count
          FROM events
          ORDER BY event_date DESC
          LIMIT $1 OFFSET $2
        `;

        const result = await pool.query(query, [limit, offset]);

        const total =
          result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
        const events = result.rows.map((r) => {
          const { total_count, ...rest } = r;
          return rest;
        });

        return sendSuccess(response, 200, "Events fetched successfully", {
          events,
          meta: { total, page, limit },
        });
      } catch (error) {
        console.error("Failed to fetch events:", error.message);
        return response.status(500).json({ error: "Failed to fetch events" });
      }
    },

    async deleteEvent(request, response) {
      const eventId = request.params.id;

      try {
        const result = await pool.query(
          `DELETE FROM events WHERE id = $1 RETURNING *`,
          [eventId],
        );

        if (result.rowCount === 0) {
          return response.status(404).json({ error: "Event not found" });
        }

        return sendSuccess(
          response,
          200,
          "Event deleted successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to delete event:", error.message);
        return response.status(500).json({ error: "Failed to delete event" });
      }
    },

    async updateEvent(request, response) {
      const eventId = request.params.id;
      const payload = buildEventPayload(request.body, request.files);
      const validationError = validateEvent(payload);

      if (validationError) {
        return response.status(400).json(validationError);
      }

      try {
        const result = await pool.query(
          `UPDATE events SET name = $1, event_date = $2::timestamptz, image_url = $3, image_urls = $4::jsonb, updated_at = NOW() WHERE id = $5 RETURNING *`,
          [
            payload.name,
            payload.eventDate,
            payload.imageUrl,
            payload.imageUrls ? JSON.stringify(payload.imageUrls) : null,
            eventId,
          ],
        );

        if (result.rowCount === 0) {
          return response.status(404).json({ error: "Event not found" });
        }

        return sendSuccess(
          response,
          200,
          "Event updated successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to update event:", error.message);
        return response.status(500).json({ error: "Failed to update event" });
      }
    },
  };
}

module.exports = { eventController, ensureEventsTable };
