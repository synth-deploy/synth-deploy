interface Env {
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  NOTIFICATION_EMAIL: string;
  PIONEER_NOTIFICATION_EMAIL: string;
}

interface FormSubmission {
  formType: 'enterprise' | 'pioneer' | 'general';
  name: string;
  email: string;
  company?: string;
  role?: string;
  teamSize?: string;
  infrastructure?: string;
  environments?: string;
  tooling?: string;
  message?: string;
}

const ALLOWED_ORIGINS = [
  'https://synthdeploy.com',
  'https://www.synthdeploy.com',
  'http://localhost:4321',
];

function corsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function validateSubmission(data: unknown): { valid: true; submission: FormSubmission } | { valid: false; error: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid request body' };
  }

  const d = data as Record<string, unknown>;

  if (!d.formType || !['enterprise', 'pioneer', 'general'].includes(d.formType as string)) {
    return { valid: false, error: 'Invalid or missing formType' };
  }

  if (!d.name || typeof d.name !== 'string' || d.name.trim().length === 0) {
    return { valid: false, error: 'Name is required' };
  }

  if (!d.email || typeof d.email !== 'string' || !d.email.includes('@')) {
    return { valid: false, error: 'Valid email is required' };
  }

  const formType = d.formType as FormSubmission['formType'];

  if (formType === 'enterprise') {
    if (!d.company || typeof d.company !== 'string' || d.company.trim().length === 0) {
      return { valid: false, error: 'Company is required for enterprise inquiries' };
    }
  }

  if (formType === 'pioneer') {
    if (!d.company || typeof d.company !== 'string' || d.company.trim().length === 0) {
      return { valid: false, error: 'Company is required for Pioneer Program applications' };
    }
    if (!d.role || typeof d.role !== 'string' || d.role.trim().length === 0) {
      return { valid: false, error: 'Role/Title is required for Pioneer Program applications' };
    }
  }

  if (formType === 'general') {
    if (!d.message || typeof d.message !== 'string' || d.message.trim().length === 0) {
      return { valid: false, error: 'Message is required' };
    }
  }

  return {
    valid: true,
    submission: {
      formType,
      name: (d.name as string).trim(),
      email: (d.email as string).trim(),
      company: d.company ? (d.company as string).trim() : undefined,
      role: d.role ? (d.role as string).trim() : undefined,
      teamSize: d.teamSize ? (d.teamSize as string).trim() : undefined,
      infrastructure: d.infrastructure ? (d.infrastructure as string).trim() : undefined,
      environments: d.environments ? (d.environments as string).trim() : undefined,
      tooling: d.tooling ? (d.tooling as string).trim() : undefined,
      message: d.message ? (d.message as string).trim() : undefined,
    },
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSubject(submission: FormSubmission): string {
  switch (submission.formType) {
    case 'enterprise':
      return `Enterprise Inquiry from ${submission.name} at ${submission.company}`;
    case 'pioneer':
      return `Pioneer Program Application from ${submission.name} at ${submission.company}`;
    case 'general':
      return `Contact Form Submission from ${submission.name}`;
  }
}

function buildNotificationHtml(submission: FormSubmission): string {
  const rows: string[] = [];

  const addRow = (label: string, value: string | undefined) => {
    if (value) {
      rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#9a9790;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:6px 12px;color:#e4e2de;">${escapeHtml(value)}</td></tr>`);
    }
  };

  addRow('Name', submission.name);
  addRow('Email', submission.email);
  addRow('Company', submission.company);
  addRow('Role', submission.role);
  addRow('Team Size', submission.teamSize);
  addRow('Current Tooling', submission.tooling);
  addRow('Infrastructure', submission.infrastructure);
  addRow('Environments', submission.environments);
  addRow('Message', submission.message);

  const typeLabel = submission.formType === 'enterprise' ? 'Enterprise Inquiry'
    : submission.formType === 'pioneer' ? 'Pioneer Program Application'
    : 'General Contact';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#1e2028;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
    <div style="margin-bottom:24px;">
      <span style="color:#6b8aff;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;">${escapeHtml(typeLabel)}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;background:#272a33;border:1px solid rgba(255,255,255,0.07);border-radius:8px;">
      ${rows.join('\n      ')}
    </table>
    <div style="margin-top:24px;color:#6a6660;font-size:12px;">
      Reply directly to this email to respond to ${escapeHtml(submission.email)}.
    </div>
  </div>
</body>
</html>`;
}

function buildConfirmationHtml(submission: FormSubmission): string {
  const typeMessage = submission.formType === 'enterprise'
    ? "We've received your enterprise licensing inquiry and will be in touch within 48 hours."
    : submission.formType === 'pioneer'
    ? "We've received your Pioneer Program application. We'll review it and get back to you within 48 hours."
    : "We've received your message and will get back to you within 48 hours.";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#1e2028;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
    <div style="margin-bottom:24px;">
      <span style="font-size:20px;font-weight:700;color:#e4e2de;">Synth</span>
    </div>
    <div style="background:#272a33;border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:24px;">
      <p style="color:#e4e2de;font-size:15px;margin:0 0 12px 0;">Hi ${escapeHtml(submission.name)},</p>
      <p style="color:#9a9790;font-size:14px;line-height:1.6;margin:0 0 16px 0;">
        ${typeMessage}
      </p>
      <p style="color:#9a9790;font-size:14px;line-height:1.6;margin:0;">
        In the meantime, feel free to check out the <a href="https://github.com/synth-deploy/synth" style="color:#6b8aff;text-decoration:none;">source on GitHub</a> or browse the <a href="https://synthdeploy.com/docs" style="color:#6b8aff;text-decoration:none;">documentation</a>.
      </p>
    </div>
    <div style="margin-top:24px;color:#6a6660;font-size:12px;">
      Synth &mdash; Deployment intelligence, embedded.
    </div>
  </div>
</body>
</html>`;
}

async function sendEmail(
  env: Env,
  to: string[],
  subject: string,
  html: string,
  replyTo?: string,
): Promise<boolean> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Synth <${env.FROM_EMAIL}>`,
      to,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  return response.ok;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const headers = corsHeaders(origin);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return Response.json(
        { success: false, error: 'Method not allowed' },
        { status: 405, headers },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: 'Invalid JSON' },
        { status: 400, headers },
      );
    }

    const validation = validateSubmission(body);
    if (!validation.valid) {
      return Response.json(
        { success: false, error: validation.error },
        { status: 400, headers },
      );
    }

    const submission = validation.submission;
    const subject = buildSubject(submission);

    // Determine notification recipient
    const notificationEmail = submission.formType === 'pioneer'
      ? env.PIONEER_NOTIFICATION_EMAIL
      : env.NOTIFICATION_EMAIL;

    // Send notification email to team
    const notificationSent = await sendEmail(
      env,
      [notificationEmail],
      subject,
      buildNotificationHtml(submission),
      submission.email,
    );

    if (!notificationSent) {
      return Response.json(
        { success: false, error: 'Failed to send notification' },
        { status: 500, headers },
      );
    }

    // Send confirmation email to submitter (best-effort, don't fail if this doesn't send)
    const confirmSubject = submission.formType === 'pioneer'
      ? 'Thanks for applying to the Synth Pioneer Program'
      : submission.formType === 'enterprise'
      ? 'Thanks for your Synth enterprise inquiry'
      : 'Thanks for contacting Synth';

    await sendEmail(
      env,
      [submission.email],
      confirmSubject,
      buildConfirmationHtml(submission),
    ).catch(() => {
      // Confirmation is best-effort
    });

    return Response.json({ success: true }, { status: 200, headers });
  },
};
