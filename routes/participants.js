import { Router } from "express";
import { auth as adminAuth } from "../firebaseAdmin.js";
import { requireAuth, loadCallerProfile, requireSuperAdmin } from "../middleware/auth.js";

const router = Router();

const MAX_IDS_PER_CALL = 200;

// Participants get no Auth account at registration, but the "Login as"
// impersonation flow (routes/impersonation.js) lazily auto-provisions one on
// first sign-in via a custom token minted with the participant doc ID as the
// UID. A Firestore-only delete leaves that account dangling, and only the
// Admin SDK can remove it — this is the one piece of a participant hard
// delete that can't be a pure client-side Firestore batch.
router.post(
  "/bulk-delete-auth",
  requireAuth,
  loadCallerProfile,
  requireSuperAdmin,
  async (req, res) => {
    const { participantIds } = req.body || {};

    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({ error: "participantIds must be a non-empty array." });
    }

    if (participantIds.length > MAX_IDS_PER_CALL) {
      return res
        .status(400)
        .json({ error: `A maximum of ${MAX_IDS_PER_CALL} participant IDs can be processed per call.` });
    }

    let deletedAuthUsers = 0;

    for (const id of participantIds) {
      try {
        await adminAuth.deleteUser(id);
        deletedAuthUsers += 1;
      } catch (err) {
        // A never-impersonated participant has no Auth account at all — this
        // is the expected outcome for most of them, not an error.
        if (err.code !== "auth/user-not-found") {
          console.error(`Failed to delete auth user ${id}:`, err);
        }
      }
    }

    return res.status(200).json({ deletedAuthUsers });
  }
);

export default router;
