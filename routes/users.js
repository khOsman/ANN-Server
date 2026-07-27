import { Router } from "express";
import { db } from "../firebaseAdmin.js";
import { COLLECTIONS } from "../constants/collections.js";
import { requireAuth, loadCallerProfile, requirePermission } from "../middleware/auth.js";
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

export default router;
