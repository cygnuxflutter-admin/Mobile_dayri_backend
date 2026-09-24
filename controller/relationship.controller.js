const { sendSuccess } = require("../utils/response");
const { sendPushNotification } = require("../utils/fcm.service");
const { createInAppNotification } = require("./notification.controller");

const createRelationshipRequestsTable = `
  CREATE TABLE IF NOT EXISTS relationship_requests (
    id BIGSERIAL PRIMARY KEY,
    requester_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    relationship_type VARCHAR(20) NOT NULL CHECK (relationship_type IN ('FATHER', 'SON')),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_different_users CHECK (requester_id != target_id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_pending_relationship_req 
  ON relationship_requests (requester_id, target_id, relationship_type) 
  WHERE status = 'PENDING';

  CREATE INDEX IF NOT EXISTS idx_rel_req_target_status 
  ON relationship_requests (target_id, status);

  CREATE INDEX IF NOT EXISTS idx_rel_req_requester_status 
  ON relationship_requests (requester_id, status);
`;

async function ensureRelationshipRequestsTable(pool) {
  try {
    await pool.query(createRelationshipRequestsTable);
    console.log("Relationship requests table ensured successfully");
  } catch (error) {
    console.error("Failed to ensure relationship_requests table:", error.message);
    throw error;
  }
}

/**
 * Helper to create or reuse a pending relationship request and notify target.
 */
