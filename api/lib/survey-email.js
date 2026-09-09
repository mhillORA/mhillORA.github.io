/**
 * Outbound survey email.
 * Order: webhook → Microsoft Graph → SendGrid → manual (UI copy/mailto).
 * Never put site PHI / patient data beyond site name + role in subject/body.
 */

function readClientSecret() {
    return (
        process.env.AZURE_CLIENT_SECRET ||
        process.env.AZURE_CLIENT_SECRET_APP_SETTING_NAME ||
        process.env.MICROSOFT_PROVIDER_AUTHENTICATION_SECRET ||
        ''
    ).trim();
}

async function deliverViaWebhook({ to, subject, text, html, meta }) {
    const webhook = process.env.SURVEY_EMAIL_WEBHOOK || process.env.SURVEY_NOTIFY_WEBHOOK;
    if (!webhook) return null;

    try {
        const res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'site_survey_invite',
                to,
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

let cachedGraphToken = null;
let cachedGraphTokenExp = 0;

async function getGraphAppToken() {
    const now = Date.now();
    if (cachedGraphToken && cachedGraphTokenExp > now + 60_000) {
        return cachedGraphToken;
    }

    const tenant =
        process.env.AZURE_TENANT_ID ||
        process.env.AZURE_AD_TENANT_ID ||
        '2f298692-acc9-4632-b71b-841d51376914';
    const clientId = (process.env.AZURE_CLIENT_ID || '').trim();
    const clientSecret = readClientSecret();
    if (!clientId || !clientSecret) return null;

    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
    });

    const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
        const err = json.error_description || json.error || `token_${res.status}`;
        throw new Error(err);
    }
    cachedGraphToken = json.access_token;
    cachedGraphTokenExp = now + (Number(json.expires_in) || 3600) * 1000;
    return cachedGraphToken;
}

async function deliverViaGraph({ to, subject, text, html }) {
    const from = (process.env.SURVEY_EMAIL_FROM || process.env.SURVEY_MAIL_FROM || '').trim();
    if (!from) return null;

    try {
        const token = await getGraphAppToken();
        if (!token) {
            return {
                ok: false,
                mode: 'graph',
                error: 'missing_graph_credentials',
                detail: 'Set AZURE_CLIENT_ID + client secret app setting, and SURVEY_EMAIL_FROM.',
            };
        }

        const res = await fetch(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: {
                        subject,
                        body: {
                            contentType: html ? 'HTML' : 'Text',
                            content: html || text,
                        },
                        toRecipients: [{ emailAddress: { address: to } }],
                    },
                    saveToSentItems: true,
                }),
            }
        );

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return {
                ok: false,
                mode: 'graph',
                error: `graph_${res.status}`,
                detail: body.slice(0, 400),
            };
        }
        return { ok: true, mode: 'graph', from };
    } catch (e) {
        return { ok: false, mode: 'graph', error: e.message || 'graph_failed' };
    }
}

async function deliverViaSendGrid({ to, subject, text, html }) {
    const apiKey = (process.env.SENDGRID_API_KEY || '').trim();
    const from = (
        process.env.SURVEY_EMAIL_FROM ||
        process.env.SENDGRID_FROM_EMAIL ||
        process.env.SURVEY_MAIL_FROM ||
        ''
    ).trim();
    if (!apiKey || !from) return null;

    try {
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                personalizations: [{ to: [{ email: to }] }],
                from: { email: from, name: process.env.SURVEY_EMAIL_FROM_NAME || 'ORA Clinical ARTEMIS' },
                subject,
                content: [
                    { type: 'text/plain', value: text },
                    ...(html ? [{ type: 'text/html', value: html }] : []),
                ],
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return {
                ok: false,
                mode: 'sendgrid',
                error: `sendgrid_${res.status}`,
                detail: body.slice(0, 300),
            };
        }
        return { ok: true, mode: 'sendgrid', from };
    } catch (e) {
        return { ok: false, mode: 'sendgrid', error: e.message || 'sendgrid_failed' };
    }
}

async function deliverSurveyEmail({ to, subject, text, html, meta }) {
    const recipient = String(to || '').trim();
    if (!recipient || !recipient.includes('@')) {
        return { ok: false, mode: 'none', error: 'missing_recipient' };
    }

    const viaWebhook = await deliverViaWebhook({ to: recipient, subject, text, html, meta });
    if (viaWebhook) return viaWebhook;

    const viaGraph = await deliverViaGraph({ to: recipient, subject, text, html });
    if (viaGraph) return viaGraph;

    const viaSendGrid = await deliverViaSendGrid({ to: recipient, subject, text, html });
    if (viaSendGrid) return viaSendGrid;

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
    const html =
        `<p>Hello,</p>` +
        `<p>Please complete the <strong>${escapeHtml(roleLabel)}</strong> site survey for ` +
        `<strong>${escapeHtml(siteName || 'your site')}</strong> using this secure link:</p>` +
        `<p><a href="${escapeAttr(inviteUrl)}">${escapeHtml(inviteUrl)}</a></p>` +
        (expiresAt
            ? `<p>This link expires on ${escapeHtml(new Date(expiresAt).toLocaleDateString())}.</p>`
            : '') +
        `<p>Do not forward this link — it is unique to you.</p>` +
        `<p>Thank you,<br/>ORA Clinical Operations</p>`;
    return { subject, text, html };
}

function opsNotifyCopy({ siteName, surveyTitle, roleLabel, status }) {
    const subject = `Site survey ${status}: ${siteName || 'site'}`;
    const text =
        `A site survey was ${status}.\n\n` +
        `Site: ${siteName || '—'}\n` +
        `Survey: ${surveyTitle || '—'}\n` +
        `Role: ${roleLabel || '—'}\n` +
        `\nOpen ARTEMIS → Feasibility / Reporting to review.\n`;
    return { subject, text };
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
}

function emailProviderStatus() {
    const hasWebhook = !!(process.env.SURVEY_EMAIL_WEBHOOK || process.env.SURVEY_NOTIFY_WEBHOOK);
    const hasGraph =
        !!(process.env.SURVEY_EMAIL_FROM || process.env.SURVEY_MAIL_FROM) &&
        !!(process.env.AZURE_CLIENT_ID || '').trim() &&
        !!readClientSecret();
    const hasSendGrid =
        !!(process.env.SENDGRID_API_KEY || '').trim() &&
        !!(
            process.env.SURVEY_EMAIL_FROM ||
            process.env.SENDGRID_FROM_EMAIL ||
            process.env.SURVEY_MAIL_FROM ||
            ''
        ).trim();
    return {
        configured: hasWebhook || hasGraph || hasSendGrid,
        modes: [
            hasWebhook ? 'webhook' : null,
            hasGraph ? 'graph' : null,
            hasSendGrid ? 'sendgrid' : null,
        ].filter(Boolean),
    };
}

module.exports = {
    deliverSurveyEmail,
    inviteEmailCopy,
    opsNotifyCopy,
    emailProviderStatus,
};
