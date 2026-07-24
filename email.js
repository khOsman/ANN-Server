const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

export async function sendCommitteeActivationEmail({ to, name, activationUrl }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "Amra Notun Network";

  if (!apiKey || !senderEmail) {
    throw new Error(
      "BREVO_API_KEY and BREVO_SENDER_EMAIL environment variables must be set."
    );
  }

  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to, name }],
      subject: "Activate your Amra Notun Network Selection Committee account",
      htmlContent: `
        <p>Hi ${name},</p>
        <p>Your Selection Committee registration has been approved. Click the button below to set your password and activate your account.</p>
        <p>
          <a href="${activationUrl}"
             style="background:#e6007e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">
            Activate my account
          </a>
        </p>
        <p>Or copy this link into your browser:<br/>${activationUrl}</p>
        <p>This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>
      `,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Brevo send failed (${response.status}): ${errorBody}`);
  }
}
