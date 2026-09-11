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

async function deliverViaWebhook({ to, subject, text, html, meta, cc, attachments }) {
    const webhook = process.env.SURVEY_EMAIL_WEBHOOK || process.env.SURVEY_NOTIFY_WEBHOOK;
    if (!webhook) return null;

    try {
        const res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'site_survey_invite',
                to,
                cc: Array.isArray(cc) && cc.length ? cc : undefined,
                subject,
                text,
                html: html || undefined,
                meta: meta || undefined,
                attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
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

async function deliverViaGraph({ to, subject, text, html, cc, attachments }) {
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

        const ccList = Array.isArray(cc) ? cc.filter(Boolean) : [];
        const graphAttachments = (Array.isArray(attachments) ? attachments : [])
            .filter((a) => a?.contentBase64 && a?.fileName)
            .map((a) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: a.fileName,
                contentType: a.contentType || 'application/octet-stream',
                contentBytes: a.contentBase64,
            }));

        const message = {
            subject,
            body: {
                contentType: html ? 'HTML' : 'Text',
                content: html || text,
            },
            toRecipients: [{ emailAddress: { address: to } }],
        };
        if (ccList.length) {
            message.ccRecipients = ccList.map((addr) => ({ emailAddress: { address: addr } }));
        }
        if (graphAttachments.length) {
            message.attachments = graphAttachments;
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
                    message,
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

async function deliverViaSendGrid({ to, subject, text, html, cc, attachments }) {
    const apiKey = (process.env.SENDGRID_API_KEY || '').trim();
    const from = (
        process.env.SURVEY_EMAIL_FROM ||
        process.env.SENDGRID_FROM_EMAIL ||
        process.env.SURVEY_MAIL_FROM ||
        ''
    ).trim();
    if (!apiKey || !from) return null;

    try {
        const ccList = Array.isArray(cc) ? cc.filter(Boolean) : [];
        const sgAttachments = (Array.isArray(attachments) ? attachments : [])
            .filter((a) => a?.contentBase64 && a?.fileName)
            .map((a) => ({
                content: a.contentBase64,
                filename: a.fileName,
                type: a.contentType || 'application/octet-stream',
                disposition: 'attachment',
            }));

        const payload = {
            personalizations: [
                {
                    to: [{ email: to }],
                    ...(ccList.length ? { cc: ccList.map((email) => ({ email })) } : {}),
                },
            ],
            from: { email: from, name: process.env.SURVEY_EMAIL_FROM_NAME || 'Ora Clinical' },
            subject,
            content: [
                { type: 'text/plain', value: text },
                ...(html ? [{ type: 'text/html', value: html }] : []),
            ],
        };
        if (sgAttachments.length) payload.attachments = sgAttachments;

        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
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

async function deliverSurveyEmail({ to, subject, text, html, meta, cc, attachments }) {
    const recipient = String(to || '').trim();
    if (!recipient || !recipient.includes('@')) {
        return { ok: false, mode: 'none', error: 'missing_recipient' };
    }

    const ccList = Array.isArray(cc) ? cc.filter(Boolean) : [];
    const files = Array.isArray(attachments) ? attachments : [];

    const viaWebhook = await deliverViaWebhook({
        to: recipient,
        subject,
        text,
        html,
        meta,
        cc: ccList,
        attachments: files,
    });
    if (viaWebhook) return viaWebhook;

    const viaGraph = await deliverViaGraph({
        to: recipient,
        subject,
        text,
        html,
        cc: ccList,
        attachments: files,
    });
    if (viaGraph) return viaGraph;

    const viaSendGrid = await deliverViaSendGrid({
        to: recipient,
        subject,
        text,
        html,
        cc: ccList,
        attachments: files,
    });
    if (viaSendGrid) return viaSendGrid;

    return { ok: false, mode: 'manual', error: 'no_email_provider' };
}

function inviteEmailCopy({
    siteName,
    roleLabel,
    roleSubjectLabel,
    inviteUrl,
    expiresAt,
    attachmentNames,
    studyCode,
    studyTitle,
    protocolName,
    password,
    dueDate,
    greeting,
    opener,
    closer,
    subjectOverride,
}) {
    const rolePart = String(roleSubjectLabel || roleLabel || 'Site').trim() || 'Site';
    const code = String(studyCode || '').trim();
    const defaultSubject = code
        ? `${code} || Feasibility Survey || ${rolePart}`
        : `Feasibility Survey || ${rolePart}`;
    const subject = String(subjectOverride || '').trim().slice(0, 200) || defaultSubject;

    const greet = String(greeting || 'Dear PI and SC,').trim() || 'Dear PI and SC,';
    const studyLine =
        String(studyTitle || '').trim() ||
        (String(protocolName || '').trim()
            ? String(protocolName).trim()
            : 'this clinical trial');
    const openText =
        String(opener || '').trim() ||
        `Thank you again for your interest in ${studyLine}.`;
    const names = Array.isArray(attachmentNames)
        ? attachmentNames.map((n) => String(n || '').trim()).filter(Boolean)
        : [];
    const due = String(dueDate || '').trim();
    const pwd = String(password || '').trim();
    const closeText =
        String(closer || '').trim() ||
        'Thank you again for your time. We look forward to working with you on this study!';

    const attachIntro = names.length
        ? `I have attached ${
              names.length === 1 ? 'the following document' : 'the following documents'
          } for your review and support of the next step, the Feasibility Survey: ${names.join(', ')}.`
        : 'Please review any materials included with this invitation to support the next step, the Feasibility Survey.';

    const dueLine = due
        ? `Please complete this feasibility survey by ${due}.`
        : expiresAt
          ? `Please complete this feasibility survey by ${new Date(expiresAt).toLocaleDateString()}.`
          : '';

    const textParts = [
        greet,
        '',
        openText,
        '',
        attachIntro,
        'The survey will take approximately 30 minutes, depending on the answers. All information provided via this survey will be kept confidential.',
        '',
        'Here is a link to the survey:',
        inviteUrl || '',
        '',
    ];
    if (pwd) textParts.push(`Password is ${pwd}`, '');
    if (dueLine) textParts.push(dueLine, '');
    textParts.push(closeText, '', 'Best regards,', 'The Ora Team');
    if (siteName) textParts.push('', `Site: ${siteName}`);

    const htmlParts = [
        `<p>${escapeHtml(greet)}</p>`,
        `<p>${escapeHtml(openText)}</p>`,
        `<p>${escapeHtml(attachIntro)}</p>`,
        `<p>The survey will take approximately 30 minutes, depending on the answers. All information provided via this survey will be kept confidential.</p>`,
        `<p>Here is a link to the survey:</p>`,
        inviteUrl
            ? `<p><a href="${escapeAttr(inviteUrl)}">${escapeHtml(inviteUrl)}</a></p>`
            : '<p>(secure link)</p>',
    ];
    if (pwd) htmlParts.push(`<p><strong>Password is ${escapeHtml(pwd)}</strong></p>`);
    if (dueLine) {
        htmlParts.push(
            `<p>Please complete this feasibility survey by <strong>${escapeHtml(
                due || (expiresAt ? new Date(expiresAt).toLocaleDateString() : '')
            )}</strong>.</p>`
        );
    }
    htmlParts.push(`<p>${escapeHtml(closeText)}</p>`, `<p>Best regards,<br/>The Ora Team</p>`);
    if (siteName) {
        htmlParts.push(`<p style="color:#666;font-size:12px;">Site: ${escapeHtml(siteName)}</p>`);
    }

    return {
        subject,
        text: textParts.join('\n'),
        html: htmlParts.join('\n'),
    };
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
