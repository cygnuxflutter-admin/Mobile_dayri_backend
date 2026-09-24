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

const eventUpload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const createEventsTable = `
  CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    event_date TIMESTAMPTZ NOT NULL,
    image_url TEXT,
    image_urls JSONB,
    video_url TEXT,
    video_urls JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

async function ensureEventsTable(pool) {
  await pool.query(createEventsTable);
  await pool.query(
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS image_urls JSONB`,
  );
  await pool.query(
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS video_url TEXT`,
  );
  await pool.query(
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS video_urls JSONB`,
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

function isVideoFile(file) {
  const extension = path.extname(file.originalname || file.filename || "").toLowerCase();
  return (
    file.mimetype?.startsWith("video/") ||
    [".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v"].includes(
      extension,
    )
  );
}

function buildEventPayload(body, files) {
  const fileList = normalizeFilesInput(files);
  const imageUrls = fileList
    .filter(
      (file) =>
        !isVideoFile(file) &&
        (file.mimetype?.startsWith("image/") || Boolean(file.filename)),
    )
    .map((file) => `/uploads/events/${file.filename}`);
  const videoUrls = fileList
    .filter(isVideoFile)
    .map((file) => `/uploads/events/${file.filename}`);

  const coverUrl = body.image_url || body.imageUrl;
  if (coverUrl && imageUrls.length > 0) {
    const normCover = normalizeMediaUrl(coverUrl);
    const foundIdx = imageUrls.findIndex((u) => normalizeMediaUrl(u) === normCover || u === coverUrl);
    if (foundIdx > 0) {
      const [chosenCover] = imageUrls.splice(foundIdx, 1);
      imageUrls.unshift(chosenCover);
    }
  }

  return {
    name: body.name?.trim() || null,
    eventDate: body.event_date || body.eventDate || null,
    imageUrl: imageUrls[0] || (coverUrl ? normalizeMediaUrl(coverUrl) : null),
    imageUrls: imageUrls.length > 0 ? imageUrls : null,
    videoUrl: videoUrls[0] || null,
    videoUrls: videoUrls.length > 0 ? videoUrls : null,
  };
}

function parseMediaUrls(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return String(value)
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean);
  }
}

function normalizeMediaUrl(value) {
  const rawUrl = String(value || "").trim();
  if (!rawUrl) return "";

  try {
    return new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return rawUrl.split("?")[0];
  }
}

function storedMediaUrls(event, pluralField, singularField) {
  const urls = Array.isArray(event[pluralField])
    ? event[pluralField]
    : event[singularField]
      ? [event[singularField]]
      : [];
  return urls.map(String).filter(Boolean);
}

