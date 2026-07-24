import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { auth as adminAuth, db } from "../firebaseAdmin.js";
import { COLLECTIONS } from "../constants/collections.js";
import {
  ACCOUNT_STATUS,
  MEMBER_STATUS,
  REGISTRATION_STATUS,
  SELECTION_COMMITTEE_ROLE,
} from "../constants/selectionCommittee.js";
import { loadCallerProfile, requireAuth, requirePermission } from "../middleware/auth.js";

const router = Router();

const COMMITTEE_COUNTER_DOC = "selection_committee_members";

async function nextCommitteeCode(transaction) {
  const counterRef = db.collection(COLLECTIONS.COUNTERS).doc(COMMITTEE_COUNTER_DOC);
  const counterSnap = await transaction.get(counterRef);

  let current = 0;

  if (counterSnap.exists) {
    current = Number(counterSnap.data().value) || 0;
  } else {
    // First run: self-seed from any pre-existing committee_code values so
    // migrating from the old client-side generator doesn't collide.
    const lastSnap = await transaction.get(
      db
        .collection(COLLECTIONS.SELECTION_COMMITTEE_MEMBERS)
        .orderBy("committee_code", "desc")
        .limit(1)
    );

    const lastCode = lastSnap.docs[0]?.data()?.committee_code;
    const match = lastCode?.match(/(\d+)$/);
    current = match ? Number(match[1]) : 0;
  }

  const nextNumber = current + 1;
  transaction.set(counterRef, { value: nextNumber }, { merge: true });

  return `ANN-SC-${String(nextNumber).padStart(4, "0")}`;
}

router.post("/register", async (req, res) => {
  const { email, name, phone, date_of_birth, institution, address } = req.body || {};

  if (!email || !name || !phone || !institution || !address) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const member = await db.runTransaction(async (transaction) => {
      const committeeCode = await nextCommitteeCode(transaction);
      const memberRef = db.collection(COLLECTIONS.SELECTION_COMMITTEE_MEMBERS).doc();
      const now = FieldValue.serverTimestamp();

      const data = {
        committee_code: committeeCode,
        firebase_uid: "",
        role: SELECTION_COMMITTEE_ROLE.MEMBER,
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

      transaction.set(memberRef, data);

      return { id: memberRef.id, committee_code: committeeCode };
    });

    return res.status(201).json(member);
  } catch (err) {
    console.error("Committee registration failed:", err);
    return res.status(500).json({ error: "Failed to register committee member." });
  }
});

router.post(
  "/:id/approve",
  requireAuth,
  loadCallerProfile,
  requirePermission("selection"),
  async (req, res) => {
    const { id } = req.params;

    try {
      const memberRef = db.collection(COLLECTIONS.SELECTION_COMMITTEE_MEMBERS).doc(id);
      const snap = await memberRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Committee member not found." });
      }

      await memberRef.update({
        registration_status: REGISTRATION_STATUS.APPROVED,
        approved_by: req.callerProfile.email,
        approved_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Approve committee member failed:", err);
      return res.status(500).json({ error: "Failed to approve committee member." });
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
      const memberRef = db.collection(COLLECTIONS.SELECTION_COMMITTEE_MEMBERS).doc(id);
      const snap = await memberRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Committee member not found." });
      }

      await memberRef.update({
        registration_status: REGISTRATION_STATUS.REJECTED,
        rejected_by: req.callerProfile.email,
        rejected_at: FieldValue.serverTimestamp(),
        rejection_reason: rejectionReason,
        updated_at: FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Reject committee member failed:", err);
      return res.status(500).json({ error: "Failed to reject committee member." });
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
      const memberRef = db.collection(COLLECTIONS.SELECTION_COMMITTEE_MEMBERS).doc(id);
      const snap = await memberRef.get();

      if (!snap.exists) {
        return res.status(404).json({ error: "Committee member not found." });
      }

      const member = snap.data();

      if (member.registration_status !== REGISTRATION_STATUS.APPROVED) {
        return res
          .status(400)
          .json({ error: "Member must be approved before creating an account." });
      }

      // uid is set to the Firestore doc id on purpose: firestore.rules
      // looks up selection_committee_members/{request.auth.uid} to
      // recognize an active committee member, so the Auth UID and the
      // Firestore doc ID must match.
      let userRecord;

      try {
        userRecord = await adminAuth.getUser(id);
      } catch {
        userRecord = await adminAuth.createUser({
          uid: id,
          email: member.email,
          emailVerified: false,
          disabled: false,
        });
      }

      await memberRef.update({
        firebase_uid: userRecord.uid,
        account_status: ACCOUNT_STATUS.INVITATION_SENT,
        invitation_sent_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true, uid: userRecord.uid, email: member.email });
    } catch (err) {
      console.error("Create committee account failed:", err);
      return res.status(500).json({ error: "Failed to create committee account." });
    }
  }
);

export default router;
