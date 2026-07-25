const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

// Admins sometimes paste links without a scheme (e.g. "meet.google.com/xxx").
// Left as-is in an <a href>, mail clients can resolve that as relative,
// producing a broken link instead of opening Google Meet directly.
function ensureHttpUrl(url) {
  if (!url) return url;

  const trimmed = String(url).trim();

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Stored as plain "HH:mm" (24-hour). Display-only conversion to 12-hour BDT.
function formatTime12h(time24) {
  if (!time24) return "";

  const [hourStr, minuteStr] = String(time24).split(":");
  const hour24 = parseInt(hourStr, 10);

  if (Number.isNaN(hour24)) return time24;

  const minute = (minuteStr || "00").padStart(2, "0");
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;

  return `${hour12}:${minute} ${period}`;
}

function formatTimeRangeBDT(startTime24, endTime24) {
  const start = formatTime12h(startTime24);
  const end = formatTime12h(endTime24);

  if (!start && !end) return "";

  const range = start && end ? `${start} - ${end}` : start || end;

  return `${range} BDT`;
}

async function sendViaBrevo({ to, name, subject, htmlContent }) {
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
      subject,
      htmlContent,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Brevo send failed (${response.status}): ${errorBody}`);
  }
}

export async function sendChampionActivationEmail({ to, name, activationUrl }) {
  await sendViaBrevo({
    to,
    name,
    subject: "Activate your Amra Notun Network account",
    htmlContent: `
      <p>Hi ${name},</p>
      <p>Your Amra Notun Network Champions Pool registration has been approved. Click the button below to set your password and activate your account.</p>
      <p>
        <a href="${activationUrl}"
           style="background:#e6007e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">
          Activate my account
        </a>
      </p>
      <p>Or copy this link into your browser:<br/>${activationUrl}</p>
      <p>This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>
    `,
  });
}

export async function sendFGDAssignmentEmail({ to, name, fgd }) {
  const timeRange = formatTimeRangeBDT(fgd.session_start_time, fgd.session_end_time);

  const scheduleLine = fgd.session_date
    ? `<p><strong>Date:</strong> ${fgd.session_date}${
        timeRange ? ` &nbsp; <strong>Time:</strong> ${timeRange}` : ""
      }</p>`
    : `<p><em>The exact schedule is still being finalized — you'll be notified once it's confirmed.</em></p>`;

  const venueLine = fgd.venue ? `<p><strong>Venue:</strong> ${fgd.venue}</p>` : "";

  const meetLine = fgd.meet_link
    ? `<p>
        <a href="${ensureHttpUrl(fgd.meet_link)}"
           style="background:#e6007e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">
          Join Google Meet
        </a>
      </p>
      <p>Or copy this link into your browser:<br/>${fgd.meet_link}</p>`
    : "";

  await sendViaBrevo({
    to,
    name,
    subject: `Your FGD Assignment — ${fgd.fgd_code || "Amra Notun Network"}`,
    htmlContent: `
      <p>Hi ${name},</p>
      <p>You have been assigned to the following Focused Group Discussion as a Selection Committee member:</p>
      <p><strong>FGD:</strong> ${fgd.fgd_code || "-"} (${fgd.cohort_name || "-"})</p>
      ${scheduleLine}
      ${venueLine}
      ${meetLine}
      <p>If you have any questions, please reach out to the ANN team.</p>
    `,
  });
}
