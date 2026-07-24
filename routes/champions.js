import { Router } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { auth as adminAuth, db } from "../firebaseAdmin.js";
import { COLLECTIONS } from "../constants/collections.js";
import {
  ACCOUNT_STATUS,
  CHAMPION_ROLE_OPTIONS,
  MEMBER_STATUS,
  REGISTRATION_STATUS,
} from "../constants/champions.js";
import { loadCallerProfile, requireAuth, requirePermission } from "../middleware/auth.js";
import { sendChampionActivationEmail } from "../email.js";
import { createActivationToken, hashToken } from "../tokens.js";

const router = Router();

const CHAMPIONS_COUNTER_DOC = "champions_pool";

async function nextChampionCode(transaction) {
  const counterRef = db.collection(COLLECTIONS.COUNTERS).doc(CHAMPIONS_COUNTER_DOC);
  const counterSnap = await transaction.get(counterRef);

  let current = 0;

  if (counterSnap.exists) {
    current = Number(counterSnap.data().value) || 0;
  } else {
    // First run: self-seed from any pre-existing champion_code values so
    // this doesn't collide if the collection already has documents.
    const lastSnap = await transaction.get(
      db
        .collection(COLLECTIONS.CHAMPIONS_POOL)
        .orderBy("champion_code", "desc")
        .limit(1)
    );

    const lastCode = lastSnap.docs[0]?.data()?.champion_code;
    const match = lastCode?.match(/(\d+)$/);
    current = match ? Number(match[1]) : 0;
  }

  const nextNumber = current + 1;
  transaction.set(counterRef, { value: nextNumber }, { merge: true });

  return `ANN-CH-${String(nextNumber).padStart(4, "0")}`;
}

router.post("/register", async (req, res) => {
  const { email, name, phone, date_of_birth, institution, address } = req.body || {};

  if (!email || !name || !phone || !institution || !address) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const champion = await db.runTransaction(async (transaction) => {
      const championCode = await nextChampionCode(transaction);
      const championRef = db.collection(COLLECTIONS.CHAMPIONS_POOL).doc();
      const now = FieldValue.serverTimestamp();

      const data = {
        champion_code: championCode,
        firebase_uid: "",
        role: "",
        registration_status: REGISTRATION_STATUS.PENDING,
        account_status: ACCOUNT_STATUS.NOT_CREATED,
        invitation_sent_at: null,
        password_set_at: null,
        activated_at: null,
        member_status: MEMBER_STATUS.INACTIVE,
        name: String(name).trim(),
        email: normalizedEmail,
        phone: String(phone).trim(),
        date_of_birth: date_of_birth || "",
        institution: String(institution).trim(),
        address: String(address).trim(),
        photo_url: "",
        joined_at: null,
        last_login_at: null,
        assigned_fgd_ids: [],
        assigned_fgd_count: 0,
        total_evaluated_participants: 0,
        created_at: now,
        updated_at: now,
      };

      transaction.set(championRef, data);

      return { id: championRef.id, champion_code: championCode };
    });

    return res.status(201).json(champion);
  } catch (err) {
    console.error("Champion registration failed:", err);
    return res.status(500).json({ error: "Failed to register." });
  }
});

