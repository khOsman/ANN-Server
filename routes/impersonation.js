import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { auth as adminAuth, db } from "../firebaseAdmin.js";
import { COLLECTIONS } from "../constants/collections.js";
import { requireAuth, loadCallerProfile, requireAdmin } from "../middleware/auth.js";

const router = Router();

const CODE_TTL_MS = 60 * 1000; // one-time code must be redeemed within 60s

const TARGET_TYPES = ["user", "champion", "participant"];

const TARGET_COLLECTIONS = {
  champion: COLLECTIONS.CHAMPIONS_POOL,
  participant: COLLECTIONS.PARTICIPANTS,
  user: COLLECTIONS.USERS,
};

async function loadTarget(targetType, targetId) {
  const snap = await db.collection(TARGET_COLLECTIONS[targetType]).doc(targetId).get();

  if (!snap.exists) return null;

  return { id: snap.id, ...snap.data() };
}

function isTargetActive(targetType, target) {
  if (targetType === "champion") {
    return target.member_status === "Active" && target.account_status === "Active";
  }

  if (targetType === "participant") {
    // Participants have no separate account-activation lifecycle (unlike
    // users/champions) — existing as a participant record is enough.
    return true;
  }

  return target.status === "active";
}

// Starts an impersonation session — called by the admin, from their own
// authenticated session. Returns a short-lived one-time code (not the
// actual token) that the new tab exchanges via /redeem below.
router.post("/start", requireAuth, loadCallerProfile, requireAdmin, async (req, res) => {
  const { targetType, targetId } = req.body || {};

  if (!TARGET_TYPES.includes(targetType) || !targetId) {
    return res.status(400).json({
      error: `targetType must be one of: ${TARGET_TYPES.join(", ")}, and targetId is required.`,
    });
  }

  try {
    const target = await loadTarget(targetType, targetId);

    if (!target) {
      return res.status(404).json({ error: "Target account not found." });
    }

    if (!isTargetActive(targetType, target)) {
      return res.status(400).json({ error: "Only active accounts can be logged into." });
    }

    // A plain admin can impersonate anyone except a super admin — prevents
    // privilege escalation via someone else's identity. Super admins can
    // impersonate anyone.
    if (
      targetType === "user" &&
      target.role === "super_admin" &&
      req.callerProfile.role !== "super_admin"
    ) {
      return res
        .status(403)
        .json({ error: "Only a super admin can log in as another super admin." });
    }

    const code = crypto.randomUUID();

    await db.collection(COLLECTIONS.IMPERSONATION_SESSIONS).doc(code).set({
      target_id: targetId,
      target_type: targetType,
      created_by: req.callerProfile.uid,
      created_by_name: req.callerProfile.name || req.callerProfile.email,
      created_by_email: req.callerProfile.email,
      created_at: FieldValue.serverTimestamp(),
      expires_at: Date.now() + CODE_TTL_MS,
      used: false,
      redeemed_at: null,
    });

    return res.status(200).json({ code });
  } catch (err) {
    console.error("Start impersonation failed:", err);
    return res.status(500).json({ error: "Failed to start impersonation session." });
  }
});

// Redeemed by the freshly opened tab, which isn't signed in yet — no auth
// middleware here. Security relies on the code being a single-use, 60s-TTL
// random UUID rather than a caller identity check.
router.post("/redeem", async (req, res) => {
  const { code } = req.body || {};

  if (!code) {
    return res.status(400).json({ error: "code is required." });
  }

  try {
    const sessionRef = db.collection(COLLECTIONS.IMPERSONATION_SESSIONS).doc(code);

    const session = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(sessionRef);

      if (!snap.exists) return null;

      const data = snap.data();

      if (data.used || Date.now() > data.expires_at) return null;

      transaction.update(sessionRef, {
        used: true,
        redeemed_at: FieldValue.serverTimestamp(),
      });

      return data;
    });

    if (!session) {
      return res.status(410).json({ error: "This session link has expired or was already used." });
    }

    const target = await loadTarget(session.target_type, session.target_id);

    if (!target || !isTargetActive(session.target_type, target)) {
      return res.status(403).json({ error: "This account is no longer active." });
    }

    const customToken = await adminAuth.createCustomToken(session.target_id, {
      impersonated: true,
      impersonated_by: session.created_by,
    });

    return res.status(200).json({
      customToken,
      targetType: session.target_type,
      targetName: target.name || target.email || "",
      adminName: session.created_by_name || session.created_by_email || "",
    });
  } catch (err) {
    console.error("Redeem impersonation failed:", err);
    return res.status(500).json({ error: "Failed to redeem session link." });
  }
});

export default router;
