import { Router } from "express";
import { auth as adminAuth, db } from "../firebaseAdmin.js";
import { COLLECTIONS } from "../constants/collections.js";
import {
  requireAuth,
  loadCallerProfile,
  requirePermission,
  requireSuperAdmin,
} from "../middleware/auth.js";
import { sendUserAccessUpdateEmail } from "../email.js";

const router = Router();

router.use(requireAuth, loadCallerProfile, requirePermission("users"));

router.post("/:id/notify-access", async (req, res) => {
  const { id } = req.params;

  try {
    const snap = await db.collection(COLLECTIONS.USERS).doc(id).get();

    if (!snap.exists) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = snap.data();

    if (!user.email) {
      return res.status(400).json({ error: "This user has no email on file." });
    }

    await sendUserAccessUpdateEmail({
      to: user.email,
      name: user.name || user.email,
      role: user.role,
      permissions: user.permissions || {},
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Send user access update email failed:", err);
    return res.status(500).json({ error: "Failed to send notification email." });
  }
});

router.delete("/:id", requireSuperAdmin, async (req, res) => {
  const { id } = req.params;

  if (id === req.callerProfile.uid) {
    return res.status(400).json({ error: "You cannot delete your own account." });
  }

  try {
    const userRef = db.collection(COLLECTIONS.USERS).doc(id);
    const snap = await userRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "User not found." });
    }

    // The Firestore doc ID is always the Firebase Auth uid for this
    // collection (see AuthContext.jsx, which creates the doc with the
    // signed-in user's own uid) — no separate uid field to look up.
    try {
      await adminAuth.deleteUser(id);
    } catch (err) {
      if (err.code !== "auth/user-not-found") {
        console.error("Failed to delete user's Auth account:", err);
        return res.status(500).json({
          error: "Failed to delete the associated login account. Try again.",
        });
      }
    }

    await userRef.delete();

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Delete user failed:", err);
    return res.status(500).json({ error: "Failed to delete user." });
  }
});

export default router;
