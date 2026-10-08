import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { db } from "../firebaseAdmin.js";
import { COLLECTIONS } from "../constants/collections.js";

const router = Router();

// Read-only, de-identified data feed for Power BI's "Web" connector.
// Deliberately NOT behind Firebase auth: Power BI's scheduled refresh can't
// sign in as a staff member, so it authenticates with one shared secret
// (BI_API_KEY) instead. Because of that, nothing here ever returns names,
// emails, phone numbers, notes or free-text answers — only codes, statuses,
// counts and scores — so a leaked key exposes aggregates, not people.
const CACHE_TTL_MS =
  (Number(process.env.BI_CACHE_SECONDS) > 0
    ? Number(process.env.BI_CACHE_SECONDS)
    : 600) * 1000;

let cache = { loadedAt: 0, tables: null, pending: null };

const requireApiKey = (req, res, next) => {
  const expected = process.env.BI_API_KEY;

  if (!expected) {
    return res.status(503).json({ error: "BI feed is not configured." });
  }

  const provided = req.get("x-api-key") || req.query.key || "";
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid API key." });
  }

  return next();
};

const toIso = (value) => (value?.toDate ? value.toDate().toISOString() : "");
const toDay = (value) => toIso(value).slice(0, 10);
const average = (nums) =>
  nums.length ? Number((nums.reduce((s, n) => s + n, 0) / nums.length).toFixed(1)) : "";
const isNum = (v) => typeof v === "number" && !Number.isNaN(v);

const fetchAll = async (name) => {
  const snap = await db.collection(name).get();
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
};

