import { randomBytes, createHash } from "node:crypto";

const ACTIVATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createActivationToken() {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + ACTIVATION_TOKEN_TTL_MS);

  return { rawToken, tokenHash, expiresAt };
}

export function hashToken(rawToken) {
  return createHash("sha256").update(String(rawToken)).digest("hex");
}