router.post(
  "/:id/approve",
  requireAuth,
  loadCallerProfile,
  requirePermission("selection"),
  async (req, res) => {
    const { id } = req.params;
    const { role } = req.body || {};

    if (!role || !CHAMPION_ROLE_OPTIONS.includes(role)) {
      return res.status(400).json({
        error: `role is required and must be one of: ${CHAMPION_ROLE_OPTIONS.join(", ")}`,
      });
    }

    try {
      const championRef = db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(id);
      const snap = await championRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Champion not found." });
      }

      await championRef.update({
        registration_status: REGISTRATION_STATUS.APPROVED,
        role,
        approved_by: req.callerProfile.email,
        approved_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Approve champion failed:", err);
      return res.status(500).json({ error: "Failed to approve champion." });
    }
  }
);

router.post(
  "/:id/reject",
  requireAuth,
  loadCallerProfile,
  requirePermission("selection"),
  async (req, res) => {
    const { id } = req.params;
    const { rejectionReason } = req.body || {};

    if (!rejectionReason) {
      return res.status(400).json({ error: "rejectionReason is required." });
    }

    try {
      const championRef = db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(id);
      const snap = await championRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Champion not found." });
      }

      await championRef.update({
        registration_status: REGISTRATION_STATUS.REJECTED,
        rejected_by: req.callerProfile.email,
        rejected_at: FieldValue.serverTimestamp(),
        rejection_reason: rejectionReason,
        updated_at: FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Reject champion failed:", err);
      return res.status(500).json({ error: "Failed to reject champion." });
    }
  }
);

router.post(
  "/:id/create-account",
  requireAuth,
  loadCallerProfile,
  requirePermission("selection"),
  async (req, res) => {
    const { id } = req.params;

    try {
      const championRef = db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(id);
      const snap = await championRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Champion not found." });
      }

      const champion = snap.data();

      if (champion.registration_status !== REGISTRATION_STATUS.APPROVED) {
        return res
          .status(400)
          .json({ error: "Champion must be approved before creating an account." });
      }

      // uid is set to the Firestore doc id on purpose: firestore.rules
      // looks up champions_pool/{request.auth.uid} to recognize an active
      // champion, so the Auth UID and the Firestore doc ID must match.
      let userRecord;

      try {
        userRecord = await adminAuth.getUser(id);
      } catch {
        userRecord = await adminAuth.createUser({
          uid: id,
          email: champion.email,
          emailVerified: false,
          disabled: false,
        });
      }

      // The account has no usable password yet — it only gets one once the
      // champion submits the activation form below. The emailed link points
      // to our own activation page (a plain GET, safe for link-scanners to
      // pre-visit) rather than a Firebase single-use action link, so an
      // automated scanner can't burn the token before the real user clicks.
      const { rawToken, tokenHash, expiresAt } = createActivationToken();

      await championRef.update({
        firebase_uid: userRecord.uid,
        account_status: ACCOUNT_STATUS.INVITATION_SENT,
        invitation_sent_at: FieldValue.serverTimestamp(),
        activation_token_hash: tokenHash,
        activation_token_expires_at: Timestamp.fromDate(expiresAt),
        updated_at: FieldValue.serverTimestamp(),
      });

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      const activationUrl = `${frontendUrl}/champions/activate?id=${id}&token=${rawToken}`;

      await sendChampionActivationEmail({
        to: champion.email,
        name: champion.name,
        activationUrl,
      });

      return res.status(200).json({ success: true, uid: userRecord.uid, email: champion.email });
    } catch (err) {
      console.error("Create champion account failed:", err);
      return res.status(500).json({ error: "Failed to create account." });
    }
  }
);

router.post("/:id/activate", async (req, res) => {
  const { id } = req.params;
  const { token, password } = req.body || {};

  if (!token || !password) {
    return res.status(400).json({ error: "token and password are required." });
  }

  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  try {
    const championRef = db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(id);
    const snap = await championRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Champion not found." });
    }

    const champion = snap.data();
    const expiresAt = champion.activation_token_expires_at?.toDate?.();

    const isValid =
      champion.activation_token_hash &&
      champion.activation_token_hash === hashToken(token) &&
      expiresAt &&
      expiresAt.getTime() > Date.now();

    if (!isValid) {
      return res.status(400).json({
        error:
          "This activation link is invalid or has expired. Ask an admin to resend your invitation.",
      });
    }

    await adminAuth.updateUser(id, { password: String(password), emailVerified: true });

    await championRef.update({
      account_status: ACCOUNT_STATUS.PASSWORD_SET,
      password_set_at: FieldValue.serverTimestamp(),
      activation_token_hash: FieldValue.delete(),
      activation_token_expires_at: FieldValue.delete(),
      updated_at: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Activate champion account failed:", err);
    return res.status(500).json({ error: "Failed to activate account." });
  }
});

router.post(
  "/:id/activate-member",
  requireAuth,
  loadCallerProfile,
  requirePermission("selection"),
  async (req, res) => {
    const { id } = req.params;

    try {
      const championRef = db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(id);
      const snap = await championRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Champion not found." });
      }

      const champion = snap.data();

      if (champion.account_status !== ACCOUNT_STATUS.PASSWORD_SET) {
        return res
          .status(400)
          .json({ error: "Champion must set their password before activation." });
      }

      await championRef.update({
        member_status: MEMBER_STATUS.ACTIVE,
        account_status: ACCOUNT_STATUS.ACTIVE,
        activated_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Activate champion failed:", err);
      return res.status(500).json({ error: "Failed to activate champion." });
    }
  }
);

export default router;
