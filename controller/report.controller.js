const { sendSuccess } = require('../utils/response');

function reportController(pool) {
  return {
    async getDashboard(request, response) {
      try {
        const totalRes = await pool.query('SELECT COUNT(*)::int AS total FROM members');
        const totalMembers = Number(totalRes.rows[0]?.total || 0);

        const weekRes = await pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW()) AND created_at <= NOW())::int AS current_week,
            COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW()) - INTERVAL '1 week' AND created_at < date_trunc('week', NOW()))::int AS previous_week
          FROM members
        `);

        const currentWeek = Number(weekRes.rows[0]?.current_week || 0);
        const previousWeek = Number(weekRes.rows[0]?.previous_week || 0);

        let percentChange = 0;
        if (previousWeek === 0) {
          percentChange = currentWeek > 0 ? 100 : 0;
        } else {
          percentChange = ((currentWeek - previousWeek) / previousWeek) * 100;
        }

        const dailyRes = await pool.query(`
          WITH days AS (
            SELECT generate_series((CURRENT_DATE - INTERVAL '6 days')::date, CURRENT_DATE::date, INTERVAL '1 day')::date AS day
          ), counts AS (
            SELECT created_at::date AS day, COUNT(*) AS cnt FROM members WHERE created_at >= CURRENT_DATE - INTERVAL '6 days' GROUP BY created_at::date
          )
          SELECT LEFT(to_char(d.day, 'FMDay'), 1) AS day_letter, COALESCE(c.cnt, 0) AS cnt
          FROM days d LEFT JOIN counts c ON d.day = c.day
          ORDER BY d.day
        `);

        const dailyCounts = dailyRes.rows.map((r) => Number(r.cnt || 0));

        const genderRes = await pool.query(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE LOWER(gender) = 'male')::int AS male,
            COUNT(*) FILTER (WHERE LOWER(gender) = 'female')::int AS female
          FROM members
        `);

        const genderRow = genderRes.rows[0] || { total: 0, male: 0, female: 0 };
        const malePct = genderRow.total ? Math.round((genderRow.male / genderRow.total) * 100) : 0;
        const femalePct = genderRow.total ? Math.round((genderRow.female / genderRow.total) * 100) : 0;

        const eventsRes = await pool.query('SELECT COUNT(*)::int AS events FROM events');
        const eventsHeld = Number(eventsRes.rows[0]?.events || 0);

        const notifRes = await pool.query('SELECT COUNT(*)::int AS notifications FROM notifications');
        const alertsSent = Number(notifRes.rows[0]?.notifications || 0);

        const newMonthRes = await pool.query(`
          SELECT COUNT(*)::int AS new_this_month FROM members WHERE created_at >= date_trunc('month', NOW()) AND created_at <= NOW()
        `);
        const newMembersThisMonth = Number(newMonthRes.rows[0]?.new_this_month || 0);

       
       

        return sendSuccess(response, 200, 'Dashboard report fetched successfully', {
          totalMembers,
          percentChange: Math.round(percentChange * 10) / 10,
          dailyCounts,
          genderDistribution: {
            male: malePct,
            female: femalePct,
          },
          eventsHeld,
          alertsSent,
          newMembersThisMonth,
        
        });
      } catch (error) {
        console.error('Failed to fetch dashboard report:', error.message);
        return response.status(500).json({ error: 'Failed to fetch dashboard report' });
      }
    }
  };
}

module.exports = { reportController };
