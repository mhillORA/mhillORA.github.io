/**
 * Outbound survey email — webhook first, else caller falls back to mailto UX.
 * Never put site PHI / patient data in subject or body templates.
 */

async function deliverSurveyEmail({ to, subject, text, html, meta }) {
    const recipient = String(to || '').trim();
    if (!recipient || !recipient.includes('@')) {
        return { ok: false, mode: 'none', error: 'missing_recipient' };
    }

    const webhook = process.env.SURVEY_EMAIL_WEBHOOK || process.env.SURVEY_NOTIFY_WEBHOOK;
    if (webhook) {
        try {
            const res = await fetch(webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'site_survey_invite',
                    to: recipient,
                    subject,
                    text,
                    html: html || undefined,
                    meta: meta || undefined,
                }),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return {
                    ok: false,
                    mode: 'webhook',
                    error: `webhook_${res.status}`,
                    detail: body.slice(0, 300),
                };
            }
            return { ok: true, mode: 'webhook' };
        } catch (e) {
            return { ok: false, mode: 'webhook', error: e.message || 'webhook_failed' };
        }
    }

    // No provider configured — ops UI will offer mailto / copy.
    return { ok: false, mode: 'manual', error: 'no_email_provider' };
}

function inviteEmailCopy({ siteName, roleLabel, inviteUrl, expiresAt }) {
    const subject = 'ORA site survey — action requested';
    const expiryLine = expiresAt
        ? `\nThis link expires on ${new Date(expiresAt).toLocaleDateString()}.\n`
        : '\n';
    const text =
        `Hello,\n\n` +
        `Please complete the ${roleLabel} site survey for ${siteName || 'your site'} using this secure link:\n\n` +
        `${inviteUrl}\n` +
        expiryLine +
        `\nDo not forward this link — it is unique to you.\n` +
        `\nThank you,\nORA Clinical Operations\n`;
    return { subject, text };
}

function opsNotifyCopy({ siteName, surveyTitle, roleLabel, status }) {
    const subject = `Site survey ${status}: ${siteName || 'site'}`;
    const text =
        `A site survey was ${status}.\n\n` +
        `Site: ${siteName || '—'}\n` +
        `Survey: ${surveyTitle || '—'}\n` +
        `Role: ${roleLabel || '—'}\n` +
        `\nOpen ARTEMIS → Comms / Reporting to review.\n`;
    return { subject, text };
}

module.exports = {
    deliverSurveyEmail,
    inviteEmailCopy,
    opsNotifyCopy,
};
