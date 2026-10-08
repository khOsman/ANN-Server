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

// ---------------------------------------------------------------------
// Raw per-collection feed (/api/bi/raw/:collection) — every document of a
// Firestore collection as one row, for building a star schema in Power BI.
//
// Safety rules, because this exposes the real documents:
//  * Credential-like fields (token/secret/password/hash/otp) are NEVER
//    returned, regardless of any setting.
//  * Personal fields (name, email, phone, DOB, notes, free-text feedback...)
//    are stripped from the collections that hold people, and from form
//    answers that are identifying, unless BI_INCLUDE_PII=true is set on the
//    server. Rows stay joinable through ids and participant/champion codes.
//  * impersonation_sessions is never exposed (it is a login-as mechanism).
// ---------------------------------------------------------------------
const INCLUDE_PII = process.env.BI_INCLUDE_PII === "true";

const RAW_COLLECTIONS = [
  "audit_log",
  "champions_pool",
  "cohorts",
  "counters",
  "data_points",
  "databases",
  "fgds",
  "form_fields",
  "form_responses",
  "forms",
  "participant_evaluations",
  "participants",
  "users",
];

// Collections whose documents describe people — PII stripping applies here.
// Schema-like collections (data_points, form_fields, forms, cohorts...) use
// keys such as "name" for non-personal things, so they are left untouched.
const PII_COLLECTIONS = new Set([
  "audit_log",
  "champions_pool",
  "fgds",
  "form_responses",
  "participant_evaluations",
  "participants",
  "users",
]);

const ALWAYS_DROP_KEY = /token|secret|password|passcode|hash|otp|api_?key/i;
const PII_EXACT_KEYS = new Set([
  "name",
  "email",
  "phone",
  "mobile",
  "date_of_birth",
  "dob",
  "address",
  "nid",
  "display_name",
  "photo_url",
  "notes",
  "fgd_feedback",
  "selection_committee_notes",
  "feedback",
]);
const PII_KEY_PATTERN = /(^|_)(email|phone|mobile)(_|$)|_by_name$|^(actor|user|evaluator|champion)_name$/i;

const isPiiKey = (key) => PII_EXACT_KEYS.has(key) || PII_KEY_PATTERN.test(key);

// Firestore value -> plain JSON value (Timestamps as ISO strings, refs as
// their path); strips credential keys and, for people collections, PII keys.
const normalizeValue = (value, stripPii) => {
  if (value === null || value === undefined) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, stripPii));
  if (typeof value === "object") {
    if (typeof value.path === "string" && value.firestore) return value.path;
    if (typeof value.latitude === "number" && typeof value.longitude === "number") {
      return `${value.latitude},${value.longitude}`;
    }
    const out = {};
    Object.entries(value).forEach(([key, v]) => {
      if (ALWAYS_DROP_KEY.test(key)) return;
      if (stripPii && isPiiKey(key)) return;
      out[key] = normalizeValue(v, stripPii);
    });
    return out;
  }
  return value;
};

// Whole-column drops (served view only) for fields whose contents are
// identifying but can't be detected by key: answers hold free-form values
// and custom_data is keyed by data-point id. The same answers are available
// per-question, with identifying ones blanked, via form_response_answers.
const DROP_WHEN_STRIPPED = {
  form_responses: ["answers"],
  participants: ["custom_data"],
};

const rawCache = new Map(); // collection -> { loadedAt, rows, pending }

const loadRaw = async (name) => {
  const entry = rawCache.get(name);
  if (entry?.rows && Date.now() - entry.loadedAt < CACHE_TTL_MS) return entry;
  if (entry?.pending) return entry.pending;

  const stripPii = !INCLUDE_PII && PII_COLLECTIONS.has(name);

  const pending = db
    .collection(name)
    .get()
    .then((snap) => {
      const rows = snap.docs.map((d) => ({
        id: d.id,
        ...normalizeValue(d.data(), stripPii),
      }));
      const loaded = { loadedAt: Date.now(), rows, pending: null };
      rawCache.set(name, loaded);
      return loaded;
    })
    .catch((err) => {
      rawCache.delete(name);
      throw err;
    });

  rawCache.set(name, { ...(entry || {}), pending });
  return pending;
};

