import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin.js";
import { COLLECTIONS } from "../constants/collections.js";
import { requireAuth, requireActiveChampion } from "../middleware/auth.js";
import {
  FEEDBACK_OPTIONS,
  RECOMMENDATION_OPTIONS,
  REQUIRED_EVALUATIONS,
  computeEvaluatorScore,
  deriveSelectionStatus,
} from "../constants/evaluation.js";
import { GENDER_OPTIONS, EDUCATION_LEVEL_OPTIONS } from "../constants/champions.js";

const router = Router();

const ATTENDANCE_OPTIONS = ["Pending", "Present", "Absent"];

const PROFILE_TEXT_FIELDS = [
  "name",
  "phone",
  "date_of_birth",
  "address",
  "photo_url",
  "education_institution",
  "field_of_study",
  "current_organization",
  "designation",
  "linkedin_url",
];

router.use(requireAuth, requireActiveChampion);

router.patch("/profile", async (req, res) => {
  const body = req.body || {};
  const updates = { updated_at: FieldValue.serverTimestamp() };

  for (const field of PROFILE_TEXT_FIELDS) {
    if (body[field] !== undefined) {
      updates[field] = String(body[field]).trim();
    }
  }

  if (body.gender !== undefined) {
    if (body.gender !== "" && !GENDER_OPTIONS.includes(body.gender)) {
      return res.status(400).json({
        error: `gender must be one of: ${GENDER_OPTIONS.join(", ")}`,
      });
    }
    updates.gender = body.gender;
  }

  if (body.education_level !== undefined) {
    if (
      body.education_level !== "" &&
      !EDUCATION_LEVEL_OPTIONS.includes(body.education_level)
    ) {
      return res.status(400).json({
        error: `education_level must be one of: ${EDUCATION_LEVEL_OPTIONS.join(", ")}`,
      });
    }
    updates.education_level = body.education_level;
  }

  if (body.graduation_year !== undefined) {
    if (body.graduation_year === "") {
      updates.graduation_year = "";
    } else {
      const year = Number(body.graduation_year);
      const currentYear = new Date().getFullYear();

      if (!Number.isInteger(year) || year < 1950 || year > currentYear + 1) {
        return res.status(400).json({
          error: `graduation_year must be a year between 1950 and ${currentYear + 1}.`,
        });
      }
      updates.graduation_year = year;
    }
  }

  if (body.years_of_experience !== undefined) {
    if (body.years_of_experience === "") {
      updates.years_of_experience = "";
    } else {
      const years = Number(body.years_of_experience);

      if (Number.isNaN(years) || years < 0 || years > 60) {
        return res.status(400).json({
          error: "years_of_experience must be a number between 0 and 60.",
        });
      }
      updates.years_of_experience = years;
    }
  }

  try {
    await db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(req.champion.id).update(updates);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Update champion profile failed:", err);
    return res.status(500).json({ error: "Failed to update profile." });
  }
});

router.post("/fgds/:fgdId/request-change", async (req, res) => {
  const { fgdId } = req.params;
  const { reason } = req.body || {};

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: "reason is required." });
  }

  const assignment = (req.champion.assigned_fgds || []).find(
    (item) => item.fgd_id === fgdId
  );

  if (!assignment) {
    return res.status(403).json({ error: "You are not assigned to this FGD." });
  }

  try {
    const requestRef = db.collection(COLLECTIONS.FGD_CHANGE_REQUESTS).doc();

    await requestRef.set({
      champion_id: req.champion.id,
      champion_name: req.champion.name || "",
      fgd_id: fgdId,
      fgd_code: assignment.fgd_code || "",
      reason: String(reason).trim(),
      status: "Pending",
      requested_at: FieldValue.serverTimestamp(),
      resolved_at: null,
      resolved_by: "",
    });

    return res.status(201).json({ success: true, id: requestRef.id });
  } catch (err) {
    console.error("Create FGD change request failed:", err);
    return res.status(500).json({ error: "Failed to submit request." });
  }
});