async function processRelationshipRequest(pool, requesterId, targetId, relationshipType) {
  if (requesterId === targetId) {
    throw new Error("You cannot request a relationship with yourself");
  }

  // Verify target member exists, is active and not deleted
  const targetCheck = await pool.query(
    `SELECT id, "firstName", "middleName", "surname", "fcmToken", "fatherId", "sonIds"
     FROM members
     WHERE id = $1 AND COALESCE("isDeleted", false) = false
     LIMIT 1`,
    [targetId]
  );

  if (targetCheck.rowCount === 0) {
    throw new Error("Target member not found or deleted");
  }
  const targetMember = targetCheck.rows[0];

  // Verify requester exists
  const requesterCheck = await pool.query(
    `SELECT id, "firstName", "middleName", "surname", "fatherId", "sonIds"
     FROM members
     WHERE id = $1 AND COALESCE("isDeleted", false) = false
     LIMIT 1`,
    [requesterId]
  );

  if (requesterCheck.rowCount === 0) {
    throw new Error("Requester member not found");
  }
  const requesterMember = requesterCheck.rows[0];

  const requesterName = [
    requesterMember.firstName,
    requesterMember.middleName,
    requesterMember.surname,
  ].filter(Boolean).join(" ");

  // Validate existing active relationships
  if (relationshipType === "FATHER") {
    // Requester wants targetId to be their Father
    if (requesterMember.fatherId && Number(requesterMember.fatherId) === Number(targetId)) {
      throw new Error("This member is already your active Father");
    }

    // Cancel any older pending FATHER request by this requester to a different target
    await pool.query(
      `UPDATE relationship_requests
       SET status = 'CANCELLED', updated_at = NOW()
       WHERE requester_id = $1 AND relationship_type = 'FATHER' AND status = 'PENDING' AND target_id != $2`,
      [requesterId, targetId]
    );
  } else if (relationshipType === "SON") {
    // Requester wants targetId to be their Son
    if (Array.isArray(requesterMember.sonIds) && requesterMember.sonIds.map(Number).includes(Number(targetId))) {
      throw new Error("This member is already your active Son");
    }

    // Cancel older pending request to this specific target as Son if any
    await pool.query(
      `UPDATE relationship_requests
       SET status = 'CANCELLED', updated_at = NOW()
       WHERE requester_id = $1 AND target_id = $2 AND relationship_type = 'SON' AND status = 'PENDING'`,
      [requesterId, targetId]
    );
  }

  // Insert or reuse pending request
  let requestRecord;
  try {
    const insertResult = await pool.query(
      `INSERT INTO relationship_requests (requester_id, target_id, relationship_type, status)
       VALUES ($1, $2, $3, 'PENDING')
       ON CONFLICT (requester_id, target_id, relationship_type) WHERE status = 'PENDING'
       DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [requesterId, targetId, relationshipType]
    );
    requestRecord = insertResult.rows[0];
  } catch (err) {
    throw new Error(err.message);
  }

  // Send Push Notification via FCM
  const relLabel = relationshipType === "SON" ? "Father" : "Son";
  const notifTitle = "New Relationship Request";
  const notifBody = `${requesterName} wants to become your ${relLabel}. Please approve it from your dashboard.`;

  await createInAppNotification(pool, {
    userId: targetId,
    title: notifTitle,
    message: notifBody,
    type: "RELATIONSHIP_REQUEST",
    requestId: requestRecord.id,
    relationshipType,
  });

  if (typeof targetMember.fcmToken === "string" && targetMember.fcmToken.trim()) {
    await sendPushNotification(targetMember.fcmToken, {
      title: notifTitle,
      body: notifBody,
      data: {
        type: "RELATIONSHIP_REQUEST",
        requestId: String(requestRecord.id),
        requesterId: String(requesterId),
        relationshipType,
        requesterName,
      },
    });
  } else {
    console.warn(`No FCM token found for relationship target ${targetId}`);
  }

  return requestRecord;
}

function relationshipController(pool) {
  return {
    /**
     * Explicit API to create relationship request
     * POST /api/v1/relationship/request
     */
    async createRequest(request, response) {
      const caller = request.member;
      if (!caller || !caller.id) {
        return response.status(401).json({ error: "Unauthorized" });
      }

      const requesterId = Number(caller.id);
      const targetId = Number(request.body.targetUserId || request.body.targetId);
      const relationshipType = String(request.body.relationshipType || "").toUpperCase().trim();

      if (!Number.isInteger(targetId) || targetId <= 0) {
        return response.status(400).json({ error: "Valid targetUserId is required" });
      }

      if (!["FATHER", "SON"].includes(relationshipType)) {
        return response.status(400).json({ error: "relationshipType must be 'FATHER' or 'SON'" });
      }

      if (requesterId === targetId) {
        return response.status(400).json({ error: "You cannot request a relationship with yourself" });
      }

      try {
        const record = await processRelationshipRequest(pool, requesterId, targetId, relationshipType);
        return sendSuccess(response, 201, "Relationship request created successfully", record);
      } catch (error) {
        console.error("Failed to create relationship request:", error.message);
        return response.status(400).json({ error: error.message });
      }
    },

    /**
     * Get pending incoming requests for logged-in user
     * GET /api/v1/relationship/pending
     */
    async getPendingRequests(request, response) {
      const caller = request.member;
      if (!caller || !caller.id) {
        return response.status(401).json({ error: "Unauthorized" });
      }

      const userId = Number(caller.id);

      try {
        const query = `
          SELECT 
            r.id,
            r.requester_id,
            r.target_id,
            r.relationship_type,
            r.status,
            r.created_at,
            r.updated_at,
            m."firstName" AS "requesterFirstName",
            m."middleName" AS "requesterMiddleName",
            m."surname" AS "requesterSurname",
            m."firstNameEnglish" AS "requesterFirstNameEnglish",
            m."middleNameEnglish" AS "requesterMiddleNameEnglish",
            m."surnameEnglish" AS "requesterSurnameEnglish",
            m."photo_url" AS "requesterPhotoUrl",
            m."mobileNumber" AS "requesterMobileNumber",
            m.gender AS "requesterGender",
            CASE
              WHEN m."dateOfBirth" IS NULL OR TRIM(m."dateOfBirth") = '' THEN NULL
              WHEN TRIM(m."dateOfBirth") ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$'
                THEN DATE_PART('year', AGE(CURRENT_DATE, TO_DATE(TRIM(m."dateOfBirth"), 'DD-MM-YYYY')))
              WHEN TRIM(m."dateOfBirth") ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                THEN DATE_PART('year', AGE(CURRENT_DATE, TO_DATE(TRIM(m."dateOfBirth"), 'YYYY-MM-DD')))
              ELSE NULL
            END AS "requesterAge",
            CONCAT(m."firstName", ' ', m."middleName", ' ', m."surname") AS "requesterFullName"
          FROM relationship_requests r
          JOIN members m ON r.requester_id = m.id
          WHERE r.target_id = $1 
            AND r.status = 'PENDING'
            AND COALESCE(m."isDeleted", false) = false
          ORDER BY r.created_at DESC
        `;

        const result = await pool.query(query, [userId]);
        return sendSuccess(response, 200, "Pending requests fetched successfully", result.rows);
      } catch (error) {
        console.error("Failed to fetch pending requests:", error.message);
        return response.status(500).json({ error: "Failed to fetch pending requests" });
      }
    },

    /**
     * Get outgoing requests sent by logged-in user
     * GET /api/v1/relationship/outgoing
     */
    async getOutgoingRequests(request, response) {
      const caller = request.member;
      if (!caller || !caller.id) {
        return response.status(401).json({ error: "Unauthorized" });
      }

      const userId = Number(caller.id);

      try {
        const statusFilter = request.query.status;
        let statusCondition = "";
        const queryParams = [userId];
        if (statusFilter && statusFilter.toUpperCase() !== "ALL") {
          queryParams.push(statusFilter.toUpperCase());
          statusCondition = ` AND r.status = $${queryParams.length}`;
        }

        const query = `
          SELECT 
            r.id,
            r.requester_id,
            r.target_id,
            r.relationship_type,
            r.status,
            r.created_at,
            r.updated_at,
            m."firstName" AS "targetFirstName",
            m."middleName" AS "targetMiddleName",
            m."surname" AS "targetSurname",
            m."firstNameEnglish" AS "targetFirstNameEnglish",
            m."middleNameEnglish" AS "targetMiddleNameEnglish",
            m."surnameEnglish" AS "targetSurnameEnglish",
            m."photo_url" AS "targetPhotoUrl",
            m."mobileNumber" AS "targetMobileNumber",
            m.gender AS "targetGender",
            CASE
              WHEN m."dateOfBirth" IS NULL OR TRIM(m."dateOfBirth") = '' THEN NULL
              WHEN TRIM(m."dateOfBirth") ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$'
                THEN DATE_PART('year', AGE(CURRENT_DATE, TO_DATE(TRIM(m."dateOfBirth"), 'DD-MM-YYYY')))
              WHEN TRIM(m."dateOfBirth") ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                THEN DATE_PART('year', AGE(CURRENT_DATE, TO_DATE(TRIM(m."dateOfBirth"), 'YYYY-MM-DD')))
              ELSE NULL
            END AS "targetAge",
            CONCAT(m."firstName", ' ', m."middleName", ' ', m."surname") AS "targetFullName"
          FROM relationship_requests r
          JOIN members m ON r.target_id = m.id
          WHERE r.requester_id = $1 
            ${statusCondition}
            AND COALESCE(m."isDeleted", false) = false
          ORDER BY r.created_at DESC
        `;

        const result = await pool.query(query, queryParams);
        return sendSuccess(response, 200, "Outgoing requests fetched successfully", result.rows);
      } catch (error) {
        console.error("Failed to fetch outgoing requests:", error.message);
        return response.status(500).json({ error: "Failed to fetch outgoing requests" });
      }
    },

    /**
     * Accept a pending request
     * POST /api/v1/relationship/:id/accept
     */
    async acceptRequest(request, response) {
      const caller = request.member;
      if (!caller || !caller.id) {
        return response.status(401).json({ error: "Unauthorized" });
      }

      const requestId = Number(request.params.id);
      if (!Number.isInteger(requestId) || requestId <= 0) {
        return response.status(400).json({ error: "Valid request ID is required" });
      }

      const callerId = Number(caller.id);
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // 1. Fetch request with row lock
        const requestQuery = await client.query(
          `SELECT * FROM relationship_requests WHERE id = $1 FOR UPDATE`,
          [requestId]
        );

        if (requestQuery.rowCount === 0) {
          await client.query("ROLLBACK");
          return response.status(404).json({ error: "Relationship request not found" });
        }

        const reqRecord = requestQuery.rows[0];

        // 2. Validate authorization (only target can accept)
        if (Number(reqRecord.target_id) !== callerId) {
          await client.query("ROLLBACK");
          return response.status(403).json({ error: "You are not authorized to accept this request" });
        }

        // 3. Validate status
        if (reqRecord.status !== "PENDING") {
          await client.query("ROLLBACK");
          return response.status(400).json({
            error: `Request is no longer pending (current status: ${reqRecord.status})`,
          });
        }

        const requesterId = Number(reqRecord.requester_id);
        const targetId = Number(reqRecord.target_id);

        let fatherUserId;
        let sonUserId;

        if (reqRecord.relationship_type === "FATHER") {
          // Requester says target is Father -> Target is Father, Requester is Son
          fatherUserId = targetId;
          sonUserId = requesterId;
        } else {
          // Requester says target is Son -> Requester is Father, Target is Son
          fatherUserId = requesterId;
          sonUserId = targetId;
        }

        // 4. Check if Son previously had another Father
        const sonRecordResult = await client.query(
          `SELECT id, "fatherId" FROM members WHERE id = $1 FOR UPDATE`,
          [sonUserId]
        );

        if (sonRecordResult.rowCount === 0) {
          await client.query("ROLLBACK");
          return response.status(404).json({ error: "Son member record not found" });
        }

        const previousFatherId = sonRecordResult.rows[0].fatherId
          ? Number(sonRecordResult.rows[0].fatherId)
          : null;

        // If Son had another Father previously, remove Son from previous Father's sonIds
        if (previousFatherId && previousFatherId !== fatherUserId) {
          await client.query(
            `UPDATE members 
             SET "sonIds" = array_remove("sonIds", $1::bigint),
                 "updated_at" = NOW()
             WHERE id = $2`,
            [sonUserId, previousFatherId]
          );
        }

        // 5. Update Son's fatherId
        await client.query(
          `UPDATE members
           SET "fatherId" = $1,
               "updated_at" = NOW()
           WHERE id = $2`,
          [fatherUserId, sonUserId]
        );

        // 6. Update Father's sonIds (append sonUserId if not already present)
        await client.query(
          `UPDATE members
           SET "sonIds" = CASE 
                            WHEN "sonIds" IS NULL THEN ARRAY[$1::bigint]
                            WHEN NOT ($1::bigint = ANY("sonIds")) THEN array_append("sonIds", $1::bigint)
                            ELSE "sonIds"
                          END,
               "updated_at" = NOW()
           WHERE id = $2`,
          [sonUserId, fatherUserId]
        );

        // 7. Update request status to ACCEPTED
        const updatedRequest = await client.query(
          `UPDATE relationship_requests
           SET status = 'ACCEPTED', updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [requestId]
        );

        // 8. Auto-cancel any other conflicting pending father requests for this Son
        await client.query(
          `UPDATE relationship_requests
           SET status = 'CANCELLED', updated_at = NOW()
           WHERE id != $1 
             AND status = 'PENDING'
             AND (
               (requester_id = $2 AND relationship_type = 'FATHER')
               OR (target_id = $2 AND relationship_type = 'SON')
             )`,
          [requestId, sonUserId]
        );

        await client.query("COMMIT");

        // 9. Send notification to the requester after the transaction succeeds.
        try {
          const usersInfo = await pool.query(
            `SELECT id, "firstName", "middleName", surname, "fcmToken"
             FROM members WHERE id IN ($1, $2)`,
            [requesterId, targetId],
          );
          const requester = usersInfo.rows.find(
            (user) => Number(user.id) === requesterId,
          );
          const accepter = usersInfo.rows.find(
            (user) => Number(user.id) === targetId,
          );
          const accepterName = [
            accepter?.firstName,
            accepter?.middleName,
            accepter?.surname,
          ]
            .filter(Boolean)
            .join(" ");

          await createInAppNotification(pool, {
            userId: requesterId,
            title: "Relationship Request Accepted",
            message: `${accepterName} accepted your relationship request.`,
            type: "RELATIONSHIP_ACCEPTED",
            requestId,
            relationshipType: reqRecord.relationship_type,
          });

          if (requester?.fcmToken) {
            await sendPushNotification(requester.fcmToken, {
              title: "Relationship Request Accepted",
              body: `${accepterName} accepted your relationship request.`,
              data: {
                type: "RELATIONSHIP_ACCEPTED",
                requestId: String(requestId),
                targetId: String(targetId),
                relationshipType: reqRecord.relationship_type,
              },
            });
          } else {
            console.warn(
              `No FCM token found for relationship requester ${requesterId}`,
            );
          }
        } catch (notificationError) {
          console.error(
            "Post-accept notification error:",
            notificationError.message,
          );
        }

        return sendSuccess(
          response,
          200,
          "Relationship request accepted and active relationship updated successfully",
          updatedRequest.rows[0]
        );
      } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to accept relationship request:", error.message);
        return response.status(500).json({ error: "Failed to accept relationship request" });
      } finally {
        client.release();
      }
    },

    /**
     * Reject a pending request
     * POST /api/v1/relationship/:id/reject
     */
    async rejectRequest(request, response) {
      const caller = request.member;
      if (!caller || !caller.id) {
        return response.status(401).json({ error: "Unauthorized" });
      }

      const requestId = Number(request.params.id);
      if (!Number.isInteger(requestId) || requestId <= 0) {
        return response.status(400).json({ error: "Valid request ID is required" });
      }

      const callerId = Number(caller.id);

      try {
        const fetchResult = await pool.query(
          `SELECT * FROM relationship_requests WHERE id = $1`,
          [requestId]
        );

        if (fetchResult.rowCount === 0) {
          return response.status(404).json({ error: "Relationship request not found" });
        }

        const reqRecord = fetchResult.rows[0];

        if (Number(reqRecord.target_id) !== callerId) {
          return response.status(403).json({ error: "You are not authorized to reject this request" });
        }

        if (reqRecord.status !== "PENDING") {
          return response.status(400).json({
            error: `Request is no longer pending (current status: ${reqRecord.status})`,
          });
        }

        const updateResult = await pool.query(
          `UPDATE relationship_requests
           SET status = 'REJECTED', updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [requestId]
        );

        // Notify requester
        (async () => {
          try {
            const usersInfo = await pool.query(
              `SELECT id, "firstName", "surname", "fcmToken" FROM members WHERE id IN ($1, $2)`,
              [reqRecord.requester_id, reqRecord.target_id]
            );
            const reqUser = usersInfo.rows.find((u) => Number(u.id) === Number(reqRecord.requester_id));
            const tgtUser = usersInfo.rows.find((u) => Number(u.id) === Number(reqRecord.target_id));

            if (reqUser && reqUser.fcmToken) {
              const tgtName = [tgtUser?.firstName, tgtUser?.surname].filter(Boolean).join(" ");
              sendPushNotification(reqUser.fcmToken, {
                title: "Relationship Request Declined",
                body: `${tgtName} declined your relationship request.`,
                data: {
                  type: "RELATIONSHIP_REJECTED",
                  requestId: String(requestId),
                },
              });
            }
          } catch (notifErr) {
            console.error("Post-reject notification error:", notifErr.message);
          }
        })();

        return sendSuccess(response, 200, "Relationship request rejected", updateResult.rows[0]);
      } catch (error) {
        console.error("Failed to reject relationship request:", error.message);
        return response.status(500).json({ error: "Failed to reject relationship request" });
      }
    },

    /**
     * Cancel an outgoing pending request
     * POST /api/v1/relationship/:id/cancel
     */
    async cancelRequest(request, response) {
      const caller = request.member;
      if (!caller || !caller.id) {
        return response.status(401).json({ error: "Unauthorized" });
      }

      const requestId = Number(request.params.id);
      if (!Number.isInteger(requestId) || requestId <= 0) {
        return response.status(400).json({ error: "Valid request ID is required" });
      }

      const callerId = Number(caller.id);

      try {
        const fetchResult = await pool.query(
          `SELECT * FROM relationship_requests WHERE id = $1`,
          [requestId]
        );

        if (fetchResult.rowCount === 0) {
          return response.status(404).json({ error: "Relationship request not found" });
        }

        const reqRecord = fetchResult.rows[0];

        if (Number(reqRecord.requester_id) !== callerId) {
          return response.status(403).json({ error: "You are not authorized to cancel this request" });
        }

        if (reqRecord.status !== "PENDING") {
          return response.status(400).json({
            error: `Request is no longer pending (current status: ${reqRecord.status})`,
          });
        }

        const updateResult = await pool.query(
          `UPDATE relationship_requests
           SET status = 'CANCELLED', updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [requestId]
        );

        return sendSuccess(response, 200, "Relationship request cancelled successfully", updateResult.rows[0]);
      } catch (error) {
        console.error("Failed to cancel relationship request:", error.message);
        return response.status(500).json({ error: "Failed to cancel relationship request" });
      }
    },
  };
}

module.exports = {
  relationshipController,
  ensureRelationshipRequestsTable,
  processRelationshipRequest,
};