const groupBy = (items, field) => {
  const map = new Map();
  items.forEach((item) => {
    const key = item[field];
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return map;
};

const buildTables = async () => {
  const [cohorts, participants, fgds, evaluations, champions] = await Promise.all([
    fetchAll(COLLECTIONS.COHORTS),
    fetchAll(COLLECTIONS.PARTICIPANTS),
    fetchAll(COLLECTIONS.FGDS),
    fetchAll(COLLECTIONS.PARTICIPANT_EVALUATIONS),
    fetchAll(COLLECTIONS.CHAMPIONS_POOL),
  ]);

  const participantsByCohort = groupBy(participants, "cohort_id");
  const participantsByFgd = groupBy(participants, "fgd_id");
  const fgdsByCohort = groupBy(fgds, "cohort_id");
  const evaluationsByChampion = groupBy(evaluations, "champion_id");
  const participantsById = new Map(participants.map((p) => [p.id, p]));
  const fgdsById = new Map(fgds.map((f) => [f.id, f]));
  const championsById = new Map(champions.map((c) => [c.id, c]));

  // Same rule as the app: a doc with no status predates drafts and was
  // always a final submission.
  const isSubmitted = (e) => (e.status || "Submitted") === "Submitted";

  const cohortRows = cohorts.map((c) => {
    const ps = participantsByCohort.get(c.id) || [];
    return {
      cohort_code: c.cohort_code || "",
      cohort_name: c.cohort_name || "",
      district: c.district || "",
      area: c.area || "",
      center: c.center || "",
      status: c.status || "",
      registration_open_date: c.registration_open_date || "",
      registration_close_date: c.registration_close_date || "",
      class_start_date: c.class_start_date || "",
      class_end_date: c.class_end_date || "",
      pitch_day_date: c.pitch_day_date || "",
      graduation_date: c.graduation_date || "",
      total_registrations: ps.length,
      total_fgds: (fgdsByCohort.get(c.id) || []).length,
      total_selected: ps.filter((p) => p.selection_status === "Selected").length,
      total_waitlisted: ps.filter((p) => p.selection_status === "Waitlisted").length,
      total_rejected: ps.filter((p) => p.selection_status === "Rejected").length,
      total_enrolled: ps.filter((p) => p.enrollment_status === "Enrolled").length,
      total_graduated: ps.filter((p) => p.graduation_status === "Graduated").length,
    };
  });

  const participantRows = participants.map((p) => ({
    participant_code: p.participant_code || "",
    cohort_code: p.cohort_code || "",
    cohort_name: p.cohort_name || "",
    gender: p.gender || "",
    age: p.age || "",
    institution: p.institution || "",
    registration_status: p.registration_status || "",
    selection_status: p.selection_status || "",
    enrollment_status: p.enrollment_status || "",
    graduation_status: p.graduation_status || "",
    project_status: p.project_status || "",
    payment_status: p.payment_status || "",
    fgd_code: p.fgd_code || "",
    fgd_attendance_status: p.fgd_attendance_status || "",
    average_evaluation_score: isNum(p.average_evaluation_score)
      ? Number(p.average_evaluation_score.toFixed(1))
      : "",
    registered_date: toDay(p.submitted_at || p.created_at),
    registered_at: toIso(p.submitted_at || p.created_at),
    import_source: p.import_source || "",
  }));

  const fgdRows = fgds.map((f) => {
    const ps = participantsByFgd.get(f.id) || [];
    return {
      fgd_code: f.fgd_code || "",
      fgd_name: f.fgd_name || "",
      cohort_code: f.cohort_code || "",
      cohort_name: f.cohort_name || "",
      session_date: f.session_date || "",
      session_start_time: f.session_start_time || "",
      session_end_time: f.session_end_time || "",
      venue: f.venue || "",
      status: f.status || "",
      participant_limit: f.participant_limit || 0,
      total_participants: ps.length,
      present_count: ps.filter((p) => p.fgd_attendance_status === "Present").length,
      absent_count: ps.filter((p) => p.fgd_attendance_status === "Absent").length,
      pending_count: ps.filter(
        (p) => (p.fgd_attendance_status || "Pending") === "Pending"
      ).length,
      avg_evaluation_score: average(
        ps.map((p) => p.average_evaluation_score).filter(isNum)
      ),
      committee_size: (f.committee_members || []).length,
    };
  });

  // Rubric criteria keys vary by rubric version, so the per-criterion
  // columns are derived from whatever keys actually exist in the data.
  const rubricKeys = Array.from(
    new Set(evaluations.flatMap((e) => Object.keys(e.rubric_scores || {})))
  ).sort();

  const evaluationRows = evaluations.map((e) => {
    const row = {
      participant_code: participantsById.get(e.participant_id)?.participant_code || "",
      fgd_code: fgdsById.get(e.fgd_id)?.fgd_code || "",
      champion_code: championsById.get(e.champion_id)?.champion_code || "",
      status: e.status || "Submitted",
      rubric_total: isNum(e.rubric_total) ? e.rubric_total : "",
      feedback_option: e.feedback_option || "",
      recommendation_option: e.recommendation_option || "",
      computed_score: isNum(e.computed_score) ? Number(e.computed_score.toFixed(1)) : "",
      submitted_date: toDay(e.submitted_at),
    };
    rubricKeys.forEach((key) => {
      row[`rubric_${key}`] = isNum(e.rubric_scores?.[key]) ? e.rubric_scores[key] : "";
    });
    return row;
  });

  const championRows = champions.map((c) => {
    const evals = evaluationsByChampion.get(c.id) || [];
    const submitted = evals.filter(isSubmitted);
    const roles =
      Array.isArray(c.roles) && c.roles.length ? c.roles : c.role ? [c.role] : [];
    return {
      champion_code: c.champion_code || "",
      roles: roles.join(", "),
      institution: c.institution || "",
      registration_status: c.registration_status || "",
      account_status: c.account_status || "",
      member_status: c.member_status || "",
      assigned_fgd_count: c.assigned_fgd_count || 0,
      evaluations_submitted: submitted.length,
      evaluations_draft: evals.filter((e) => e.status === "Draft").length,
      avg_computed_score: average(submitted.map((e) => e.computed_score).filter(isNum)),
    };
  });

  return {
    cohorts: cohortRows,
    participants: participantRows,
    fgds: fgdRows,
    evaluations: evaluationRows,
    champions: championRows,
  };
};

// Every table is derived from the same five collection reads, cached for
// BI_CACHE_SECONDS. A Power BI refresh pulls several tables back to back
// (and several people can refresh), but they all share one Firestore read
// pass — this protects the free-plan daily read quota. Concurrent requests
// during a reload share the same in-flight promise.
const getTables = async (forceRefresh) => {
  const fresh = Date.now() - cache.loadedAt < CACHE_TTL_MS;

  if (cache.tables && fresh && !forceRefresh) return cache;
  if (cache.pending) return cache.pending;

  cache.pending = buildTables()
    .then((tables) => {
      cache = { loadedAt: Date.now(), tables, pending: null };
      return cache;
    })
    .catch((err) => {
      cache.pending = null;
      throw err;
    });

  return cache.pending;
};

const csvCell = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const toCsv = (rows) => {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const lines = [columns.map(csvCell).join(",")];
  rows.forEach((row) => lines.push(columns.map((c) => csvCell(row[c])).join(",")));
  // BOM so Power BI/Excel read Bengali institution names as UTF-8.
  return `﻿${lines.join("\r\n")}\r\n`;
};

router.use(requireApiKey);

router.get("/", (req, res) => {
  res.json({
    tables: ["cohorts", "participants", "fgds", "evaluations", "champions"],
    usage: "GET /api/bi/<table>?format=csv|json  (send the key as X-API-Key or ?key=)",
  });
});

router.get("/:table", async (req, res) => {
  const { table } = req.params;
  const forceRefresh = req.query.refresh === "1";

  try {
    const { tables, loadedAt } = await getTables(forceRefresh);
    const rows = tables[table];

    if (!rows) {
      return res.status(404).json({ error: `Unknown table "${table}".` });
    }

    res.set("Cache-Control", "no-store");
    res.set("X-Data-Loaded-At", new Date(loadedAt).toISOString());

    if (req.query.format === "json") {
      return res.json(rows);
    }

    res.type("text/csv; charset=utf-8");
    return res.send(toCsv(rows));
  } catch (err) {
    console.error("BI feed failed:", err);
    return res.status(500).json({ error: "Failed to build BI feed." });
  }
});

export default router;