router.post("/participants/:participantId/attendance", async (req, res) => {
  const { participantId } = req.params;
  const { status } = req.body || {};

  if (!status || !ATTENDANCE_OPTIONS.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${ATTENDANCE_OPTIONS.join(", ")}`,
    });
  }

  try {
    const participantRef = db.collection(COLLECTIONS.PARTICIPANTS).doc(participantId);
    const snap = await participantRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Participant not found." });
    }

    const participant = snap.data();
    const assignedFgdIds = req.champion.assigned_fgd_ids || [];

    if (!participant.fgd_id || !assignedFgdIds.includes(participant.fgd_id)) {
      return res
        .status(403)
        .json({ error: "You are not assigned to this participant's FGD." });
    }

    await participantRef.update({
      fgd_attendance_status: status,
      updated_at: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Mark attendance failed:", err);
    return res.status(500).json({ error: "Failed to mark attendance." });
  }
});

router.post("/participants/:participantId/evaluate", async (req, res) => {
  const { participantId } = req.params;
  const { fgd_score, feedback_option, recommendation_option, notes } = req.body || {};

  const feedback = FEEDBACK_OPTIONS[feedback_option];
  const recommendation = RECOMMENDATION_OPTIONS[recommendation_option];
  const score = Number(fgd_score);

  if (!feedback) {
    return res.status(400).json({
      error: `feedback_option must be one of: ${Object.keys(FEEDBACK_OPTIONS).join(", ")}`,
    });
  }

  if (!recommendation) {
    return res.status(400).json({
      error: `recommendation_option must be one of: ${Object.keys(
        RECOMMENDATION_OPTIONS
      ).join(", ")}`,
    });
  }

  if (
    fgd_score === undefined ||
    fgd_score === null ||
    Number.isNaN(score) ||
    score < 0 ||
    score > 10
  ) {
    return res.status(400).json({ error: "fgd_score must be a number between 0 and 10." });
  }

  try {
    const participantRef = db.collection(COLLECTIONS.PARTICIPANTS).doc(participantId);
    const participantSnap = await participantRef.get();

    if (!participantSnap.exists) {
      return res.status(404).json({ error: "Participant not found." });
    }

    const participant = participantSnap.data();
    const assignedFgdIds = req.champion.assigned_fgd_ids || [];

    if (!participant.fgd_id || !assignedFgdIds.includes(participant.fgd_id)) {
      return res
        .status(403)
        .json({ error: "You are not assigned to this participant's FGD." });
    }

    const computedScore = computeEvaluatorScore({
      fgdScore: score,
      feedbackWeight: feedback.weight,
      recommendationWeight: recommendation.weight,
    });

    const evaluationRef = db
      .collection(COLLECTIONS.PARTICIPANT_EVALUATIONS)
      .doc(`${participantId}_${req.champion.id}`);

    const existingSnap = await evaluationRef.get();
    const now = FieldValue.serverTimestamp();

    await evaluationRef.set({
      participant_id: participantId,
      fgd_id: participant.fgd_id,
      champion_id: req.champion.id,
      evaluator_name: req.champion.name || "",
      fgd_score: score,
      feedback_option,
      feedback_weight: feedback.weight,
      recommendation_option,
      recommendation_weight: recommendation.weight,
      computed_score: computedScore,
      notes: notes ? String(notes).trim() : "",
      created_at: existingSnap.exists ? existingSnap.data().created_at : now,
      updated_at: now,
    });

    // Recomputed from all evaluator docs (not just this one) so the
    // participant's aggregate stays correct regardless of update order.
    const allEvaluationsSnap = await db
      .collection(COLLECTIONS.PARTICIPANT_EVALUATIONS)
      .where("participant_id", "==", participantId)
      .get();

    const scores = allEvaluationsSnap.docs.map((doc) => doc.data().computed_score);
    const evaluationCount = scores.length;
    const averageScore = scores.reduce((sum, value) => sum + value, 0) / evaluationCount;

    const participantUpdates = {
      evaluation_count: evaluationCount,
      average_evaluation_score: averageScore,
      updated_at: FieldValue.serverTimestamp(),
    };

    // Auto-set only once the 3rd evaluation lands — admins can still edit
    // selection_status manually afterward.
    if (evaluationCount >= REQUIRED_EVALUATIONS) {
      participantUpdates.selection_status = deriveSelectionStatus(averageScore);
    }

    await participantRef.update(participantUpdates);

    return res.status(200).json({
      success: true,
      evaluation_count: evaluationCount,
      average_evaluation_score: averageScore,
    });
  } catch (err) {
    console.error("Submit evaluation failed:", err);
    return res.status(500).json({ error: "Failed to submit evaluation." });
  }
});

export default router;
