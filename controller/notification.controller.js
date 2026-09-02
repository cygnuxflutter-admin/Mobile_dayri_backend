const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { sendSuccess } = require("../utils/response");

const uploadDir = path.join(__dirname, "..", "uploads", "notifications");
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

const notificationUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const createNotificationsTable = `
  CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    location TEXT,
    contact_numbers TEXT[],
    notify_type TEXT,
    photo_url TEXT,
    photo_urls JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`;

function parseContactNumbers(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (Array.isArray(value)) {
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    // not JSON
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildNotificationPayload(body, files) {
  const fileList = Array.isArray(files) ? files : files ? [files] : [];
  const photoUrls = fileList.length
    ? fileList.map((f) => `/uploads/notifications/${f.filename}`)
    : null;

  return {
    title: body.title?.trim() || null,
    message: body.message?.trim() || null,
    location: body.location?.trim() || null,
    contactNumbers:
      body.contact_numbers === null || body.contact_numbers === undefined
        ? null
        : parseContactNumbers(body.contact_numbers),
    notifyType: body.notify_type?.trim() || null,
    photoUrl: photoUrls ? photoUrls[0] : null,
    photoUrls,
  };
}

function validateNotification(payload, isUpdate = false) {
  if (!isUpdate) {
    const missing = [];
    if (!payload.title) missing.push("title");
    if (!payload.message) missing.push("message");
    if (missing.length > 0) {
      return { error: "Missing required fields", fields: missing };
    }
  }

  if (payload.contactNumbers !== null && payload.contactNumbers !== undefined) {
    if (
      !Array.isArray(payload.contactNumbers) ||
      !payload.contactNumbers.every(
        (value) => value && String(value).trim().length > 0,
      )
    ) {
      return { error: "contactNumbers must be an array of non-empty strings" };
    }
  }

  return null;
}

async function ensureNotificationsTable(pool) {
  await pool.query(createNotificationsTable);
  // ensure column to store multiple photo URLs exists
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS photo_urls JSONB`);
}

function notificationController(pool) {
  return {
    async addNotification(request, response) {
      console.log("Request body:", request.body);

      const payload = buildNotificationPayload(request.body, request.files);
      console.log("Notification added:", payload);
      const validationError = validateNotification(payload);

      if (validationError) {
        return response.status(400).json(validationError);
      }

      try {
        const result = await pool.query(
          `INSERT INTO notifications (
             title, message, location, contact_numbers, notify_type, photo_url, photo_urls
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           RETURNING *`,
          [
            payload.title,
            payload.message,
            payload.location,
            payload.contactNumbers,
            payload.notifyType,
            payload.photoUrl,
            payload.photoUrls ? JSON.stringify(payload.photoUrls) : null,
          ],
        );

        return sendSuccess(
          response,
          201,
          "Notification created successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to add notification:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to add notification" });
      }
    },

    async updateNotification(request, response) {
      const notificationId = Number.parseInt(request.params.id, 10);
      if (!Number.isInteger(notificationId) || notificationId < 1) {
        return response
          .status(400)
          .json({ error: "Notification id must be a positive integer" });
      }

      const payload = buildNotificationPayload(request.body, request.files);
      const validationError = validateNotification(payload, true);
      if (validationError) {
        return response.status(400).json(validationError);
      }

      const fields = [];
      const values = [];

      if (payload.title !== null) {
        fields.push("title = $" + (values.length + 1));
        values.push(payload.title);
      }
      if (payload.message !== null) {
        fields.push("message = $" + (values.length + 1));
        values.push(payload.message);
      }
      if (payload.location !== null) {
        fields.push("location = $" + (values.length + 1));
        values.push(payload.location);
      }
      if (payload.contactNumbers !== null) {
        fields.push("contact_numbers = $" + (values.length + 1));
        values.push(payload.contactNumbers);
      }
      if (payload.notifyType !== null) {
        fields.push("notify_type = $" + (values.length + 1));
        values.push(payload.notifyType);
      }
      if (payload.photoUrls !== null) {
        fields.push("photo_urls = $" + (values.length + 1));
        values.push(payload.photoUrls ? JSON.stringify(payload.photoUrls) : null);
      }
      if (payload.photoUrl !== null) {
        fields.push("photo_url = $" + (values.length + 1));
        values.push(payload.photoUrl);
      }

      if (fields.length === 0) {
        return response
          .status(400)
          .json({
            error: "At least one notification field is required for update",
          });
      }

      fields.push(`updated_at = NOW()`);
      values.push(notificationId);

      try {
        const result = await pool.query(
          `UPDATE notifications SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING *`,
          values,
        );

        if (result.rowCount === 0) {
          return response.status(404).json({ error: "Notification not found" });
        }

        return sendSuccess(
          response,
          200,
          "Notification updated successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to update notification:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to update notification" });
      }
    },

    async setNotificationActive(request, response) {
      const notificationId = Number.parseInt(request.params.id, 10);
      if (!Number.isInteger(notificationId) || notificationId < 1) {
        return response
          .status(400)
          .json({ error: 'Notification id must be a positive integer' });
      }

      const { is_active } = request.body;
      if (is_active === undefined) {
        return response.status(400).json({ error: 'is_active is required' });
      }
      if (typeof is_active !== 'boolean') {
        return response.status(400).json({ error: 'is_active must be a boolean' });
      }

      try {
        const result = await pool.query(
          'UPDATE notifications SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
          [is_active, notificationId],
        );

        if (result.rowCount === 0) {
          return response.status(404).json({ error: 'Notification not found' });
        }

        return sendSuccess(
          response,
          200,
          'Notification active state updated successfully',
          result.rows[0],
        );
      } catch (error) {
        console.error('Failed to set notification active state:', error.message);
        return response.status(500).json({ error: 'Failed to update notification' });
      }
    },

    async deleteNotification(request, response) {
      const notificationId = Number.parseInt(request.params.id, 10);
      if (!Number.isInteger(notificationId) || notificationId < 1) {
        return response
          .status(400)
          .json({ error: "Notification id must be a positive integer" });
      }

      try {
        const result = await pool.query(
          "DELETE FROM notifications WHERE id = $1 RETURNING id",
          [notificationId],
        );
        if (result.rowCount === 0) {
          return response.status(404).json({ error: "Notification not found" });
        }

        return sendSuccess(response, 200, "Notification deleted successfully", {
          id: result.rows[0].id,
        });
      } catch (error) {
        console.error("Failed to delete notification:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to delete notification" });
      }
    },

   async getAllNotifications(request, response) {
  try {
    const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(request.query.limit, 10) || 20)
    );
    const offset = (page - 1) * limit;

    // USER role -> only active notifications
    // ADMIN / SUPERADMIN / other roles -> all notifications
    const isUser = request.member?.role === 'USER';

    const query = `
      SELECT 
        id,
        title,
        message,
        location,
        contact_numbers,
        notify_type,
        photo_url,
        photo_urls,
        is_active,
        created_at,
        updated_at,
        COUNT(*) OVER() AS total_count
      FROM notifications
      ${isUser ? 'WHERE is_active = true' : ''}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);

    const total =
      result.rows.length > 0
        ? Number(result.rows[0].total_count)
        : 0;

    const notifications = result.rows.map((r) => {
      const { total_count, ...rest } = r;
      return rest;
    });

    return sendSuccess(
      response,
      200,
      'Notifications fetched successfully',
      {
        notifications,
        meta: {
          total,
          page,
          limit,
        },
      }
    );
  } catch (error) {
    console.error('Failed to fetch notifications:', error.message);

    return response
      .status(500)
      .json({ error: 'Failed to fetch notifications' });
  }
},

    async getNotificationById(request, response) {
      const notificationId = Number.parseInt(request.params.id, 10);
      if (!Number.isInteger(notificationId) || notificationId < 1) {
        return response
          .status(400)
          .json({ error: "Notification id must be a positive integer" });
      }

      try {
        const result = await pool.query(
          "SELECT * FROM notifications WHERE id = $1",
          [notificationId],
        );
        if (result.rowCount === 0) {
          return response.status(404).json({ error: "Notification not found" });
        }

        return sendSuccess(
          response,
          200,
          "Notification fetched successfully",
          result.rows[0],
        );
      } catch (error) {
        console.error("Failed to fetch notification:", error.message);
        return response
          .status(500)
          .json({ error: "Failed to fetch notification" });
      }
    },
  };
}

module.exports = {
  notificationUpload,
  notificationController,
  ensureNotificationsTable,
};