function removeEventFiles(urls) {
  for (const url of urls) {
    const normalizedUrl = normalizeMediaUrl(url);
    if (!normalizedUrl.startsWith("/uploads/events/")) continue;
    const filePath = path.join(
      __dirname,
      "..",
      normalizedUrl.replace(/^\//, ""),
    );
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
      console.error("Failed to remove event file:", error.message);
    }
  }
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
          `INSERT INTO events (name, event_date, image_url, image_urls, video_url, video_urls)
           VALUES ($1, $2::timestamptz, $3, $4::jsonb, $5, $6::jsonb)
           RETURNING *`,
          [
            payload.name,
            payload.eventDate,
            payload.imageUrl,
            payload.imageUrls ? JSON.stringify(payload.imageUrls) : null,
            payload.videoUrl,
            payload.videoUrls ? JSON.stringify(payload.videoUrls) : null,
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
          SELECT id, name, event_date, image_url, image_urls, video_url, video_urls, created_at, updated_at,
                 COUNT(*) OVER() AS total_count
          FROM events
             ORDER BY event_date DESC, id DESC
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
      const eventId = Number.parseInt(request.params.id, 10);

      if (!Number.isInteger(eventId) || eventId < 1) {
        return response
          .status(400)
          .json({ error: "Event id must be a positive integer" });
      }

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
      const eventId = Number.parseInt(request.params.id, 10);

      if (!Number.isInteger(eventId) || eventId < 1) {
        return response
          .status(400)
          .json({ error: "Event id must be a positive integer" });
      }

      try {
        const existingResult = await pool.query(
          `SELECT * FROM events WHERE id = $1 LIMIT 1`,
          [eventId],
        );

        if (existingResult.rowCount === 0) {
          return response.status(404).json({ error: "Event not found" });
        }

        const existingEvent = existingResult.rows[0];
        const uploadedPayload = buildEventPayload(
          request.body,
          request.files,
        );
        const imageUrls = storedMediaUrls(
          existingEvent,
          "image_urls",
          "image_url",
        );
        const videoUrls = storedMediaUrls(
          existingEvent,
          "video_urls",
          "video_url",
        );
        const deletedImageUrls = parseMediaUrls(
          request.body.deleteImageUrls ??
            request.body.removeImageUrls ??
            request.body.deleteImages,
        );
        const deletedVideoUrls = parseMediaUrls(
          request.body.deleteVideoUrls ??
            request.body.removeVideoUrls ??
            request.body.deleteVideos,
        );
        const deletedImageUrlSet = new Set(
          deletedImageUrls.map(normalizeMediaUrl),
        );
        const deletedVideoUrlSet = new Set(
          deletedVideoUrls.map(normalizeMediaUrl),
        );
        let nextImageUrls = [
          ...imageUrls.filter(
            (url) => !deletedImageUrlSet.has(normalizeMediaUrl(url)),
          ),
          ...(uploadedPayload.imageUrls || []),
        ];
        const coverUrlRaw = request.body.image_url || request.body.imageUrl;
        if (coverUrlRaw && nextImageUrls.length > 0) {
          const normCover = normalizeMediaUrl(coverUrlRaw);
          const foundIdx = nextImageUrls.findIndex(
            (u) => normalizeMediaUrl(u) === normCover || u === coverUrlRaw,
          );
          if (foundIdx > 0) {
            const [chosenCover] = nextImageUrls.splice(foundIdx, 1);
            nextImageUrls.unshift(chosenCover);
          }
        }
        const nextVideoUrls = [
          ...videoUrls.filter(
            (url) => !deletedVideoUrlSet.has(normalizeMediaUrl(url)),
          ),
          ...(uploadedPayload.videoUrls || []),
        ];
        const payload = {
          name:
            request.body.name !== undefined
              ? request.body.name?.trim() || null
              : existingEvent.name,
          eventDate:
            request.body.event_date !== undefined ||
            request.body.eventDate !== undefined
              ? request.body.event_date || request.body.eventDate
              : existingEvent.event_date,
          imageUrl: nextImageUrls[0] || (coverUrlRaw ? normalizeMediaUrl(coverUrlRaw) : null),
          imageUrls: nextImageUrls.length > 0 ? nextImageUrls : null,
          videoUrl: nextVideoUrls[0] || null,
          videoUrls: nextVideoUrls.length > 0 ? nextVideoUrls : null,
        };
        let validationError = null;
        if (!payload.name) {
          validationError = {
            error: "Missing required field",
            fields: ["name"],
          };
        } else if (
          request.body.event_date !== undefined ||
          request.body.eventDate !== undefined
        ) {
          validationError = validateEvent(payload);
        }

        if (validationError) {
          return response.status(400).json(validationError);
        }

        const result = await pool.query(
          `UPDATE events
           SET name = $1, event_date = $2::timestamptz, image_url = $3,
               image_urls = $4::jsonb, video_url = $5, video_urls = $6::jsonb,
               updated_at = NOW()
           WHERE id = $7
           RETURNING *`,
          [
            payload.name,
            payload.eventDate,
            payload.imageUrl,
            payload.imageUrls ? JSON.stringify(payload.imageUrls) : null,
            payload.videoUrl,
            payload.videoUrls ? JSON.stringify(payload.videoUrls) : null,
            eventId,
          ],
        );

        removeEventFiles([...deletedImageUrls, ...deletedVideoUrls]);

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
