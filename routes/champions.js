import { Router } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { auth as adminAuth, db } from "../firebaseAdmin.js";
import { COLLECTIONS } from "../constants/collections.js";
import {
  ACCOUNT_STATUS,
  ACCOUNT_STATUS_OPTIONS,
  CHAMPION_ROLE_OPTIONS,
  MEMBER_STATUS,
  MEMBER_STATUS_OPTIONS,
  REGISTRATION_STATUS,
  REGISTRATION_STATUS_OPTIONS,
} from "../constants/champions.js";
import {
  loadCallerProfile,
  requireAuth,
  requirePermission,
  requireSuperAdmin,
} from "../middleware/auth.js";
import { sendChampionActivationEmail, sendFGDAssignmentEmail } from "../email.js";
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

router.patch(
  "/:id",
  requireAuth,
  loadCallerProfile,
  requireSuperAdmin,
  async (req, res) => {
    const { id } = req.params;
    const {
      name,
      email,
      phone,
      date_of_birth,
      institution,
      address,
      role,
      registration_status,
      account_status,
      member_status,
    } = req.body || {};

    if (role !== undefined && !CHAMPION_ROLE_OPTIONS.includes(role)) {
      return res.status(400).json({
        error: `role must be one of: ${CHAMPION_ROLE_OPTIONS.join(", ")}`,
      });
    }

    if (
      registration_status !== undefined &&
      !REGISTRATION_STATUS_OPTIONS.includes(registration_status)
    ) {
      return res.status(400).json({
        error: `registration_status must be one of: ${REGISTRATION_STATUS_OPTIONS.join(", ")}`,
      });
    }

    if (
      account_status !== undefined &&
      !ACCOUNT_STATUS_OPTIONS.includes(account_status)
    ) {
      return res.status(400).json({
        error: `account_status must be one of: ${ACCOUNT_STATUS_OPTIONS.join(", ")}`,
      });
    }

    if (
      member_status !== undefined &&
      !MEMBER_STATUS_OPTIONS.includes(member_status)
    ) {
      return res.status(400).json({
        error: `member_status must be one of: ${MEMBER_STATUS_OPTIONS.join(", ")}`,
      });
    }

    try {
      const championRef = db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(id);
      const snap = await championRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Champion not found." });
      }

      const champion = snap.data();
      const updates = { updated_at: FieldValue.serverTimestamp() };

      if (name !== undefined) updates.name = String(name).trim();
      if (phone !== undefined) updates.phone = String(phone).trim();
      if (date_of_birth !== undefined) updates.date_of_birth = date_of_birth;
      if (institution !== undefined) updates.institution = String(institution).trim();
      if (address !== undefined) updates.address = String(address).trim();
      if (role !== undefined) updates.role = role;
      if (registration_status !== undefined) updates.registration_status = registration_status;
      if (account_status !== undefined) updates.account_status = account_status;
      if (member_status !== undefined) updates.member_status = member_status;

      let normalizedEmail;

      if (email !== undefined) {
        normalizedEmail = String(email).trim().toLowerCase();
        updates.email = normalizedEmail;
      }

      // Sync the Firebase Auth record's email BEFORE writing Firestore, so a
      // rejected email change (e.g. already in use by another account)
      // doesn't leave Firestore ahead of what the champion can actually log
      // in with.
      if (normalizedEmail && champion.firebase_uid) {
        try {
          await adminAuth.updateUser(champion.firebase_uid, {
            email: normalizedEmail,
          });
        } catch (err) {
          console.error("Failed to sync Auth email:", err);
          return res.status(400).json({
            error: "Failed to update email on the account. It may already be in use.",
          });
        }
      }

      await championRef.update(updates);

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Update champion failed:", err);
      return res.status(500).json({ error: "Failed to update champion." });
    }
  }
);