// Long "answers" table: one row per answered question, so the per-form
// answer arrays can sit in the model as a proper fact table. Identifying
// answers (name/email/phone-type or mapped to those) are blanked unless
// BI_INCLUDE_PII=true.
const ANSWER_PII_MAPPED = new Set(["name", "email", "phone", "date_of_birth"]);
const ANSWER_PII_TYPES = new Set(["email", "phone", "tel"]);
const ANSWER_PII_LABEL = /name|e-?mail|phone|mobile|nid|address|নাম|ফোন|মোবাইল|ইমেইল|ঠিকানা/i;

const buildAnswerRows = async () => {
  const [responses, fields] = await Promise.all([
    loadRaw("form_responses"),
    loadRaw("form_fields"),
  ]);
  const fieldsById = new Map(fields.rows.map((f) => [f.id, f]));
  const rows = [];

  responses.rows.forEach((response) => {
    (response.answers || []).forEach((answer) => {
      const field = fieldsById.get(answer.field_id) || {};
      const labelEn = answer.field_label_en || field.label_en || "";
      const labelBn = answer.field_label_bn || field.label_bn || "";
      const identifying =
        ANSWER_PII_MAPPED.has(field.mapped_participant_field) ||
        ANSWER_PII_TYPES.has(String(field.field_type || "").toLowerCase()) ||
        ANSWER_PII_LABEL.test(`${labelEn} ${labelBn}`);
      const raw = Array.isArray(answer.value) ? answer.value.join(", ") : answer.value;

      rows.push({
        response_id: response.id,
        form_id: response.form_id || "",
        participant_id: response.participant_id || "",
        field_id: answer.field_id || "",
        field_label_en: labelEn,
        field_label_bn: labelBn,
        field_type: field.field_type || "",
        mapped_participant_field: field.mapped_participant_field || "",
        data_point_id: field.data_point_id || "",
        value: !INCLUDE_PII && identifying ? "" : raw ?? "",
      });
    });
  });

  return { loadedAt: Math.min(responses.loadedAt, fields.loadedAt), rows };
};

router.get("/raw", (req, res) => {
  res.json({
    collections: [...RAW_COLLECTIONS, "form_response_answers"],
    pii_included: INCLUDE_PII,
    usage: "GET /api/bi/raw/<collection>?format=csv|json",
  });
});

router.get("/raw/:collection", async (req, res) => {
  const { collection } = req.params;

  try {
    let loaded;

    if (collection === "form_response_answers") {
      loaded = await buildAnswerRows();
    } else if (RAW_COLLECTIONS.includes(collection)) {
      const base = await loadRaw(collection);
      const drop = INCLUDE_PII ? [] : DROP_WHEN_STRIPPED[collection] || [];

      loaded = {
        loadedAt: base.loadedAt,
        rows: drop.length
          ? base.rows.map((row) => {
              const copy = { ...row };
              drop.forEach((key) => delete copy[key]);
              return copy;
            })
          : base.rows,
      };
    } else {
      return res.status(404).json({
        error: `Unknown collection "${collection}".`,
        available: [...RAW_COLLECTIONS, "form_response_answers"],
      });
    }

    res.set("Cache-Control", "no-store");
    res.set("X-Data-Loaded-At", new Date(loaded.loadedAt).toISOString());

    if (req.query.format === "json") return res.json(loaded.rows);

    // CSV: nested objects/arrays become JSON text columns, which Power
    // Query can expand with "Parse > JSON".
    const flat = loaded.rows.map((row) => {
      const out = {};
      Object.entries(row).forEach(([key, v]) => {
        out[key] = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      return out;
    });

    res.type("text/csv; charset=utf-8");
    return res.send(toCsv(flat));
  } catch (err) {
    console.error("BI raw feed failed:", err);
    return res.status(500).json({ error: "Failed to build raw feed." });
  }
});

router.get("/", (req, res) => {
  res.json({
    curated_tables: ["cohorts", "participants", "fgds", "evaluations", "champions"],
    raw: "GET /api/bi/raw for the per-collection feed",
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
