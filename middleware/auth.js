import { auth as adminAuth, db } from "../firebaseAdmin.js";
import { COLLECTIONS } from "../constants/collections.js";

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing bearer token." });
  }

  try {
    req.authUser = await adminAuth.verifyIdToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

export async function loadCallerProfile(req, res, next) {
  const email = req.authUser?.email || "";

  if (!email.endsWith("@brac.net")) {
    return res
      .status(403)
      .json({ error: "Access restricted to BRAC staff accounts." });
  }

  try {
    const snap = await db
      .collection(COLLECTIONS.USERS)
      .doc(req.authUser.uid)
      .get();

    if (!snap.exists) {
      return res.status(403).json({ error: "No user profile found." });
    }

    const profile = snap.data();

    if (profile.status !== "active") {
      return res.status(403).json({ error: "Account is not active." });
    }

    req.callerProfile = { uid: req.authUser.uid, email, ...profile };
    return next();
  } catch (err) {
    console.error("Failed to load caller profile:", err);
    return res.status(500).json({ error: "Failed to verify caller." });
  }
}

export function requirePermission(permissionKey) {
  return (req, res, next) => {
    const profile = req.callerProfile;

    if (!profile) {
      return res.status(403).json({ error: "Caller profile not loaded." });
    }

    const isSuperAdmin = profile.role === "super_admin";
    const hasPermission = profile.permissions?.[permissionKey] === true;

    if (!isSuperAdmin && !hasPermission) {
      return res
        .status(403)
        .json({ error: `Missing required permission: ${permissionKey}` });
    }

    return next();
  };
}

export function requireAnyPermission(permissionKeys) {
  return (req, res, next) => {
    const profile = req.callerProfile;

    if (!profile) {
      return res.status(403).json({ error: "Caller profile not loaded." });
    }

    const isSuperAdmin = profile.role === "super_admin";
    const hasAny = permissionKeys.some((key) => profile.permissions?.[key] === true);

    if (!isSuperAdmin && !hasAny) {
      return res.status(403).json({
        error: `Missing required permission: one of ${permissionKeys.join(", ")}`,
      });
    }

    return next();
  };
}

export function requireAdmin(req, res, next) {
  const role = req.callerProfile?.role;

  if (role !== "admin" && role !== "super_admin") {
    return res.status(403).json({ error: "Only an admin or super admin can perform this action." });
  }

  return next();
}

export function requireSuperAdmin(req, res, next) {
  if (req.callerProfile?.role !== "super_admin") {
    return res.status(403).json({ error: "Only a super admin can perform this action." });
  }

  return next();
}

export async function requireActiveChampion(req, res, next) {
  const uid = req.authUser?.uid;

  if (!uid) {
    return res.status(401).json({ error: "Missing authenticated user." });
  }

  try {
    const snap = await db.collection(COLLECTIONS.CHAMPIONS_POOL).doc(uid).get();

    if (!snap.exists) {
      return res.status(403).json({ error: "No champion profile found." });
    }

    const champion = snap.data();

    if (champion.member_status !== "Active" || champion.account_status !== "Active") {
      return res.status(403).json({ error: "Champion account is not active." });
    }

    req.champion = { id: snap.id, ...champion };
    return next();
  } catch (err) {
    console.error("Failed to load champion profile:", err);
    return res.status(500).json({ error: "Failed to verify champion." });
  }
}