router.post(
  "/:id/assign-fgd",
  requireAuth,
  loadCallerProfile,
  requirePermission("selection"),
  async (req, res) => {
    const { id } = req.params;
    const { fgdId } = req.body || {};

    if (!fgdId) {
      return res.status(400).json({ error: "fgdId is required." });
    }

    try {
      const championRef = db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(id);
      const fgdRef = db.collection(COLLECTIONS.FGDS).doc(fgdId);

      const [championSnap, fgdSnap] = await Promise.all([
        championRef.get(),
        fgdRef.get(),
      ]);

      if (!championSnap.exists) {
        return res.status(404).json({ error: "Champion not found." });
      }

      if (!fgdSnap.exists) {
        return res.status(404).json({ error: "FGD not found." });
      }

      const champion = championSnap.data();
      const fgd = fgdSnap.data();

      const assignedFgdsById = new Map(
        (champion.assigned_fgds || []).map((item) => [item.fgd_id, item])
      );

      assignedFgdsById.set(fgdId, {
        fgd_id: fgdId,
        fgd_code: fgd.fgd_code || "",
        fgd_name: fgd.fgd_name || "",
        cohort_name: fgd.cohort_name || "",
        session_date: fgd.session_date || "",
        session_start_time: fgd.session_start_time || "",
        session_end_time: fgd.session_end_time || "",
        venue: fgd.venue || "",
        meet_link: fgd.meet_link || "",
      });

      const assignedFgds = Array.from(assignedFgdsById.values());
      const assignedFgdIds = assignedFgds.map((item) => item.fgd_id);

      const committeeMembersById = new Map(
        (fgd.committee_members || []).map((item) => [item.champion_id, item])
      );

      committeeMembersById.set(id, {
        champion_id: id,
        name: champion.name || "",
        email: champion.email || "",
      });

      await Promise.all([
        championRef.update({
          assigned_fgd_ids: assignedFgdIds,
          assigned_fgds: assignedFgds,
          assigned_fgd_count: assignedFgdIds.length,
          updated_at: FieldValue.serverTimestamp(),
        }),
        fgdRef.update({
          committee_members: Array.from(committeeMembersById.values()),
          updated_at: FieldValue.serverTimestamp(),
        }),
      ]);

      await sendFGDAssignmentEmail({
        to: champion.email,
        name: champion.name,
        fgd: { ...fgd, id: fgdId },
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Assign champion to FGD failed:", err);
      return res.status(500).json({ error: "Failed to assign champion to FGD." });
    }
  }
);

router.post(
  "/:id/unassign-fgd",
  requireAuth,
  loadCallerProfile,
  requirePermission("selection"),
  async (req, res) => {
    const { id } = req.params;
    const { fgdId } = req.body || {};

    if (!fgdId) {
      return res.status(400).json({ error: "fgdId is required." });
    }

    try {
      const championRef = db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(id);
      const fgdRef = db.collection(COLLECTIONS.FGDS).doc(fgdId);

      const [championSnap, fgdSnap] = await Promise.all([
        championRef.get(),
        fgdRef.get(),
      ]);

      if (!championSnap.exists) {
        return res.status(404).json({ error: "Champion not found." });
      }

      const champion = championSnap.data();
      const assignedFgds = (champion.assigned_fgds || []).filter(
        (item) => item.fgd_id !== fgdId
      );

      await championRef.update({
        assigned_fgds: assignedFgds,
        assigned_fgd_ids: assignedFgds.map((item) => item.fgd_id),
        assigned_fgd_count: assignedFgds.length,
        updated_at: FieldValue.serverTimestamp(),
      });

      if (fgdSnap.exists) {
        const fgd = fgdSnap.data();

        await fgdRef.update({
          committee_members: (fgd.committee_members || []).filter(
            (item) => item.champion_id !== id
          ),
          updated_at: FieldValue.serverTimestamp(),
        });
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Unassign champion from FGD failed:", err);
      return res.status(500).json({ error: "Failed to unassign champion from FGD." });
    }
  }
);

router.post(
  "/fgd-change-requests/:id/resolve",
  requireAuth,
  loadCallerProfile,
  requirePermission("selection"),
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!["Approved", "Dismissed"].includes(status)) {
      return res
        .status(400)
        .json({ error: "status must be one of: Approved, Dismissed" });
    }

    try {
      const requestRef = db.collection(COLLECTIONS.FGD_CHANGE_REQUESTS).doc(id);
      const snap = await requestRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Request not found." });
      }

      await requestRef.update({
        status,
        resolved_at: FieldValue.serverTimestamp(),
        resolved_by: req.callerProfile.email,
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Resolve FGD change request failed:", err);
      return res.status(500).json({ error: "Failed to resolve request." });
    }
  }
);

export default router;
