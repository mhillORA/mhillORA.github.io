const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { EmailClient } = require("@azure/communication-email");

// Lazy initialization for the Email Client
let emailClient = null;
const getEmailClient = () => {
    if (!emailClient) {
        const connectionString = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING;
        if (!connectionString) throw new Error("Email connection string missing.");
        emailClient = new EmailClient(connectionString);
    }
    return emailClient;
};

// Use node-fetch instead of native fetch for Azure Functions compatibility
// Native fetch is broken in Azure Functions environment
// Import node-fetch using require (v2 supports CommonJS)
let fetch;
let fetchError = null;
const normalizeFetch = (module) => {
    if (!module) {
        return null;
    }
    if (typeof module === 'function') {
        return module;
    }
    if (typeof module.default === 'function') {
        return module.default;
    }
    if (typeof module.fetch === 'function') {
        return module.fetch;
    }
    return null;
};

const getFetch = async () => {
    if (fetchError) {
        throw fetchError;
    }
    if (!fetch) {
        try {
            // Try native fetch first (Azure Functions may support it now)
            if (typeof globalThis !== 'undefined' && globalThis.fetch) {
                fetch = globalThis.fetch;
                console.log('Using native fetch');
            } else if (typeof global !== 'undefined' && global.fetch) {
                fetch = global.fetch;
                console.log('Using global fetch');
            } else {
                // Try ESM imports first (node-fetch v3 is ESM-only)
                try {
                    const nodeFetch = await import('node-fetch');
                    fetch = normalizeFetch(nodeFetch);
                    if (fetch) {
                        console.log('Using node-fetch v3 (ESM)');
                    }
                } catch (esmError) {
                    // Fallback to CommonJS require (node-fetch v2)
                    try {
                        const requiredFetch = require('node-fetch');
                        fetch = normalizeFetch(requiredFetch);
                        if (fetch) {
                            console.log('Using node-fetch v2 (CommonJS)');
                        }
                    } catch (requireError) {
                        throw new Error(`Failed to load fetch: ESM error: ${esmError.message}, CommonJS error: ${requireError.message}`);
                    }
                }
            }
            
            if (!fetch || typeof fetch !== 'function') {
                throw new Error('No valid fetch function found. Tried: native, ESM node-fetch, CommonJS node-fetch');
            }
        } catch (importError) {
            fetchError = importError;
            const errorMessage = `Failed to import fetch: ${importError.message}. Make sure node-fetch is installed in package.json or native fetch is available.`;
            console.error(errorMessage);
            throw new Error(errorMessage);
        }
    }
    return fetch;
};

// Helper function to generate unique IDs
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Helper function to get Cosmos DB client (lazy initialization)
let cosmosClient = null;
let database = null;

const getCosmosClient = () => {
    if (!cosmosClient) {
        const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
        const COSMOS_KEY = process.env.COSMOS_KEY;
        const DATABASE_ID = process.env.DATABASE_ID;

        if (!COSMOS_ENDPOINT || !COSMOS_KEY || !DATABASE_ID) {
            throw new Error("COSMOS_DB_CONFIG_MISSING: Missing required Cosmos DB environment variables (Endpoint, Key, or Database ID). Check Azure Configuration.");
        }

        cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
        database = cosmosClient.database(DATABASE_ID);
    }
    return { client: cosmosClient, database };
};

// Helper function to get container
const getContainer = (containerName) => {
    const { database } = getCosmosClient();
    return database.container(containerName);
};

// Ensure email-triggers container exists (create if not). Call before using getContainer('email-triggers').
const ensureEmailTriggersContainer = async () => {
    const { database } = getCosmosClient();
    await database.containers.createIfNotExists({
        id: 'email-triggers',
        partitionKey: { paths: ['/id'] }
    });
};

// ---------------------------------------------------------------------------------
// EMAIL TEMPLATE RENDERING + SEND
// ---------------------------------------------------------------------------------
const toDateOnlyString = (value) => {
    if (!value) return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        const datePart = trimmed.split('T')[0];
        if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
        const d = new Date(trimmed);
        if (!Number.isNaN(d.getTime())) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${dd}`;
        }
        return null;
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
};

const getByPath = (obj, path) => {
    if (!obj || !path) return undefined;
    const parts = String(path).split('.').map(p => p.trim()).filter(Boolean);
    let cur = obj;
    for (const part of parts) {
        if (cur == null) return undefined;
        cur = cur[part];
    }
    return cur;
};

const htmlEscape = (s) => {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

// Very simple mustache-ish renderer: replaces {{path.to.value}} with a string value.
// Arrays become comma-joined; objects become JSON.
const renderTemplateString = (template, context) => {
    if (template == null) return '';
    const input = String(template);
    return input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
        const value = getByPath(context, key);
        if (value === undefined || value === null) return '';
        if (Array.isArray(value)) return value.map(v => (v == null ? '' : String(v))).filter(Boolean).join(', ');
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    });
};

const eventBelongsToCrc = (event, crcId) => {
    if (!event || !crcId) return false;
    if (event.crcId === crcId) return true;
    // Check crcIds array (for travel days with multiple CRCs)
    if (event.crcIds && Array.isArray(event.crcIds)) {
        if (event.crcIds.includes(crcId)) return true;
    }
    // Check roleAssignments (for shifts and travel days using roleAssignments)
    if (event.roleAssignments && typeof event.roleAssignments === 'object') {
        return Object.values(event.roleAssignments).some(assignments => Array.isArray(assignments) && assignments.includes(crcId));
    }
    return false;
};

const isTimeOffLikeType = (type) => {
    const t = String(type || '').trim().toLowerCase();
    return [
        'time off',
        'unavailable',
        'paid time off',
        'pto',
        'sick time',
        'sick',
        'vacation',
        'holiday',
        'bereavement',
        'jury duty',
        'per diem',
        'capped - fte only'
    ].includes(t);
};

const buildScheduleCsv = ({ crcName, startDate, endDate, shifts = [], timeOff = [], travel = [] }) => {
    const lines = [];
    const header = ['CRC', 'Range Start', 'Range End'];
    lines.push(header.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    lines.push([crcName || '', startDate || '', endDate || ''].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    lines.push('');

    lines.push('"Section","Date","Type","Details"');
    const addRow = (section, date, type, details) => {
        lines.push([section, date, type, details].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    };

    shifts.forEach(s => addRow('Shift', s.date || '', s.type || 'Site Assignment', s.summary || s.siteName || ''));
    timeOff.forEach(t => addRow('Time Off', t.date || '', t.type || 'Time Off', t.summary || t.period || ''));
    travel.forEach(t => addRow('Travel', t.date || '', t.type || 'Travel', t.summary || t.route || ''));

    return lines.join('\n');
};

// Build iCal format for calendar export
const buildScheduleIcal = ({ crcName, startDate, endDate, shifts = [], timeOff = [], travel = [] }) => {
    const lines = [];
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//CHAOS Scheduler//Schedule Export//EN');
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');
    
    // Helper to format date for iCal (YYYYMMDDTHHMMSSZ)
    const formatIcalDate = (dateStr, timeStr = null) => {
        if (!dateStr) return now;
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return now;
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        if (timeStr) {
            const [hours, minutes] = timeStr.split(':');
            return `${year}${month}${day}T${(hours || '00').padStart(2, '0')}${(minutes || '00').padStart(2, '0')}00Z`;
        }
        return `${year}${month}${day}T000000Z`;
    };
    
    // Helper to escape text for iCal
    const escapeIcal = (text) => {
        return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
    };
    
    // Add shifts
    shifts.forEach((shift, index) => {
        const start = formatIcalDate(shift.date);
        const end = formatIcalDate(shift.date, '23:59');
        const summary = escapeIcal(`${shift.type || 'Site Assignment'} - ${shift.siteName || ''}`);
        const description = escapeIcal(shift.summary || '');
        
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:shift-${shift.id || index}-${now}@chaos-scheduler`);
        lines.push(`DTSTART:${start}`);
        lines.push(`DTEND:${end}`);
        lines.push(`SUMMARY:${summary}`);
        if (description) lines.push(`DESCRIPTION:${description}`);
        lines.push(`LOCATION:${escapeIcal(shift.siteLocation || '')}`);
        lines.push(`DTSTAMP:${now}`);
        lines.push('END:VEVENT');
    });
    
    // Add time off
    [...timeOff].forEach((to, index) => {
        const start = formatIcalDate(to.date || to.startDate);
        const end = formatIcalDate(to.endDate || to.date || to.startDate, '23:59');
        const summary = escapeIcal(`${to.type || 'Time Off'} - ${to.period || 'Full Day'}`);
        const description = escapeIcal(to.summary || '');
        
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:timeoff-${to.id || index}-${now}@chaos-scheduler`);
        lines.push(`DTSTART:${start}`);
        lines.push(`DTEND:${end}`);
        lines.push(`SUMMARY:${summary}`);
        if (description) lines.push(`DESCRIPTION:${description}`);
        lines.push(`DTSTAMP:${now}`);
        lines.push('END:VEVENT');
    });
    
    // Add travel
    travel.forEach((t, index) => {
        const start = formatIcalDate(t.date);
        const end = formatIcalDate(t.date, '23:59');
        const summary = escapeIcal(`Travel - ${t.route || t.type || 'Travel'}`);
        const description = escapeIcal(t.summary || '');
        
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:travel-${t.id || index}-${now}@chaos-scheduler`);
        lines.push(`DTSTART:${start}`);
        lines.push(`DTEND:${end}`);
        lines.push(`SUMMARY:${summary}`);
        if (description) lines.push(`DESCRIPTION:${description}`);
        lines.push(`DTSTAMP:${now}`);
        lines.push('END:VEVENT');
    });
    
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
};

const buildRecipientEmailContext = async ({ crcId, startDate, endDate, recipient = null, user = null }, context, lookups = {}) => {
    const start = toDateOnlyString(startDate) || toDateOnlyString(new Date());
    const end = toDateOnlyString(endDate) || start;

    const crcsContainer = getContainer('crcs');
    const eventsContainer = getContainer('events');
    const timeOffContainer = getContainer('time-off-requests');
    const travelContainer = getContainer('travel');
    const siteNameById = lookups.siteNameById || new Map();
    const siteLocationById = lookups.siteLocationById || new Map();
    const siteDetailsById = lookups.siteDetailsById || new Map();
    const studyNameById = lookups.studyNameById || new Map();
    const studyDetailsById = lookups.studyDetailsById || new Map();
    const roleNameById = lookups.roleNameById || new Map();

    let crc = null;
    try {
        if (crcId) {
            const { resource } = await crcsContainer.item(crcId, crcId).read();
            crc = resource || null;
        }
    } catch (e) {
        context?.log?.warn?.(`Failed to read CRC ${crcId}: ${e.message}`);
    }

    // Query events by date window (broad), then filter to recipient membership (crcId or roleAssignments).
    let events = [];
    try {
        const { resources } = await eventsContainer.items.query({
            query: "SELECT * FROM c WHERE c.date >= @start AND c.date <= @end",
            parameters: [
                { name: "@start", value: start },
                { name: "@end", value: end }
            ]
        }).fetchAll();
        events = Array.isArray(resources) ? resources : [];
    } catch (e) {
        context?.log?.warn?.(`Failed to query events: ${e.message}`);
    }
    const myEvents = crcId ? events.filter(e => eventBelongsToCrc(e, crcId)) : [];

    const getEventRoleNamesForCrc = (event) => {
        const names = new Set();
        if (!event || !crcId) return [];
        if (event.roleAssignments && typeof event.roleAssignments === 'object') {
            for (const [roleId, assignments] of Object.entries(event.roleAssignments)) {
                if (Array.isArray(assignments) && assignments.includes(crcId)) {
                    const roleName = roleNameById.get(roleId) || null;
                    if (roleName) names.add(roleName);
                }
            }
        }
        if (Array.isArray(event.roles)) {
            event.roles.forEach(r => {
                if (r) names.add(String(r));
            });
        }
        return Array.from(names.values()).sort();
    };

    const shifts = myEvents
        .filter(e => String(e.type || '').toLowerCase() === 'site assignment')
        .map(e => ({
            id: e.id,
            date: toDateOnlyString(e.date),
            type: e.type,
            period: e.period || 'Full Day',
            hours: e.hours ?? null,
            siteId: e.siteId || null,
            siteName: (e.siteId && siteNameById.get(e.siteId)) ? siteNameById.get(e.siteId) : null,
            siteLocation: (e.siteId && siteLocationById.get(e.siteId)) ? siteLocationById.get(e.siteId) : null,
            site: (e.siteId && siteDetailsById.get(e.siteId)) ? siteDetailsById.get(e.siteId) : null,
            studies: Array.isArray(e.studyIds) ? e.studyIds.map(id => studyNameById.get(id) || id).filter(Boolean) : [],
            studyDetails: Array.isArray(e.studyIds) ? e.studyIds.map(id => studyDetailsById.get(id) || null).filter(Boolean) : [],
            roles: getEventRoleNamesForCrc(e),
            visitNumber: e.visitNumber || null,
            groupNumber: e.groupNumber || null,
            summary: (() => {
                const dateStr = toDateOnlyString(e.date) || '';
                const site = (e.siteId && siteNameById.get(e.siteId)) ? siteNameById.get(e.siteId) : '';
                const siteLoc = (e.siteId && siteLocationById.get(e.siteId)) ? siteLocationById.get(e.siteId) : '';
                const studies = Array.isArray(e.studyIds) ? e.studyIds.map(id => studyNameById.get(id) || '').filter(Boolean).join(', ') : '';
                const roles = getEventRoleNamesForCrc(e).join(', ');
                const parts = [
                    dateStr,
                    e.period || 'Full Day',
                    site,
                    siteLoc,
                    studies,
                    roles
                ].filter(Boolean);
                return parts.join(' • ');
            })()
        }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const timeOffEvents = myEvents
        .filter(e => isTimeOffLikeType(e.type))
        .map(e => ({
            id: e.id,
            date: toDateOnlyString(e.date),
            type: e.type,
            name: e.name || null,
            period: e.period || 'Full Day',
            hours: e.hours ?? null,
            summary: `${toDateOnlyString(e.date) || ''} • ${e.name || e.type || 'Time Off'} • ${e.period || 'Full Day'}`
        }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    let timeOffRequests = [];
    try {
        if (crcId) {
            const { resources } = await timeOffContainer.items.query({
                query: "SELECT * FROM c WHERE c.crcId = @crcId AND c.date >= @start AND c.date <= @end",
                parameters: [
                    { name: "@crcId", value: crcId },
                    { name: "@start", value: start },
                    { name: "@end", value: end }
                ]
            }).fetchAll();
            timeOffRequests = Array.isArray(resources) ? resources : [];
        }
    } catch (e) {
        context?.log?.warn?.(`Failed to query time off requests: ${e.message}`);
    }
    const timeOffRequestEntries = timeOffRequests.map(r => ({
        id: r.id,
        date: toDateOnlyString(r.date || r.startDate),
        type: r.type || 'Time Off',
        period: r.period || 'Full Day',
        status: r.status || 'pending',
        hours: r.hours ?? null,
        summary: `${toDateOnlyString(r.date || r.startDate) || ''} • ${r.type || 'Time Off'} • ${r.period || 'Full Day'} • ${(r.status || '').toString()}`
    }));

    let travel = [];
    try {
        const { resources } = await travelContainer.items.query({
            query: "SELECT * FROM c WHERE c.date >= @start AND c.date <= @end",
            parameters: [
                { name: "@start", value: start },
                { name: "@end", value: end }
            ]
        }).fetchAll();
        const allTravel = Array.isArray(resources) ? resources : [];
        travel = crcId ? allTravel.filter(t => t && (t.crcId === crcId)) : [];
    } catch (e) {
        context?.log?.warn?.(`Failed to query travel: ${e.message}`);
    }
    const travelEntries = travel.map(t => ({
        id: t.id,
        date: toDateOnlyString(t.date || t.departureDate || t.startDate),
        type: t.bookingType || 'Travel',
        route: t.origin && t.destination ? `${t.origin} → ${t.destination}` : '',
        flightNumber: t.flightNumber || null,
        confirmationNumber: t.confirmationNumber || null,
        summary: `${toDateOnlyString(t.date || t.departureDate || t.startDate) || ''} • ${(t.origin && t.destination) ? `${t.origin} → ${t.destination}` : (t.bookingType || 'Travel')}${t.flightNumber ? ` • ${t.flightNumber}` : ''}`
    }));

    const scheduleText = shifts.map(s => `- ${s.summary || `${s.date} (${s.period})`}`).join('\n');
    const timeOffText = [...timeOffRequestEntries, ...timeOffEvents].map(t => `- ${t.summary || `${t.date} ${t.type} (${t.period})`}`).join('\n');
    const travelText = travelEntries.map(t => `- ${t.date} ${t.route || t.type}`).join('\n');

    // Provide HTML/text chunks that templates can drop in.
    const scheduleHtml = shifts.length
        ? `<ul>${shifts.map(s => `<li>${htmlEscape(s.summary || '')}</li>`).join('')}</ul>`
        : `<p>No shifts in range.</p>`;

    // Detailed schedule rendering (explicit columns)
    const scheduleDetailsText = shifts.length
        ? shifts.map(s => {
            const studies = (s.studies || []).join(', ');
            const roles = (s.roles || []).join(', ');
            const visit = s.visitNumber ? `Visit: ${s.visitNumber}` : '';
            const group = s.groupNumber ? `Group: ${s.groupNumber}` : '';
            const parts = [
                s.date,
                s.period,
                s.siteName || s.siteId || '',
                s.siteLocation || '',
                studies ? `Study: ${studies}` : '',
                roles ? `Roles: ${roles}` : '',
                visit,
                group
            ].filter(Boolean);
            return `- ${parts.join(' | ')}`;
        }).join('\n')
        : 'No shifts in range.';

    const scheduleDetailsHtml = shifts.length
        ? `
            <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:12px;">
                <thead>
                    <tr>
                        <th align="left">Date</th>
                        <th align="left">Period</th>
                        <th align="left">Site</th>
                        <th align="left">Location</th>
                        <th align="left">Study</th>
                        <th align="left">Roles</th>
                        <th align="left">Visit</th>
                        <th align="left">Group</th>
                    </tr>
                </thead>
                <tbody>
                    ${shifts.map(s => `
                        <tr>
                            <td>${htmlEscape(s.date || '')}</td>
                            <td>${htmlEscape(s.period || '')}</td>
                            <td>${htmlEscape(s.siteName || s.siteId || '')}</td>
                            <td>${htmlEscape(s.siteLocation || '')}</td>
                            <td>${htmlEscape((s.studies || []).join(', '))}</td>
                            <td>${htmlEscape((s.roles || []).join(', '))}</td>
                            <td>${htmlEscape(s.visitNumber || '')}</td>
                            <td>${htmlEscape(s.groupNumber || '')}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `
        : `<p>No shifts in range.</p>`;

    // Build deduplicated site/study contact summary
    const buildSiteContactSummary = (shifts) => {
        const siteStudyMap = new Map(); // key: siteId or siteName, value: { site, studies: Set }
        
        shifts.forEach(s => {
            const siteId = s.siteId || s.siteName || 'unknown';
            const site = s.site || {};
            const siteName = s.siteName || site.name || siteId;
            
            if (!siteStudyMap.has(siteId)) {
                siteStudyMap.set(siteId, {
                    siteId,
                    siteName,
                    site,
                    studies: new Set()
                });
            }
            
            // Add studies for this site
            (s.studies || []).forEach(study => {
                siteStudyMap.get(siteId).studies.add(study);
            });
        });
        
        if (siteStudyMap.size === 0) return '';
        
        let html = '<div style="margin-top:20px;padding-top:15px;border-top:2px solid #ddd;">';
        html += '<h3 style="font-size:14px;font-weight:bold;margin-bottom:12px;">Site Contact Information</h3>';
        
        Array.from(siteStudyMap.values()).forEach(({ siteName, site, studies }) => {
            const addrLines = [
                site.address1,
                site.address2,
                [site.city, site.state, site.zipCode || site.zip].filter(Boolean).join(', '),
                site.country
            ].filter(Boolean);
            
            html += '<div style="border:1px solid #ddd;border-radius:6px;padding:10px;margin:0 0 10px 0;background-color:#f9f9f9;">';
            html += `<div style="font-weight:bold;margin-bottom:6px;font-size:13px;">${htmlEscape(siteName)}</div>`;
            
            if (studies.size > 0) {
                html += `<div style="margin-bottom:6px;"><strong>Studies:</strong> ${htmlEscape(Array.from(studies).join(', '))}</div>`;
            }
            
            if (addrLines.length) {
                html += `<div style="margin-bottom:4px;"><strong>Address:</strong><br/>${addrLines.map(l => htmlEscape(l)).join('<br/>')}</div>`;
            }
            
            if (site.phoneNumber || site.phone) {
                html += `<div style="margin-bottom:4px;"><strong>Phone:</strong> ${htmlEscape(site.phoneNumber || site.phone)}</div>`;
            }
            
            if (site.pi || site.principalInvestigator) {
                html += `<div style="margin-bottom:4px;"><strong>PI:</strong> ${htmlEscape(site.pi || site.principalInvestigator)}`;
                if (site.piEmail) {
                    html += ` • <a href="mailto:${htmlEscape(site.piEmail)}">${htmlEscape(site.piEmail)}</a>`;
                }
                html += '</div>';
            } else if (site.piEmail) {
                html += `<div style="margin-bottom:4px;"><strong>PI Email:</strong> <a href="mailto:${htmlEscape(site.piEmail)}">${htmlEscape(site.piEmail)}</a></div>`;
            }
            
            if (site.siteCoordinator) {
                html += `<div style="margin-bottom:4px;"><strong>Coordinator:</strong> ${htmlEscape(site.siteCoordinator)}`;
                if (site.siteCoordinatorEmail) {
                    html += ` • <a href="mailto:${htmlEscape(site.siteCoordinatorEmail)}">${htmlEscape(site.siteCoordinatorEmail)}</a>`;
                }
                html += '</div>';
            } else if (site.siteCoordinatorEmail) {
                html += `<div style="margin-bottom:4px;"><strong>Coordinator Email:</strong> <a href="mailto:${htmlEscape(site.siteCoordinatorEmail)}">${htmlEscape(site.siteCoordinatorEmail)}</a></div>`;
            }
            
            html += '</div>';
        });
        
        html += '</div>';
        return html;
    };

    // Build deduplicated site/study contact summary with study details
    const buildSiteContactSummaryFull = (shifts) => {
        const siteStudyMap = new Map(); // key: siteId, value: { site, studies: Map(studyName -> studyDetails) }
        
        shifts.forEach(s => {
            const siteId = s.siteId || s.siteName || 'unknown';
            const site = s.site || {};
            const siteName = s.siteName || site.name || siteId;
            
            if (!siteStudyMap.has(siteId)) {
                siteStudyMap.set(siteId, {
                    siteId,
                    siteName,
                    site,
                    studies: new Map() // studyName -> studyDetails array
                });
            }
            
            const entry = siteStudyMap.get(siteId);
            
            // Add studies with their details for this site
            (s.studies || []).forEach((studyName, idx) => {
                if (!entry.studies.has(studyName)) {
                    const studyDetails = (s.studyDetails || [])[idx] || null;
                    entry.studies.set(studyName, studyDetails);
                }
            });
        });
        
        if (siteStudyMap.size === 0) return '';
        
        let html = '<div style="margin-top:20px;padding-top:15px;border-top:2px solid #ddd;">';
        html += '<h3 style="font-size:14px;font-weight:bold;margin-bottom:12px;">Site Contact Information</h3>';
        
        Array.from(siteStudyMap.values()).forEach(({ siteName, site, studies }) => {
            const addrLines = [
                site.address1,
                site.address2,
                [site.city, site.state, site.zipCode || site.zip].filter(Boolean).join(', '),
                site.country
            ].filter(Boolean);
            
            html += '<div style="border:1px solid #ddd;border-radius:6px;padding:10px;margin:0 0 10px 0;background-color:#f9f9f9;">';
            html += `<div style="font-weight:bold;margin-bottom:6px;font-size:13px;">${htmlEscape(siteName)}</div>`;
            
            // List studies with details
            if (studies.size > 0) {
                html += '<div style="margin-bottom:8px;"><strong>Studies:</strong><ul style="margin:4px 0 0 18px;padding:0;">';
                Array.from(studies.entries()).forEach(([studyName, studyDetails]) => {
                    html += '<li>';
                    html += htmlEscape(studyName);
                    if (studyDetails) {
                        const title = studyDetails.title || studyDetails.name || studyDetails.protocolNumber || studyDetails.id || '';
                        const proto = studyDetails.protocolNumber ? `Protocol: ${studyDetails.protocolNumber}` : '';
                        const phase = studyDetails.phase ? `Phase: ${studyDetails.phase}` : '';
                        const status = studyDetails.status || studyDetails.state ? `Status: ${studyDetails.status || studyDetails.state}` : '';
                        const details = [title, proto, phase, status].filter(Boolean).join(' • ');
                        if (details) {
                            html += ` <span style="color:#666;font-size:11px;">(${htmlEscape(details)})</span>`;
                        }
                    }
                    html += '</li>';
                });
                html += '</ul></div>';
            }
            
            if (addrLines.length) {
                html += `<div style="margin-bottom:4px;"><strong>Address:</strong><br/>${addrLines.map(l => htmlEscape(l)).join('<br/>')}</div>`;
            }
            
            if (site.phoneNumber || site.phone) {
                html += `<div style="margin-bottom:4px;"><strong>Phone:</strong> ${htmlEscape(site.phoneNumber || site.phone)}</div>`;
            }
            
            if (site.pi || site.principalInvestigator) {
                html += `<div style="margin-bottom:4px;"><strong>PI:</strong> ${htmlEscape(site.pi || site.principalInvestigator)}`;
                if (site.piEmail) {
                    html += ` • <a href="mailto:${htmlEscape(site.piEmail)}">${htmlEscape(site.piEmail)}</a>`;
                }
                html += '</div>';
            } else if (site.piEmail) {
                html += `<div style="margin-bottom:4px;"><strong>PI Email:</strong> <a href="mailto:${htmlEscape(site.piEmail)}">${htmlEscape(site.piEmail)}</a></div>`;
            }
            
            if (site.siteCoordinator) {
                html += `<div style="margin-bottom:4px;"><strong>Coordinator:</strong> ${htmlEscape(site.siteCoordinator)}`;
                if (site.siteCoordinatorEmail) {
                    html += ` • <a href="mailto:${htmlEscape(site.siteCoordinatorEmail)}">${htmlEscape(site.siteCoordinatorEmail)}</a>`;
                }
                html += '</div>';
            } else if (site.siteCoordinatorEmail) {
                html += `<div style="margin-bottom:4px;"><strong>Coordinator Email:</strong> <a href="mailto:${htmlEscape(site.siteCoordinatorEmail)}">${htmlEscape(site.siteCoordinatorEmail)}</a></div>`;
            }
            
            html += '</div>';
        });
        
        html += '</div>';
        return html;
    };

    // "Basic" schedule: Date, Period/Time, Role(s), Study, Visit, Site (most common use)
    const scheduleBasicText = shifts.length
        ? shifts.map(s => {
            const studies = (s.studies || []).join(', ');
            const roles = (s.roles || []).join(', ') || 'No roles';
            const visit = s.visitNumber ? `Visit ${s.visitNumber}` : '';
            const site = s.siteName || s.siteId || '';
            const parts = [
                s.date,
                s.period || 'Full Day',
                roles,
                studies ? `Study: ${studies}` : '',
                visit,
                site
            ].filter(Boolean);
            return `- ${parts.join(' • ')}`;
        }).join('\n')
        : 'No shifts in range.';

    const scheduleBasicHtml = shifts.length
        ? `
            <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:12px;">
                <thead>
                    <tr>
                        <th align="left">Date</th>
                        <th align="left">Time/Period</th>
                        <th align="left">Role(s)</th>
                        <th align="left">Study</th>
                        <th align="left">Visit</th>
                        <th align="left">Site</th>
                    </tr>
                </thead>
                <tbody>
                    ${shifts.map(s => `
                        <tr>
                            <td>${htmlEscape(s.date || '')}</td>
                            <td>${htmlEscape(s.period || '')}</td>
                            <td>${htmlEscape((s.roles || []).join(', '))}</td>
                            <td>${htmlEscape((s.studies || []).join(', '))}</td>
                            <td>${htmlEscape(s.visitNumber || '')}</td>
                            <td>${htmlEscape(s.siteName || s.siteId || '')}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            ${buildSiteContactSummary(shifts)}
        `
        : `<p>No shifts in range.</p>`;

    // "Full" schedule: Date, Site, Study, Visit, Group, Role (no contact info)
    const scheduleFullText = shifts.length
        ? shifts.map(s => {
            const studies = (s.studies || []).join(', ');
            const roles = (s.roles || []).join(', ');
            const siteName = s.siteName || (s.site && s.site.name) || s.siteId || '';
            const parts = [
                s.date,
                siteName ? `Site: ${siteName}` : '',
                studies ? `Study: ${studies}` : '',
                s.visitNumber ? `Visit: ${s.visitNumber}` : '',
                s.groupNumber ? `Group: ${s.groupNumber}` : '',
                roles ? `Role: ${roles}` : ''
            ].filter(Boolean);
            return `- ${parts.join(' | ')}`;
        }).join('\n')
        : 'No shifts in range.';

    const scheduleFullHtml = shifts.length
        ? `
            <div style="font-family:Arial,sans-serif;font-size:12px;">
                ${shifts.map(s => {
                    const site = s.site || {};
                    const siteName = s.siteName || site.name || s.siteId || '';
                    const studyLines = (s.studyDetails || []).map(st => {
                        const title = st.title || st.name || st.protocolNumber || st.id || '';
                        const proto = st.protocolNumber ? `Protocol: ${st.protocolNumber}` : '';
                        const phase = st.phase ? `Phase: ${st.phase}` : '';
                        const status = st.status || st.state ? `Status: ${st.status || st.state}` : '';
                        return [title, proto, phase, status].filter(Boolean).join(' • ');
                    }).filter(Boolean);
                    const roleStr = (s.roles || []).join(', ');
                    return `
                        <div style="border:1px solid #ddd;border-radius:6px;padding:10px;margin:0 0 10px 0;">
                            <div style="font-weight:bold;margin-bottom:6px;">
                                ${htmlEscape(s.date || '')} • ${htmlEscape(s.period || '')}
                            </div>
                            <div><strong>Role(s):</strong> ${htmlEscape(roleStr || '')}</div>
                            <div><strong>Study:</strong> ${htmlEscape((s.studies || []).join(', '))}</div>
                            <div><strong>Visit:</strong> ${htmlEscape(s.visitNumber || '')} ${s.groupNumber ? ` • <strong>Group:</strong> ${htmlEscape(s.groupNumber)}` : ''}</div>
                            <div><strong>Site:</strong> ${htmlEscape(siteName)}</div>
                            ${studyLines.length ? `<div style="margin-top:8px;"><strong>Study details:</strong><ul style="margin:4px 0 0 18px;padding:0;">${studyLines.map(l => `<li>${htmlEscape(l)}</li>`).join('')}</ul></div>` : ''}
                        </div>
                    `;
                }).join('')}
                ${buildSiteContactSummaryFull(shifts)}
            </div>
        `
        : `<p>No shifts in range.</p>`;
    const timeOffHtml = (timeOffRequestEntries.length || timeOffEvents.length)
        ? `<ul>${[...timeOffRequestEntries, ...timeOffEvents].map(t => `<li>${htmlEscape(t.date)} • ${htmlEscape(t.type)} • ${htmlEscape(t.period)}${t.status ? ` • ${htmlEscape(t.status)}` : ''}</li>`).join('')}</ul>`
        : `<p>No time off in range.</p>`;
    const travelHtml = travelEntries.length
        ? `<ul>${travelEntries.map(t => `<li>${htmlEscape(t.date)} • ${htmlEscape(t.route || t.type)}</li>`).join('')}</ul>`
        : `<p>No travel in range.</p>`;

    // Parse CRC name into first and last name
    const parseCrcName = (fullName) => {
        if (!fullName || typeof fullName !== 'string') {
            return { firstName: '', lastName: '', fullName: '' };
        }
        const trimmed = fullName.trim();
        if (!trimmed) {
            return { firstName: '', lastName: '', fullName: '' };
        }
        const parts = trimmed.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
            return { firstName: '', lastName: '', fullName: trimmed };
        }
        if (parts.length === 1) {
            return { firstName: parts[0], lastName: '', fullName: trimmed };
        }
        // First name is first part, last name is everything else joined
        const firstName = parts[0];
        const lastName = parts.slice(1).join(' ');
        return { firstName, lastName, fullName: trimmed };
    };

    const resolvedCrcName = (crc && crc.name) ? crc.name : '';
    const nameParts = parseCrcName(resolvedCrcName);
    const crcFirstName = nameParts.firstName;
    const crcLastName = nameParts.lastName;
    
    const totals = {
        shiftCount: shifts.length,
        timeOffRequestCount: timeOffRequestEntries.length,
        timeOffEventCount: timeOffEvents.length,
        travelCount: travelEntries.length
    };

    // Build deduplicated sites and studies arrays for direct template access
    const sitesMap = new Map();
    const studiesMap = new Map();
    
    shifts.forEach(s => {
        // Collect unique sites
        if (s.siteId && s.site) {
            if (!sitesMap.has(s.siteId)) {
                const site = s.site;
                const siteStudies = new Set();
                shifts.forEach(sh => {
                    if (sh.siteId === s.siteId && sh.studies) {
                        sh.studies.forEach(study => siteStudies.add(study));
                    }
                });
                
                sitesMap.set(s.siteId, {
                    id: s.siteId,
                    name: s.siteName || site.name || s.siteId,
                    location: s.siteLocation || site.location || '',
                    address1: site.address1 || '',
                    address2: site.address2 || '',
                    city: site.city || '',
                    state: site.state || '',
                    zipCode: site.zipCode || site.zip || '',
                    country: site.country || '',
                    phoneNumber: site.phoneNumber || site.phone || '',
                    pi: site.pi || site.principalInvestigator || '',
                    piEmail: site.piEmail || '',
                    siteCoordinator: site.siteCoordinator || '',
                    siteCoordinatorEmail: site.siteCoordinatorEmail || '',
                    studies: Array.from(siteStudies)
                });
            }
        }
        
        // Collect unique studies
        if (s.studies && s.studyDetails) {
            s.studies.forEach((studyName, idx) => {
                if (!studiesMap.has(studyName)) {
                    const studyDetail = s.studyDetails[idx] || {};
                    studiesMap.set(studyName, {
                        name: studyName,
                        title: studyDetail.title || studyDetail.name || studyName,
                        protocolNumber: studyDetail.protocolNumber || '',
                        phase: studyDetail.phase || '',
                        status: studyDetail.status || studyDetail.state || '',
                        id: studyDetail.id || ''
                    });
                }
            });
        }
    });
    
    const sites = Array.from(sitesMap.values());
    const studies = Array.from(studiesMap.values());

    // Build formatted "all site info" and "all study info" text
    const buildAllSitesInfo = (sitesArray) => {
        if (!sitesArray || sitesArray.length === 0) return 'No sites in schedule.';
        return sitesArray.map(site => {
            const lines = [];
            lines.push(`SITE: ${site.name || site.id || 'Unknown'}`);
            if (site.studies && site.studies.length > 0) {
                lines.push(`Studies: ${site.studies.join(', ')}`);
            }
            if (site.address1 || site.city || site.state) {
                const addrParts = [
                    site.address1,
                    site.address2,
                    [site.city, site.state, site.zipCode].filter(Boolean).join(', '),
                    site.country
                ].filter(Boolean);
                if (addrParts.length > 0) {
                    lines.push(`Address: ${addrParts.join('\n         ')}`);
                }
            }
            if (site.phoneNumber) {
                lines.push(`Phone: ${site.phoneNumber}`);
            }
            if (site.pi) {
                lines.push(`Principal Investigator: ${site.pi}${site.piEmail ? ` (${site.piEmail})` : ''}`);
            } else if (site.piEmail) {
                lines.push(`PI Email: ${site.piEmail}`);
            }
            if (site.siteCoordinator) {
                lines.push(`Site Coordinator: ${site.siteCoordinator}${site.siteCoordinatorEmail ? ` (${site.siteCoordinatorEmail})` : ''}`);
            } else if (site.siteCoordinatorEmail) {
                lines.push(`Coordinator Email: ${site.siteCoordinatorEmail}`);
            }
            return lines.join('\n');
        }).join('\n\n');
    };

    const buildAllStudiesInfo = (studiesArray) => {
        if (!studiesArray || studiesArray.length === 0) return 'No studies in schedule.';
        return studiesArray.map(study => {
            const lines = [];
            lines.push(`STUDY: ${study.name || study.title || 'Unknown'}`);
            if (study.title && study.title !== study.name) {
                lines.push(`Title: ${study.title}`);
            }
            if (study.protocolNumber) {
                lines.push(`Protocol: ${study.protocolNumber}`);
            }
            if (study.phase) {
                lines.push(`Phase: ${study.phase}`);
            }
            if (study.status) {
                lines.push(`Status: ${study.status}`);
            }
            return lines.join('\n');
        }).join('\n\n');
    };

    const allSitesInfo = buildAllSitesInfo(sites);
    const allStudiesInfo = buildAllStudiesInfo(studies);

    return {
        recipient: recipient || {},
        user: user || {},
        crc: crc || { id: crcId || null, name: resolvedCrcName, firstName: crcFirstName, lastName: crcLastName },
        range: { start, end },
        schedule: { shifts, text: scheduleText, html: scheduleHtml },
        timeOff: { requests: timeOffRequestEntries, events: timeOffEvents, text: timeOffText, html: timeOffHtml },
        travel: { records: travelEntries, text: travelText, html: travelHtml },
        sites,
        studies,
        totals,
        // Shorthand vars for "simple stupid" templates
        crcName: resolvedCrcName,
        crcFirstName: crcFirstName,
        crcLastName: crcLastName,
        allSitesInfo: buildAllSitesInfo(sites),
        allStudiesInfo: buildAllStudiesInfo(studies),
        rangeStart: start,
        rangeEnd: end,
        scheduleText,
        scheduleHtml,
        scheduleDetailsText,
        scheduleDetailsHtml,
        scheduleBasicText,
        scheduleBasicHtml,
        scheduleFullText,
        scheduleFullHtml,
        timeOffText,
        timeOffHtml,
        travelText,
        travelHtml,
        allSitesInfo,
        allStudiesInfo
    };
};

// Ensure context.log has error/info/warn helpers in all environments
const ensureContextLogger = (context) => {
    if (!context) return;
    
    // Ensure the base log function exists
    if (typeof context.log !== 'function') {
        context.log = (...args) => console.log(...args);
    }

    // Explicitly ensure 'info', 'warn', and 'error' are functions
    ['info', 'warn', 'error'].forEach(level => {
        if (typeof context.log[level] !== 'function') {
            context.log[level] = (...args) => {
                const method = level === 'error' ? 'error' : 'log';
                console[method](`[${level.toUpperCase()}]`, ...args);
            };
        }
    });
};

// Helper function to handle errors
const handleError = (context, error, message) => {
    ensureContextLogger(context);
    const rawMessage = (typeof error?.message === 'string' && error.message.trim() !== '')
        ? error.message
        : (typeof error === 'string' && error.trim() !== '' ? error : 'Unknown error');
    const errorStack = (typeof error?.stack === 'string' && error.stack.trim() !== '')
        ? error.stack
        : "No stack trace";

    const logIt = (level, ...args) => {
        if (context?.log && typeof context.log[level] === 'function') {
            context.log[level](...args);
        } else {
            const fallback = level === 'error' ? console.error : console.log;
            fallback(...args);
        }
    };

    logIt('error', `${message}:`, rawMessage);
    logIt('error', `Stack:`, errorStack);
    if (error && typeof error === 'object' && Object.keys(error).length > 0) {
        logIt('error', `Error object:`, safeStringify(error));
    }

    let errorMessage;
    const errorDetail = rawMessage;

    if (rawMessage.includes('COSMOS_DB_CONFIG_MISSING')) {
        errorMessage = "API Configuration Error: Database secrets not set in Azure Configuration.";
    } else if (rawMessage.includes('VALIDATION_ERROR')) {
        errorMessage = rawMessage.replace('VALIDATION_ERROR: ', '');
    } else {
        errorMessage = "Internal Server Error during data processing.";
    }

    return {
        status: 500,
        jsonBody: { 
            error: errorMessage,
            // Add detailed error information for debugging
            detail: errorDetail,
            stack: errorStack,
            originalMessage: message
        },
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    };
};

// Helper to get ID from V4 route parameter
const getIdFromRequest = (request) => {
    return request.params.id;
};

// Safely stringify objects (especially Error instances) for logging without throwing
const safeStringify = (value, space = 2) => {
    try {
        if (value instanceof Error) {
            const plainError = {};
            Object.getOwnPropertyNames(value).forEach((key) => {
                plainError[key] = value[key];
            });
            return JSON.stringify(plainError, null, space);
        }
        return JSON.stringify(value, null, space);
    } catch (stringifyError) {
        return `<<Unable to stringify value: ${stringifyError.message}>>`;
    }
};

// =================================================================================
// SCHEMA VALIDATION FUNCTIONS
// =================================================================================

const validateStudiesSchema = (data) => {
    const errors = [];
    
    console.log('Validating study data:', safeStringify(data));
    
    // CHAOS-created Training: minimal validation (title required; siteIds, siteRoleRequirements, visitRoleRequirements optional)
    if (data.studyType === 'training' && data.source === 'CHAOS') {
        if (!data.title || typeof data.title !== 'string') {
            errors.push('title is required and must be a string');
        }
        if (data.siteIds !== undefined && !Array.isArray(data.siteIds)) {
            errors.push('siteIds must be an array');
        }
        if (data.siteRoleRequirements !== undefined && (typeof data.siteRoleRequirements !== 'object' || data.siteRoleRequirements === null)) {
            errors.push('siteRoleRequirements must be an object');
        }
        if (data.visitRoleRequirements !== undefined && (typeof data.visitRoleRequirements !== 'object' || data.visitRoleRequirements === null)) {
            errors.push('visitRoleRequirements must be an object');
        }
        if (errors.length > 0) {
            console.error('Study validation errors (Training):', errors);
            throw new Error(`VALIDATION_ERROR: Studies validation failed: ${errors.join(', ')}`);
        }
        console.log('Study validation passed (Training)');
        return true;
    }
    
    // CHAOS-configured study (has requiredRoles or visitRoleRequirements): minimal validation so edits always save
    const hasChaosConfig = (data.requiredRoles && Array.isArray(data.requiredRoles)) || (data.visitRoleRequirements && typeof data.visitRoleRequirements === 'object' && data.visitRoleRequirements !== null);
    if (hasChaosConfig) {
        const nameOrTitle = (data.title || data.name || '').toString().trim();
        if (!nameOrTitle) {
            errors.push('title or name is required');
        }
        if (data.requiredRoles !== undefined && !Array.isArray(data.requiredRoles)) {
            errors.push('requiredRoles must be an array');
        }
        if (data.siteIds !== undefined && !Array.isArray(data.siteIds)) {
            errors.push('siteIds must be an array');
        }
        if (data.siteRoleRequirements !== undefined && (typeof data.siteRoleRequirements !== 'object' || data.siteRoleRequirements === null)) {
            errors.push('siteRoleRequirements must be an object');
        }
        if (data.visitRoleRequirements !== undefined && (typeof data.visitRoleRequirements !== 'object' || data.visitRoleRequirements === null)) {
            errors.push('visitRoleRequirements must be an object');
        }
        if (errors.length > 0) {
            console.error('Study validation errors (CHAOS-configured):', errors);
            throw new Error(`VALIDATION_ERROR: Studies validation failed: ${errors.join(', ')}`);
        }
        console.log('Study validation passed (CHAOS-configured minimal)');
        return true;
    }
    
    const isChaosFormat = data.name && data.color && (data.requiredRoles || data.sites);
    console.log('Is CHAOS format:', isChaosFormat);
    
    if (isChaosFormat) {
        // CHAOS format validation
        if (!data.name || typeof data.name !== 'string') {
            errors.push('name is required and must be a string');
        }
        
        if (data.title && typeof data.title !== 'string') {
            errors.push('title must be a string');
        }
        
        if (data.color && typeof data.color !== 'string') {
            errors.push('color must be a string');
        }
        
        if (data.requiredRoles && !Array.isArray(data.requiredRoles)) {
            errors.push('requiredRoles must be an array');
        }
        
        if (data.sites && !Array.isArray(data.sites)) {
            errors.push('sites must be an array');
        }
        
        if (data.siteRoleRequirements && typeof data.siteRoleRequirements !== 'object') {
            errors.push('siteRoleRequirements must be an object');
        }
        
        if (data.description && typeof data.description !== 'string') {
            errors.push('description must be a string');
        }
        
        // Allow both CHAOS and ARTEMIS status (studies from ARTEMIS can be configured in CHAOS)
        const allowedStatus = ['active', 'inactive', 'completed', 'suspended', 'recruiting', 'enrolling'];
        if (data.status && !allowedStatus.includes((data.status + '').toLowerCase())) {
            errors.push('status must be one of: active, inactive, completed, suspended, recruiting, enrolling');
        }
        
        if (data.phase && typeof data.phase !== 'string') {
            errors.push('phase must be a string');
        }
        
        if (data.lastUpdated && typeof data.lastUpdated !== 'string') {
            errors.push('lastUpdated must be a string');
        }
    } else {
        // ARTEMIS/NASA format validation
        if (!data.title || typeof data.title !== 'string') {
            errors.push('title is required and must be a string');
        }
        
        if (data.protocolNumber && typeof data.protocolNumber !== 'string') {
            errors.push('protocolNumber must be a string');
        }
        
        if (data.target !== undefined && (typeof data.target !== 'number' || data.target < 0)) {
            errors.push('target must be a non-negative number');
        }
        
        if (data.status && !['Recruiting', 'Enrolling', 'Active', 'Completed', 'Suspended'].includes(data.status)) {
            errors.push('status must be one of: Recruiting, Enrolling, Active, Completed, Suspended');
        }
        
        if (data.indication && !Array.isArray(data.indication)) {
            errors.push('indication must be an array');
        }
        
        if (data.siteIds && !Array.isArray(data.siteIds)) {
            errors.push('siteIds must be an array');
        }
        
        if (data.washoutDays !== undefined && (typeof data.washoutDays !== 'number' || data.washoutDays < 0)) {
            errors.push('washoutDays must be a non-negative number');
        }
        
        if (data.siteEnrollmentGoals && typeof data.siteEnrollmentGoals !== 'object') {
            errors.push('siteEnrollmentGoals must be an object');
        }
        
        if (data.startDate && typeof data.startDate !== 'string') {
            errors.push('startDate must be a string');
        }
        
        if (data.endDate && typeof data.endDate !== 'string') {
            errors.push('endDate must be a string');
        }
        
        if (data.fpfv && typeof data.fpfv !== 'string') {
            errors.push('fpfv must be a string');
        }
        
        if (data.lplv && typeof data.lplv !== 'string') {
            errors.push('lplv must be a string');
        }
    }
    
    if (errors.length > 0) {
        console.error('Study validation errors:', errors);
        throw new Error(`VALIDATION_ERROR: Studies validation failed: ${errors.join(', ')}`);
    }
    
    console.log('Study validation passed');
    return true;
};

const validateSitesSchema = (data) => {
    const errors = [];
    
    if (!data.name || typeof data.name !== 'string') {
        errors.push('name is required and must be a string');
    }
    
    if (data.siteNameAbbreviation && typeof data.siteNameAbbreviation !== 'string') {
        errors.push('siteNameAbbreviation must be a string');
    }
    
    if (data.address1 && typeof data.address1 !== 'string') {
        errors.push('address1 must be a string');
    }
    
    if (data.address2 && typeof data.address2 !== 'string') {
        errors.push('address2 must be a string');
    }
    
    if (data.city && typeof data.city !== 'string') {
        errors.push('city must be a string');
    }
    
    if (data.state && typeof data.state !== 'string') {
        errors.push('state must be a string');
    }
    
    if (data.zipCode && typeof data.zipCode !== 'string') {
        errors.push('zipCode must be a string');
    }
    
    if (data.country && typeof data.country !== 'string') {
        errors.push('country must be a string');
    }
    
    if (data.pi && typeof data.pi !== 'string') {
        errors.push('pi must be a string');
    }
    
    if (data.piEmail && typeof data.piEmail !== 'string') {
        errors.push('piEmail must be a string');
    }
    
    if (data.siteCoordinator && typeof data.siteCoordinator !== 'string') {
        errors.push('siteCoordinator must be a string');
    }
    
    if (data.siteCoordinatorEmail && typeof data.siteCoordinatorEmail !== 'string') {
        errors.push('siteCoordinatorEmail must be a string');
    }
    
    if (data.indication && !Array.isArray(data.indication)) {
        errors.push('indication must be an array');
    }
    
    if (data.status && !['Active', 'Inactive', 'Suspended'].includes(data.status)) {
        errors.push('status must be one of: Active, Inactive, Suspended');
    }
    
    if (data.latitude !== undefined && (typeof data.latitude !== 'number' || data.latitude < -90 || data.latitude > 90)) {
        errors.push('latitude must be a number between -90 and 90');
    }
    
    if (data.longitude !== undefined && (typeof data.longitude !== 'number' || data.longitude < -180 || data.longitude > 180)) {
        errors.push('longitude must be a number between -180 and 180');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Sites validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validatePatientsSchema = (data) => {
    const errors = [];
    
    if (!data.firstName || typeof data.firstName !== 'string') {
        errors.push('firstName is required and must be a string');
    }
    
    if (!data.lastName || typeof data.lastName !== 'string') {
        errors.push('lastName is required and must be a string');
    }
    
    if (data.globalId && typeof data.globalId !== 'string') {
        errors.push('globalId must be a string');
    }
    
    if (data.phoneNumber && typeof data.phoneNumber !== 'string') {
        errors.push('phoneNumber must be a string');
    }
    
    if (data.email && typeof data.email !== 'string') {
        errors.push('email must be a string');
    }
    
    if (data.dob && typeof data.dob !== 'string') {
        errors.push('dob must be a string');
    }
    
    if (data.address && typeof data.address !== 'string') {
        errors.push('address must be a string');
    }
    
    if (data.city && typeof data.city !== 'string') {
        errors.push('city must be a string');
    }
    
    if (data.state && typeof data.state !== 'string') {
        errors.push('state must be a string');
    }
    
    if (data.zipCode && typeof data.zipCode !== 'string') {
        errors.push('zipCode must be a string');
    }
    
    if (data.age !== undefined && (typeof data.age !== 'number' || data.age < 0 || data.age > 150)) {
        errors.push('age must be a number between 0 and 150');
    }
    
    if (data.condition && typeof data.condition !== 'string') {
        errors.push('condition must be a string');
    }
    
    if (data.status && !['Candidate', 'Pre-Screening', 'Enrolled', 'Screen Fail', 'Completed'].includes(data.status)) {
        errors.push('status must be one of: Candidate, Pre-Screening, Enrolled, Screen Fail, Completed');
    }
    
    if (data.registryStatus && !['Active', 'Inactive'].includes(data.registryStatus)) {
        errors.push('registryStatus must be one of: Active, Inactive');
    }
    
    if (data.source && typeof data.source !== 'string') {
        errors.push('source must be a string');
    }
    
    if (data.therapeuticArea && typeof data.therapeuticArea !== 'string') {
        errors.push('therapeuticArea must be a string');
    }
    
    if (data.studyId && typeof data.studyId !== 'string') {
        errors.push('studyId must be a string');
    }
    
    if (data.siteId && typeof data.siteId !== 'string') {
        errors.push('siteId must be a string');
    }
    
    if (data.appointment && typeof data.appointment !== 'object') {
        errors.push('appointment must be an object');
    }
    
    if (data.surveyResults && !Array.isArray(data.surveyResults)) {
        errors.push('surveyResults must be an array');
    }
    
    if (data.contactLogs && !Array.isArray(data.contactLogs)) {
        errors.push('contactLogs must be an array');
    }
    
    if (data.studyHistory && !Array.isArray(data.studyHistory)) {
        errors.push('studyHistory must be an array');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Patients validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateCrcsSchema = (data) => {
    const errors = [];
    
    if (!data.name || typeof data.name !== 'string') {
        errors.push('name is required and must be a string');
    }
    
    if (data.title && typeof data.title !== 'string') {
        errors.push('title must be a string');
    }
    
    if (data.region && typeof data.region !== 'string') {
        errors.push('region must be a string');
    }
    
    if (data.capabilities && !Array.isArray(data.capabilities)) {
        errors.push('capabilities must be an array');
    }
    
    if (data.trainingLevel && typeof data.trainingLevel !== 'string') {
        errors.push('trainingLevel must be a string');
    }
    
    if (data.coordinates && typeof data.coordinates !== 'object') {
        errors.push('coordinates must be an object');
    }
    
    if (data.employmentType && !['FTE', 'PTE', 'Contractor'].includes(data.employmentType)) {
        errors.push('employmentType must be one of: FTE, PTE, Contractor');
    }
    
    if (data.homeLocation && typeof data.homeLocation !== 'string') {
        errors.push('homeLocation must be a string');
    }
    
    if (data.trainings && !Array.isArray(data.trainings)) {
        errors.push('trainings must be an array');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: CRCs validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateEventsSchema = (data) => {
    if (!data || typeof data !== 'object') {
        throw new Error('VALIDATION_ERROR: Events validation failed: payload must be an object');
    }

    const errors = [];

    const ensureStringField = (fieldName) => {
        if (data[fieldName] === undefined || data[fieldName] === null) return;
        if (typeof data[fieldName] !== 'string') {
            errors.push(`${fieldName} must be a string`);
        } else if (fieldName === 'type' && data[fieldName].trim() === '') {
            errors.push('type is required and must be a non-empty string');
        }
    };

    const ensureDateField = (fieldName) => {
        if (data[fieldName] === undefined || data[fieldName] === null) return;
        if (typeof data[fieldName] !== 'string' || data[fieldName].trim() === '') {
            errors.push(`${fieldName} must be a non-empty string`);
            return;
        }
        if (Number.isNaN(Date.parse(data[fieldName]))) {
            errors.push(`${fieldName} must be a valid date string`);
        }
    };

    const normalizeNumberField = (fieldName) => {
        if (data[fieldName] === undefined || data[fieldName] === null || data[fieldName] === '') return;
        if (typeof data[fieldName] === 'string') {
            const parsed = Number(data[fieldName]);
            if (Number.isNaN(parsed)) {
                errors.push(`${fieldName} must be a number`);
                return;
            }
            data[fieldName] = parsed;
        } else if (typeof data[fieldName] !== 'number' || !Number.isFinite(data[fieldName])) {
            errors.push(`${fieldName} must be a number`);
        }
    };

    const ensureStringArray = (fieldName) => {
        if (data[fieldName] === undefined || data[fieldName] === null) return;
        if (Array.isArray(data[fieldName])) {
            data[fieldName].forEach((value, index) => {
                if (typeof value !== 'string' || value.trim() === '') {
                    errors.push(`${fieldName}[${index}] must be a non-empty string`);
                }
            });
        } else if (typeof data[fieldName] === 'string' && data[fieldName].trim() !== '') {
            data[fieldName] = [data[fieldName]];
        } else {
            errors.push(`${fieldName} must be an array of strings`);
        }
    };

    if (!data.type || typeof data.type !== 'string' || data.type.trim() === '') {
        errors.push('type is required and must be a non-empty string');
    }

    const hasDate = Object.prototype.hasOwnProperty.call(data, 'date');
    const hasStartDate = Object.prototype.hasOwnProperty.call(data, 'startDate');
    const hasEndDate = Object.prototype.hasOwnProperty.call(data, 'endDate');

    if (!hasDate && !hasStartDate && !hasEndDate) {
        errors.push('an event must include date or startDate/endDate');
    }

    ensureDateField('date');
    ensureDateField('startDate');
    ensureDateField('endDate');

    if ((hasStartDate && !hasEndDate) || (!hasStartDate && hasEndDate)) {
        errors.push('startDate and endDate must both be provided together');
    }

    if (hasStartDate && hasEndDate && typeof data.startDate === 'string' && typeof data.endDate === 'string') {
        const startTime = Date.parse(data.startDate);
        const endTime = Date.parse(data.endDate);
        if (!Number.isNaN(startTime) && !Number.isNaN(endTime) && startTime > endTime) {
            errors.push('startDate cannot be after endDate');
        }
    }

    [
        'name',
        'crcId',
        'siteId',
        'studyId',
        'groupId',
        'groupNumber',
        'period',
        'notes',
        'visitNumber',
        'principalInvestigator',
        'truckId',
        'timeOffRequestId',
        'status',
        'createdAt'
    ].forEach(ensureStringField);

    normalizeNumberField('hours');
    normalizeNumberField('mileage');
    normalizeNumberField('numberOfPatients');

    if (data.isOverridden !== undefined && typeof data.isOverridden !== 'boolean') {
        errors.push('isOverridden must be a boolean');
    }

    ensureStringArray('studyIds');
    ensureStringArray('roles');

    if (data.roleAssignments !== undefined && data.roleAssignments !== null) {
        if (typeof data.roleAssignments !== 'object' || Array.isArray(data.roleAssignments)) {
            errors.push('roleAssignments must be an object mapping role IDs to arrays of CRC IDs');
        } else {
            Object.entries(data.roleAssignments).forEach(([roleId, assignments]) => {
                if (!Array.isArray(assignments)) {
                    errors.push(`roleAssignments["${roleId}"] must be an array`);
                    return;
                }
                assignments.forEach((value, index) => {
                    if (value !== null && value !== undefined && typeof value !== 'string') {
                        errors.push(`roleAssignments["${roleId}"][${index}] must be a string or null`);
                    }
                });
            });
        }
    }

    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Events validation failed: ${errors.join(', ')}`);
    }

    return true;
};

const validateRolesSchema = (data) => {
    const errors = [];
    
    if (!data.name || typeof data.name !== 'string') {
        errors.push('name is required and must be a string');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Roles validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateUsersSchema = (data) => {
    const errors = [];
    
    if (!data.username || typeof data.username !== 'string') {
        errors.push('username is required and must be a string');
    }
    
    if (data.password && typeof data.password !== 'string') {
        errors.push('password must be a string');
    }
    
    if (data.permissionLevel && !['Manager', 'Supervisor', 'CRC'].includes(data.permissionLevel)) {
        errors.push('permissionLevel must be one of: Manager, Supervisor, CRC');
    }
    
    if (data.entraId && typeof data.entraId !== 'string') {
        errors.push('entraId must be a string');
    }
    
    if (data.email && typeof data.email !== 'string') {
        errors.push('email must be a string');
    }
    
    // active field is optional boolean, defaults to true if not provided
    if (data.active !== undefined && typeof data.active !== 'boolean') {
        errors.push('active must be a boolean');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Users validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

// Simple password hashing (in production, use bcrypt or similar)
const hashPassword = (password) => {
    // Simple hash for now - in production use proper bcrypt
    return Buffer.from(password).toString('base64');
};

const verifyPassword = (password, hash) => {
    return hashPassword(password) === hash;
};

// Helper function to correct admin user permission level
const correctAdminUser = async (user, container, context) => {
    if (!user || !user.username) return user;
    
    const username = (user.username || '').toLowerCase().trim();
    if (username === 'admin') {
        // Admin must always be Manager
        if (user.permissionLevel !== 'Manager') {
            context.log.warn(`Correcting admin user permission level from ${user.permissionLevel} to Manager`);
            user.permissionLevel = 'Manager';
            user.crcId = null; // Remove CRC link
            
            // Save the correction to the database
            try {
                const correctedUser = { ...user, id: user.id };
                await container.items.upsert(correctedUser);
                context.log.info('Admin user permission level corrected in database');
            } catch (error) {
                context.log.error('Failed to save admin user correction:', error);
                // Continue anyway - we'll return the corrected user object
            }
        }
    }
    return user;
};

const validateSchedulesSchema = (data) => {
    const errors = [];
    
    if (!data.siteId || typeof data.siteId !== 'string') {
        errors.push('siteId is required and must be a string');
    }
    
    if (!data.studyId || typeof data.studyId !== 'string') {
        errors.push('studyId is required and must be a string');
    }
    
    if (!data.visit || typeof data.visit !== 'string') {
        errors.push('visit is required and must be a string');
    }
    
    if (!data.slots || !Array.isArray(data.slots)) {
        errors.push('slots is required and must be an array');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Schedules validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateSurveysSchema = (data) => {
    const errors = [];
    
    if (!data.title || typeof data.title !== 'string') {
        errors.push('title is required and must be a string');
    }
    
    if (!data.studyId || typeof data.studyId !== 'string') {
        errors.push('studyId is required and must be a string');
    }
    
    if (!data.questions || !Array.isArray(data.questions)) {
        errors.push('questions is required and must be an array');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Surveys validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateTimeOffRequestsSchema = (data) => {
    const errors = [];
    
    if (!data.crcId || typeof data.crcId !== 'string') {
        errors.push('crcId is required and must be a string');
    }
    
    if (!data.date || typeof data.date !== 'string') {
        errors.push('date is required and must be a string');
    }
    
    if (!data.type || typeof data.type !== 'string') {
        errors.push('type is required and must be a string');
    }
    
    if (data.period && typeof data.period !== 'string') {
        errors.push('period must be a string');
    }
    
    if (data.hours !== undefined && (typeof data.hours !== 'number' || data.hours < 0)) {
        errors.push('hours must be a non-negative number');
    }
    
    if (data.status && !['pending', 'approved', 'rejected', 'cancelled'].includes(data.status)) {
        errors.push('status must be one of: pending, approved, rejected, cancelled');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Time Off Requests validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateTravelSchema = (data) => {
    const errors = [];
    
    if (!data.crcId || typeof data.crcId !== 'string') {
        errors.push('crcId is required and must be a string');
    }
    
    if (!data.date || typeof data.date !== 'string') {
        errors.push('date is required and must be a string');
    }
    
    if (data.flightNumber && typeof data.flightNumber !== 'string') {
        errors.push('flightNumber must be a string');
    }
    
    if (data.origin && typeof data.origin !== 'string') {
        errors.push('origin must be a string');
    }
    
    if (data.destination && typeof data.destination !== 'string') {
        errors.push('destination must be a string');
    }
    
    // Convert empty strings to undefined for cost fields, then validate
    const flightCost = data.flightCost === '' || data.flightCost === null ? undefined : data.flightCost;
    const carRentalCost = data.carRentalCost === '' || data.carRentalCost === null ? undefined : data.carRentalCost;
    const hotelCost = data.hotelCost === '' || data.hotelCost === null ? undefined : data.hotelCost;
    
    // Convert string numbers to numbers
    if (flightCost !== undefined) {
        const num = typeof flightCost === 'string' ? parseFloat(flightCost) : flightCost;
        if (isNaN(num) || num < 0) {
            errors.push('flightCost must be a non-negative number');
        }
    }
    
    if (carRentalCost !== undefined) {
        const num = typeof carRentalCost === 'string' ? parseFloat(carRentalCost) : carRentalCost;
        if (isNaN(num) || num < 0) {
            errors.push('carRentalCost must be a non-negative number');
        }
    }
    
    if (hotelCost !== undefined) {
        const num = typeof hotelCost === 'string' ? parseFloat(hotelCost) : hotelCost;
        if (isNaN(num) || num < 0) {
            errors.push('hotelCost must be a non-negative number');
        }
    }
    
    if (data.status && !['scheduled', 'delayed', 'departed', 'arrived', 'cancelled'].includes(data.status)) {
        errors.push('status must be one of: scheduled, delayed, departed, arrived, cancelled');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Travel validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

// =================================================================================
// BUSINESS LOGIC FUNCTIONS
// =================================================================================

const calculateStudyEnrollment = async (studyId) => {
    try {
        const patientsContainer = getContainer('patients');
        const { resources: patients } = await patientsContainer.items
            .query({
                query: "SELECT * FROM c WHERE c.studyId = @studyId",
                parameters: [{ name: "@studyId", value: studyId }]
            })
            .fetchAll();
        
        return patients.length;
    } catch (error) {
        console.error('Error calculating study enrollment:', error);
        return 0;
    }
};

const validateSiteStudyRelationship = async (siteId, studyId) => {
    try {
        const studiesContainer = getContainer('studies');
        const { resource: study } = await studiesContainer.item(studyId).read();
        
        if (!study) {
            throw new Error('Study not found');
        }
        
        if (!study.siteIds || !study.siteIds.includes(siteId)) {
            throw new Error('Site is not assigned to this study');
        }
        
        return true;
    } catch (error) {
        throw new Error(`Site-Study relationship validation failed: ${error.message}`);
    }
};

// =================================================================================
// ENHANCED CRUD HANDLERS
// =================================================================================

async function crudHandler(context, request, containerName) {
    // CRITICAL: Ensure logger is initialized before ANY logging calls
    ensureContextLogger(context);
    
    let container;
    try {
        container = getContainer(containerName);
    } catch (error) {
        // If we can't even get the container reference, return empty array for travel
        if (containerName === 'travel' && request.method === 'GET') {
            context.log.warn(`Error getting travel container reference, returning empty array. Error: ${error.message}`);
            return { 
                jsonBody: [],
                headers: { 'Content-Type': 'application/json' }
            };
        }
        throw error;
    }
    
    const { method } = request;
    const id = getIdFromRequest(request);

    try {
        switch (method) {
            case 'GET':
                if (id) {
                    try {
                        // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                        const { resource } = await container.item(id, id).read(); 
                        if (!resource) return { status: 404, jsonBody: { error: `${containerName} not found` } };
                        
                        // Auto-migrate legacy events to modern format (safely wrapped)
                        if (containerName === 'events' && resource) {
                            try {
                                const needsMigration = (event) => {
                                    try {
                                        if (!event || typeof event !== 'object') return false;
                                        if (event.studyId && typeof event.studyId === 'string' && (!event.studyIds || !Array.isArray(event.studyIds))) return true;
                                        if (event.crcId && typeof event.crcId === 'string' && (!event.crcIds || !Array.isArray(event.crcIds))) return true;
                                        if (event.roleAssignments && typeof event.roleAssignments === 'object' && !Array.isArray(event.roleAssignments)) {
                                            const hasLegacy = Object.values(event.roleAssignments).some(assignments => {
                                                if (Array.isArray(assignments)) {
                                                    return assignments.some(entry => entry !== null && typeof entry !== 'string');
                                                }
                                                return assignments !== null && typeof assignments !== 'string';
                                            });
                                            if (hasLegacy) return true;
                                        }
                                        if (Array.isArray(event.crcIds) && event.crcIds.some(entry => entry !== null && typeof entry !== 'string')) return true;
                                        return false;
                                    } catch (e) {
                                        return false;
                                    }
                                };
                                
                                if (needsMigration(resource)) {
                                    let normalized;
                                    try {
                                        normalized = JSON.parse(JSON.stringify(resource));
                                    } catch (e) {
                                        normalized = { ...resource };
                                    }
                                    
                                    if (normalized.studyId && typeof normalized.studyId === 'string' && (!normalized.studyIds || !Array.isArray(normalized.studyIds))) {
                                        normalized.studyIds = [normalized.studyId];
                                        delete normalized.studyId;
                                    }
                                    
                                    if (normalized.crcId && typeof normalized.crcId === 'string' && (!normalized.crcIds || !Array.isArray(normalized.crcIds))) {
                                        normalized.crcIds = [normalized.crcId];
                                    }
                                    
                                    const isValidCrcId = (value) => typeof value === 'string' && value.trim() !== '' && value.trim() !== 'SITE_STAFF' && value.trim() !== 'UNASSIGNED';
                                    const extractCrcId = (value) => {
                                        try {
                                            if (typeof value === 'string') return value;
                                            if (value && typeof value === 'object') {
                                                const candidate = value.crcId || value.id || value.userId || value.value || value.key;
                                                if (typeof candidate === 'string') return candidate;
                                            }
                                        } catch (e) {
                                            // Ignore
                                        }
                                        return null;
                                    };
                                    const normalizeRoleAssignments = (roleAssignments) => {
                                        try {
                                            if (!roleAssignments || typeof roleAssignments !== 'object' || Array.isArray(roleAssignments)) return roleAssignments;
                                            const normalized = {};
                                            Object.entries(roleAssignments).forEach(([roleId, assignments]) => {
                                                try {
                                                    if (Array.isArray(assignments)) {
                                                        normalized[roleId] = assignments.map(entry => {
                                                            const id = extractCrcId(entry);
                                                            if (id === 'SITE_STAFF') return 'SITE_STAFF';
                                                            return isValidCrcId(id) ? id : null;
                                                        });
                                                    } else {
                                                        const id = extractCrcId(assignments);
                                                        normalized[roleId] = id === 'SITE_STAFF' ? ['SITE_STAFF'] : (isValidCrcId(id) ? [id] : [null]);
                                                    }
                                                } catch (e) {
                                                    normalized[roleId] = Array.isArray(assignments) ? assignments : [null];
                                                }
                                            });
                                            return normalized;
                                        } catch (e) {
                                            return roleAssignments;
                                        }
                                    };
                                    
                                    if (Array.isArray(normalized.crcIds)) {
                                        normalized.crcIds = normalized.crcIds.map(extractCrcId).filter(id => isValidCrcId(id));
                                    }
                                    
                                    if (normalized.roleAssignments !== undefined) {
                                        normalized.roleAssignments = normalizeRoleAssignments(normalized.roleAssignments);
                                    }
                                    
                                    ['_rid', '_self', '_etag', '_attachments', '_ts'].forEach(k => {
                                        if (k in normalized) delete normalized[k];
                                    });
                                    
                                    container.items.upsert(normalized).catch(err => {
                                        context.log.warn(`Failed to auto-migrate legacy event ${id}:`, err.message);
                                    });
                                    
                                    resource = normalized;
                                    context.log.info(`Auto-migrated legacy event ${id} to modern format`);
                                }
                            } catch (migrationError) {
                                context.log.warn(`Migration failed for event ${id}, using original:`, migrationError.message);
                                // Continue with original resource
                            }
                        }
                        
                        // Normalize Travel Day events to ensure they display correctly (not as open shifts)
                        if (containerName === 'events' && resource && resource.type === 'Travel Day') {
                            // If crcId is missing/null but crcIds array exists, set crcId from first CRC
                            if ((!resource.crcId || resource.crcId === null || resource.crcId === '') && 
                                resource.crcIds && Array.isArray(resource.crcIds) && resource.crcIds.length > 0) {
                                const firstValidCrcId = resource.crcIds.find(id => id && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED');
                                if (firstValidCrcId) {
                                    resource.crcId = firstValidCrcId;
                                }
                            }
                            // Ensure crcIds is an array if crcId exists but crcIds doesn't
                            if (resource.crcId && (!resource.crcIds || !Array.isArray(resource.crcIds))) {
                                resource.crcIds = [resource.crcId];
                            }
                            // CRITICAL: Ensure Travel Day type is preserved and never shows as open shift
                            // If somehow type got lost, restore it
                            if (resource.type !== 'Travel Day') {
                                resource.type = 'Travel Day';
                            }
                            // Remove roleAssignments from Travel Days - they cause them to show as open shifts
                            if (resource.roleAssignments) {
                                delete resource.roleAssignments;
                            }
                        }
                        
                        // For shifts (Site Assignment), also return related Travel Day events on the same date
                        // This helps the frontend show travel day checkboxes
                        if (containerName === 'events' && resource && resource.type === 'Site Assignment' && resource.date) {
                            try {
                                const eventsContainer = getContainer('events');
                                
                                // Collect all CRC IDs assigned to this shift
                                const shiftCrcIds = new Set();
                                
                                // Add crcId if present
                                if (resource.crcId && resource.crcId.trim() !== '' && resource.crcId !== 'SITE_STAFF' && resource.crcId !== 'UNASSIGNED') {
                                    shiftCrcIds.add(resource.crcId);
                                }
                                
                                // Add crcIds array if present
                                if (resource.crcIds && Array.isArray(resource.crcIds)) {
                                    resource.crcIds.forEach(id => {
                                        if (id && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED') {
                                            shiftCrcIds.add(id);
                                        }
                                    });
                                }
                                
                                // Add CRCs from roleAssignments
                                if (resource.roleAssignments && typeof resource.roleAssignments === 'object') {
                                    Object.values(resource.roleAssignments).forEach(assignments => {
                                        if (Array.isArray(assignments)) {
                                            assignments.forEach(crcId => {
                                                if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                                    shiftCrcIds.add(crcId);
                                                }
                                            });
                                        }
                                    });
                                }
                                
                                // Query travel days for this date
                                const { resources: relatedEvents } = await eventsContainer.items.query({
                                    query: "SELECT * FROM c WHERE c.type = 'Travel Day' AND c.date = @date",
                                    parameters: [
                                        { name: "@date", value: resource.date }
                                    ]
                                }).fetchAll();
                                
                                // Filter travel days to only those that belong to CRCs assigned to this shift
                                const filteredTravelDays = (relatedEvents || []).filter(td => {
                                    if (!td || td.type !== 'Travel Day') return false;
                                    
                                    // Check if travel day's crcId matches any shift CRC
                                    if (td.crcId && shiftCrcIds.has(td.crcId)) return true;
                                    
                                    // Check if travel day's crcIds array contains any shift CRC
                                    if (td.crcIds && Array.isArray(td.crcIds)) {
                                        return td.crcIds.some(id => shiftCrcIds.has(id));
                                    }
                                    
                                    return false;
                                });
                                
                                // Add related travel days to the response
                                if (filteredTravelDays.length > 0) {
                                    // Normalize travel days
                                    const normalizedTravelDays = filteredTravelDays.map(td => {
                                        if (td.type === 'Travel Day') {
                                            if ((!td.crcId || td.crcId === null || td.crcId === '') && 
                                                td.crcIds && Array.isArray(td.crcIds) && td.crcIds.length > 0) {
                                                const firstValidCrcId = td.crcIds.find(id => id && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED');
                                                if (firstValidCrcId) {
                                                    td.crcId = firstValidCrcId;
                                                }
                                            }
                                            if (td.crcId && (!td.crcIds || !Array.isArray(td.crcIds))) {
                                                td.crcIds = [td.crcId];
                                            }
                                            if (td.roleAssignments) {
                                                delete td.roleAssignments;
                                            }
                                        }
                                        return td;
                                    });
                                    
                                    resource.relatedTravelDays = normalizedTravelDays;
                                }
                            } catch (relatedError) {
                                // If we can't fetch related events, continue without them
                                context.log.warn(`Could not fetch related travel days for shift ${resource.id}: ${relatedError.message}`);
                            }
                        }
                        
                        return { jsonBody: resource };
                    } catch (error) {
                        // If container doesn't exist, return 404
                        if (error.code === 404 || error.message.includes('NotFound')) {
                            return { status: 404, jsonBody: { error: `${containerName} not found` } };
                        }
                        throw error;
                    }
                } else {
                    try {
                        const { resources } = await container.items.readAll().fetchAll();
                        
                        // Auto-migrate legacy events to modern format (safely, don't crash on errors)
                        // DISABLED for list GET - too many events, causes timeout. Migration happens on single GET and PUT instead.
                        if (false && containerName === 'events' && Array.isArray(resources) && resources.length > 0) {
                            try {
                                const needsMigration = (event) => {
                                    try {
                                        if (!event || typeof event !== 'object') return false;
                                        if (event.studyId && typeof event.studyId === 'string' && (!event.studyIds || !Array.isArray(event.studyIds))) return true;
                                        if (event.crcId && typeof event.crcId === 'string' && (!event.crcIds || !Array.isArray(event.crcIds))) return true;
                                        if (event.roleAssignments && typeof event.roleAssignments === 'object' && !Array.isArray(event.roleAssignments)) {
                                            const hasLegacy = Object.values(event.roleAssignments).some(assignments => {
                                                if (Array.isArray(assignments)) {
                                                    return assignments.some(entry => entry !== null && typeof entry !== 'string');
                                                }
                                                return assignments !== null && typeof assignments !== 'string';
                                            });
                                            if (hasLegacy) return true;
                                        }
                                        if (Array.isArray(event.crcIds) && event.crcIds.some(entry => entry !== null && typeof entry !== 'string')) return true;
                                        return false;
                                    } catch (e) {
                                        return false; // If check fails, don't migrate
                                    }
                                };
                                
                                const isValidCrcId = (value) => typeof value === 'string' && value.trim() !== '' && value.trim() !== 'SITE_STAFF' && value.trim() !== 'UNASSIGNED';
                                const extractCrcId = (value) => {
                                    try {
                                        if (typeof value === 'string') return value;
                                        if (value && typeof value === 'object') {
                                            const candidate = value.crcId || value.id || value.userId || value.value || value.key;
                                            if (typeof candidate === 'string') return candidate;
                                        }
                                    } catch (e) {
                                        // Ignore
                                    }
                                    return null;
                                };
                                const normalizeRoleAssignments = (roleAssignments) => {
                                    try {
                                        if (!roleAssignments || typeof roleAssignments !== 'object' || Array.isArray(roleAssignments)) return roleAssignments;
                                        const normalized = {};
                                        Object.entries(roleAssignments).forEach(([roleId, assignments]) => {
                                            try {
                                                if (Array.isArray(assignments)) {
                                                    normalized[roleId] = assignments.map(entry => {
                                                        const id = extractCrcId(entry);
                                                        if (id === 'SITE_STAFF') return 'SITE_STAFF';
                                                        return isValidCrcId(id) ? id : null;
                                                    });
                                                } else {
                                                    const id = extractCrcId(assignments);
                                                    normalized[roleId] = id === 'SITE_STAFF' ? ['SITE_STAFF'] : (isValidCrcId(id) ? [id] : [null]);
                                                }
                                            } catch (e) {
                                                normalized[roleId] = Array.isArray(assignments) ? assignments : [null];
                                            }
                                        });
                                        return normalized;
                                    } catch (e) {
                                        return roleAssignments; // Return original on error
                                    }
                                };
                                
                                const migratedEvents = [];
                                const normalizedResources = resources.map(event => {
                                    try {
                                        if (!needsMigration(event)) return event;
                                        
                                        // Use safer cloning
                                        let normalized;
                                        try {
                                            normalized = JSON.parse(JSON.stringify(event));
                                        } catch (e) {
                                            // If JSON clone fails, use shallow copy
                                            normalized = { ...event };
                                        }
                                        
                                        if (normalized.studyId && typeof normalized.studyId === 'string' && (!normalized.studyIds || !Array.isArray(normalized.studyIds))) {
                                            normalized.studyIds = [normalized.studyId];
                                            delete normalized.studyId;
                                        }
                                        if (normalized.crcId && typeof normalized.crcId === 'string' && (!normalized.crcIds || !Array.isArray(normalized.crcIds))) {
                                            normalized.crcIds = [normalized.crcId];
                                        }
                                        if (Array.isArray(normalized.crcIds)) {
                                            normalized.crcIds = normalized.crcIds.map(extractCrcId).filter(id => isValidCrcId(id));
                                        }
                                        if (normalized.roleAssignments !== undefined) {
                                            normalized.roleAssignments = normalizeRoleAssignments(normalized.roleAssignments);
                                        }
                                        ['_rid', '_self', '_etag', '_attachments', '_ts'].forEach(k => {
                                            if (k in normalized) delete normalized[k];
                                        });
                                        
                                        migratedEvents.push(normalized);
                                        return normalized;
                                    } catch (e) {
                                        context.log.warn(`Error migrating event ${event?.id || 'unknown'}:`, e.message);
                                        return event; // Return original on error
                                    }
                                });
                                
                                // Save migrated events asynchronously (don't wait, don't crash)
                                if (migratedEvents.length > 0) {
                                    context.log.info(`Auto-migrating ${migratedEvents.length} legacy events to modern format`);
                                    Promise.all(migratedEvents.map(event => 
                                        container.items.upsert(event).catch(err => 
                                            context.log.warn(`Failed to auto-migrate legacy event ${event?.id || 'unknown'}:`, err.message)
                                        )
                                    )).catch(() => {
                                        // Ignore batch errors
                                    });
                                }
                                
                                // Normalize Travel Day events to ensure they display correctly (not as open shifts)
                                const hasTravelDays = normalizedResources.some(e => e && e.type === 'Travel Day');
                                if (hasTravelDays) {
                                    const finalResources = normalizedResources.map(event => {
                                        try {
                                            if (event && event.type === 'Travel Day') {
                                                event.type = 'Travel Day';
                                                if ((!event.crcId || event.crcId === null || event.crcId === '') && 
                                                    event.crcIds && Array.isArray(event.crcIds) && event.crcIds.length > 0) {
                                                    const firstValidCrcId = event.crcIds.find(id => id && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED');
                                                    if (firstValidCrcId) event.crcId = firstValidCrcId;
                                                }
                                                if (event.crcId && (!event.crcIds || !Array.isArray(event.crcIds))) {
                                                    event.crcIds = [event.crcId];
                                                }
                                                if (event.roleAssignments) delete event.roleAssignments;
                                            }
                                        } catch (e) {
                                            // Ignore per-event errors
                                        }
                                        return event;
                                    });
                                    return { jsonBody: finalResources };
                                }
                                
                                return { jsonBody: normalizedResources };
                            } catch (migrationError) {
                                // If migration fails, just return original resources - don't crash
                                context.log.warn(`Migration failed, returning original resources:`, migrationError.message);
                                // Fall through to return original resources
                            }
                        }
                        return { jsonBody: resources };
                    } catch (error) {
                        // If container doesn't exist yet, return empty array
                        // Cosmos DB errors can have different formats:
                        // - error.code === 404
                        // - error.statusCode === 404
                        // - error.message includes 'NotFound', 'Container', or 'not found'
                        const errorCode = error.code || error.statusCode;
                        const errorMessage = (error.message || '').toLowerCase();
                        
                        // For travel and announcements containers, always return empty array on any error
                        // This prevents launch failures
                        if (containerName === 'travel' || containerName === 'announcements') {
                            context.log.warn(`${containerName} container does not exist yet or error occurred, returning empty array. Error: ${error.message}`);
                            return { 
                                jsonBody: [],
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                        
                        if (errorCode === 404 || 
                            errorCode === 400 ||
                            errorMessage.includes('notfound') || 
                            errorMessage.includes('not found') ||
                            errorMessage.includes('container') ||
                            errorMessage.includes('does not exist') ||
                            errorMessage.includes('bad request')) {
                            context.log.warn(`Container '${containerName}' does not exist yet, returning empty array`);
                            return { 
                                jsonBody: [],
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                        
                        // Log the actual error for debugging
                        context.log.error(`Error reading from container '${containerName}':`, error);
                        context.log.error(`Error code: ${errorCode}, message: ${errorMessage}`);
                        throw error;
                    }
                }
            
            case 'POST':
                const body = await request.json();
                let extraTravelEvents = [];
                
                // For events, validate that we're not creating N/A entries and prevent overriding training
                if (containerName === 'events') {
                    // Variable to hold extra events if we need to split Group/Range Travel Days
                    extraTravelEvents = [];
                    
                    // Prevent creating overridden training events
                    // Check if this is a training event and prevent isOverridden from being set
                    if (body.studyId) {
                        try {
                            const studiesContainer = getContainer('studies');
                            const { resource: study } = await studiesContainer.item(body.studyId, body.studyId).read();
                            if (study && study.studyType === 'training') {
                                if (body.isOverridden === true) {
                                    return {
                                        status: 400,
                                        jsonBody: { 
                                            error: 'Cannot override training events',
                                            message: 'Training events cannot be overridden. Please contact an administrator if changes are needed.'
                                        },
                                        headers: { 'Content-Type': 'application/json' }
                                    };
                                }
                                // Remove isOverridden if it's set
                                if (body.isOverridden !== undefined) {
                                    delete body.isOverridden;
                                }
                            }
                        } catch (studyError) {
                            // If we can't read the study, log but continue (don't block creation)
                            context.log.warn(`Could not read study ${body.studyId} to check if training:`, studyError.message);
                        }
                    }
                    
                    // Also check if the event type itself indicates training
                    const eventType = String(body.type || '').toLowerCase().trim();
                    if (eventType === 'training' || eventType.includes('training')) {
                        if (body.isOverridden === true) {
                            return {
                                status: 400,
                                jsonBody: { 
                                    error: 'Cannot override training events',
                                    message: 'Training events cannot be overridden. Please contact an administrator if changes are needed.'
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                        if (body.isOverridden !== undefined) {
                            delete body.isOverridden;
                        }
                    }
                    // 1. FIRST: Normalize type based on isTravelDay flag
                    // Check for isTravelDay flag - this is the most reliable indicator
                    const isTravelDayFlag = body.isTravelDay === true || body.isTravelDay === 'true' || body.travelDay === true;
                    const isTravelDayType = body.type === 'Travel Day' || body.type === 'travel day' || body.type === 'travel';
                    
                    context.log.info(`[TRAVEL DEBUG] Initial body check: type=${body.type}, isTravelDay=${body.isTravelDay}, travelDay=${body.travelDay}, crcId=${body.crcId}, crcIds=${JSON.stringify(body.crcIds)}, roleAssignments=${JSON.stringify(body.roleAssignments)}`);
                    
                    if (isTravelDayFlag || isTravelDayType || 
                        (body.type === 'Site Assignment' && body.isTravelDay === true)) {
                        body.type = 'Travel Day';
                        context.log.info(`[TRAVEL DEBUG] Normalized type to Travel Day`);
                        
                        // Collect CRCs from multiple sources: crcIds, crcId, and roleAssignments
                        const allCrcIds = new Set();
                        
                        // Source 1: Existing crcIds array from frontend
                        if (body.crcIds && Array.isArray(body.crcIds)) {
                            body.crcIds.forEach(id => {
                                if (id && typeof id === 'string' && id.trim() !== '' && id !== 'UNASSIGNED' && id !== 'SITE_STAFF') {
                                    allCrcIds.add(id.trim());
                                }
                            });
                            context.log.info(`[TRAVEL DEBUG] Found ${allCrcIds.size} CRCs from crcIds array`);
                        }
                        
                        // Source 2: Single crcId 
                        if (body.crcId && typeof body.crcId === 'string' && body.crcId.trim() !== '' && body.crcId !== 'UNASSIGNED' && body.crcId !== 'SITE_STAFF') {
                            allCrcIds.add(body.crcId.trim());
                            context.log.info(`[TRAVEL DEBUG] Added crcId: ${body.crcId}`);
                        }
                        
                        // Source 3: Extract from roleAssignments (recursive to handle any structure)
                        if (body.roleAssignments) {
                            const extractIds = (val) => {
                                if (!val) return;
                                if (Array.isArray(val)) {
                                    val.forEach(item => extractIds(item));
                                } else if (typeof val === 'object') {
                                    Object.values(val).forEach(item => extractIds(item));
                                } else if (typeof val === 'string') {
                                    const cleanId = val.trim();
                                    if (cleanId !== '' && cleanId !== 'UNASSIGNED' && cleanId !== 'SITE_STAFF') {
                                        allCrcIds.add(cleanId);
                                    }
                                }
                            };
                            extractIds(body.roleAssignments);
                            context.log.info(`[TRAVEL DEBUG] Extracted CRCs from roleAssignments, total now: ${allCrcIds.size}`);
                            
                            // Remove roleAssignments from Travel Days - they don't need them
                            delete body.roleAssignments;
                        }
                        
                        // Set the consolidated crcIds
                        body.crcIds = Array.from(allCrcIds);
                        if (body.crcIds.length > 0 && (!body.crcId || body.crcId.trim() === '')) {
                            body.crcId = body.crcIds[0];
                        }
                        
                        context.log.info(`[TRAVEL DEBUG] Final CRC collection: ${JSON.stringify(body.crcIds)} (${body.crcIds.length} CRCs)`);
                    }

                    // 2. SECOND: Now that type is normalized, run the "Double Explosion" logic
                    // This handles splitting Multiple CRCs AND Date Ranges into individual daily events
                    if (body.type === 'Travel Day') {
                        // DEBUG: Log incoming Travel Day data
                        context.log.info(`[TRAVEL DEBUG] Incoming body: crcId=${body.crcId}, crcIds=${JSON.stringify(body.crcIds)}, date=${body.date}, startDate=${body.startDate}, endDate=${body.endDate}`);
                        
                        const validCrcIds = (body.crcIds || []).filter(id => id && typeof id === 'string' && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED');
                        
                        context.log.info(`[TRAVEL DEBUG] Valid CRC IDs after filter: ${JSON.stringify(validCrcIds)} (count: ${validCrcIds.length})`);
                        
                        // Calculate all dates in the range
                        // IMPORTANT: Always prefer startDate/endDate over date for range calculation
                        const dates = [];
                        const hasDateRange = body.startDate && body.endDate && body.startDate !== body.endDate;
                        
                        if (hasDateRange) {
                            context.log.info(`[TRAVEL DEBUG] Processing date RANGE: ${body.startDate} to ${body.endDate}`);
                            let curr = new Date(body.startDate + 'T00:00:00'); // Force local time
                            const last = new Date(body.endDate + 'T00:00:00');
                            // Safety: Cap at 60 days to prevent infinite loops on bad data
                            let safety = 0; 
                            while (curr <= last && safety < 60) {
                                dates.push(curr.toISOString().split('T')[0]);
                                curr.setDate(curr.getDate() + 1);
                                safety++;
                            }
                        } else {
                            // Single day - use date field, falling back to startDate
                            const singleDate = body.date || body.startDate;
                            if (singleDate) {
                                dates.push(singleDate);
                            }
                            context.log.info(`[TRAVEL DEBUG] Processing SINGLE date: ${singleDate}`);
                        }
                        
                        context.log.info(`[TRAVEL DEBUG] Final dates array: ${JSON.stringify(dates)} (count: ${dates.length})`);

                        // If we have >1 person OR >1 day, we need to split
                        const needsSplit = (validCrcIds.length > 0 && dates.length > 0) && (validCrcIds.length > 1 || dates.length > 1);
                        context.log.info(`[TRAVEL DEBUG] Needs split? ${needsSplit} (${validCrcIds.length} people x ${dates.length} days)`);
                        
                        if (needsSplit) {
                            // Generate ALL combinations [Person + Day]
                            const allCombinations = [];
                            for (const dateStr of dates) {
                                for (const crcId of validCrcIds) {
                                    allCombinations.push({ date: dateStr, crcId });
                                }
                            }

                            context.log.info(`[TRAVEL DEBUG] Generated ${allCombinations.length} combinations`);

                            if (allCombinations.length > 0) {
                                // Take the FIRST combination for the Main Event
                                const mainParams = allCombinations[0];
                                
                                // Update the main 'body' to match this single day/person
                                body.date = mainParams.date;
                                body.crcId = mainParams.crcId;
                                body.crcIds = [mainParams.crcId];
                                body.startDate = mainParams.date; 
                                body.endDate = mainParams.date;   
                                
                                // Save the REST for the "extras" loop
                                const remaining = allCombinations.slice(1);
                                extraTravelEvents = remaining.map(params => ({
                                    date: params.date,
                                    crcId: params.crcId
                                }));
                                
                                context.log.info(`[TRAVEL DEBUG] EXPLODING Travel Day: Main event for ${mainParams.crcId} on ${mainParams.date}, plus ${extraTravelEvents.length} extra events`);
                            }
                        } else if (validCrcIds.length === 1 && dates.length === 1) {
                            // Single person, single day - no split needed but ensure fields are set
                            context.log.info(`[TRAVEL DEBUG] Single person/day - no split needed`);
                            body.date = dates[0];
                            body.crcId = validCrcIds[0];
                            body.crcIds = [validCrcIds[0]];
                            body.startDate = dates[0];
                            body.endDate = dates[0];
                        }
                    }
                    
                    // Check if this would result in an N/A entry (no CRC assigned and no valid role assignments)
                    const hasCrcId = body.crcId && body.crcId.trim() !== '';
                    const hasCrcIds = body.crcIds && Array.isArray(body.crcIds) && body.crcIds.length > 0 && 
                                      body.crcIds.some(id => id && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED');
                    const hasValidRoleAssignments = body.roleAssignments && 
                        Object.keys(body.roleAssignments).length > 0 &&
                        Object.values(body.roleAssignments).some(assignments => 
                            Array.isArray(assignments) && assignments.some(crcId => crcId && crcId.trim() !== '' && crcId !== 'UNASSIGNED')
                        );
                    
                    // Ensure crcIds array is set if crcId is provided
                    if (body.crcId && (!body.crcIds || !Array.isArray(body.crcIds) || body.crcIds.length === 0)) {
                        body.crcIds = [body.crcId];
                    }
                    // If crcIds is provided but crcId is not, set crcId from first valid CRC
                    if (body.crcIds && Array.isArray(body.crcIds) && body.crcIds.length > 0 && 
                        (!body.crcId || body.crcId.trim() === '')) {
                        const firstValidCrcId = body.crcIds.find(id => id && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED');
                        if (firstValidCrcId) {
                            body.crcId = firstValidCrcId;
                        }
                    }
                    
                    // If it's a Site Assignment and has no CRC and no valid role assignments, it's an Open Shift (allowed)
                    // Travel Day events are also allowed (they should have crcId or crcIds array, but may not have roleAssignments)
                    // Otherwise, if it has no CRC and no valid role assignments, reject it as an N/A entry
                    if (!hasCrcId && !hasCrcIds && !hasValidRoleAssignments) {
                        if (body.type !== 'Site Assignment' && body.type !== 'Open Shift' && body.type !== 'Travel Day') {
                            return {
                                status: 400,
                                jsonBody: { 
                                    error: 'Cannot create event with no CRC assigned and no valid role assignments. This would result in an N/A entry.',
                                    details: 'Events must have either a crcId, crcIds array, or valid roleAssignments with assigned CRCs.'
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                    }
                }
                
                // Normalize cost fields for travel - convert empty strings to undefined
                if (containerName === 'travel') {
                    if (body.flightCost === '' || body.flightCost === null) body.flightCost = undefined;
                    if (body.carRentalCost === '' || body.carRentalCost === null) body.carRentalCost = undefined;
                    if (body.hotelCost === '' || body.hotelCost === null) body.hotelCost = undefined;
                    
                    // Convert string numbers to numbers
                    if (body.flightCost !== undefined && typeof body.flightCost === 'string') {
                        body.flightCost = parseFloat(body.flightCost) || undefined;
                    }
                    if (body.carRentalCost !== undefined && typeof body.carRentalCost === 'string') {
                        body.carRentalCost = parseFloat(body.carRentalCost) || undefined;
                    }
                    if (body.hotelCost !== undefined && typeof body.hotelCost === 'string') {
                        body.hotelCost = parseFloat(body.hotelCost) || undefined;
                    }
                }
                
                // Normalize zip code fields for sites - map zip, postalCode, postal_code to zipCode
                if (containerName === 'sites') {
                    if (body.zip && !body.zipCode) {
                        body.zipCode = body.zip;
                    }
                    if (body.postalCode && !body.zipCode) {
                        body.zipCode = body.postalCode;
                    }
                    if (body.postal_code && !body.zipCode) {
                        body.zipCode = body.postal_code;
                    }
                }
                
                // Validate schema based on container
                try {
                    switch (containerName) {
                        case 'studies':
                            validateStudiesSchema(body);
                            break;
                        case 'sites':
                            validateSitesSchema(body);
                            break;
                        case 'patients':
                            validatePatientsSchema(body);
                            break;
                        case 'crcs':
                            validateCrcsSchema(body);
                            break;
                        case 'events':
                            validateEventsSchema(body);
                            break;
                        case 'roles':
                            validateRolesSchema(body);
                            break;
                        case 'users':
                            validateUsersSchema(body);
                            // Hash password if provided
                            if (body.password) {
                                body.password = hashPassword(body.password);
                            }
                            break;
                        case 'schedules':
                            validateSchedulesSchema(body);
                            // Validate site-study relationship
                            await validateSiteStudyRelationship(body.siteId, body.studyId);
                            break;
                        case 'surveys':
                            validateSurveysSchema(body);
                            break;
                        case 'time-off-requests':
                            validateTimeOffRequestsSchema(body);
                            break;
                        case 'travel':
                            validateTravelSchema(body);
                            break;
                    }
                } catch (validationError) {
                    console.error(`Validation error for ${containerName}:`, validationError.message);
                    return {
                        status: 400,
                        jsonBody: { error: validationError.message },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                
                const newItem = { ...body, id: generateId() };
                try {
                    const { resource: createdItem } = await container.items.create(newItem);

                    // FIX: Create the extra individual events (Dates x People)
                    context.log.info(`[TRAVEL DEBUG] After main create - extraTravelEvents.length = ${extraTravelEvents ? extraTravelEvents.length : 'undefined'}, createdItem.type = ${createdItem ? createdItem.type : 'none'}`);
                    
                    if (containerName === 'events' && extraTravelEvents && extraTravelEvents.length > 0) {
                        context.log.info(`[TRAVEL DEBUG] Creating ${extraTravelEvents.length} extra Travel Day events...`);
                        for (const params of extraTravelEvents) {
                            const extraEvent = {
                                ...createdItem, // Copy base props from main event
                                id: generateId(),
                                type: 'Travel Day', // Ensure type is Travel Day
                                date: params.date,
                                startDate: params.date, // Ensure it's a single day
                                endDate: params.date,   // Ensure it's a single day
                                crcId: params.crcId,
                                crcIds: [params.crcId]
                            };
                            // Clean up system fields
                            ['_rid', '_self', '_etag', '_attachments', '_ts'].forEach(k => delete extraEvent[k]);

                            try {
                                await container.items.create(extraEvent);
                                context.log.info(`[TRAVEL DEBUG] Created extra Travel Day: ${params.date} for ${params.crcId}`);
                            } catch (extraError) {
                                context.log.error(`[TRAVEL DEBUG] Failed to create extra Travel Day:`, extraError);
                            }
                        }
                        context.log.info(`[TRAVEL DEBUG] Finished creating ${extraTravelEvents.length} extra events`);
                    }
                    
                    // Calculate enrollment for studies (non-fatal)
                    if (containerName === 'studies') {
                        try {
                            createdItem.enrolled = await calculateStudyEnrollment(createdItem.id);
                        } catch (e) {
                            context.log.warn('Study enrollment calc failed:', e?.message || e);
                            createdItem.enrolled = 0;
                        }
                    }
                    
                    // For Site Assignment shifts, create travel days from travelDayPreferences
                    if (containerName === 'events' && createdItem && createdItem.type === 'Site Assignment' && createdItem.date && createdItem.travelDayPreferences) {
                        context.log.info(`[TRAVEL PREFS DEBUG] Processing travelDayPreferences for Site Assignment: ${JSON.stringify(createdItem.travelDayPreferences)}`);
                        try {
                            const eventsContainer = getContainer('events');
                            const shiftDate = toDateOnlyString(createdItem.date);
                            const baseStartDate = createdItem.startDate || createdItem.date;
                            const baseEndDate = createdItem.endDate || createdItem.date;
                            
                            context.log.info(`[TRAVEL PREFS DEBUG] Shift dates: date=${shiftDate}, startDate=${baseStartDate}, endDate=${baseEndDate}`);
                            
                            const computeDefaultTravelDates = () => {
                                const startObj = new Date(`${baseStartDate}T00:00:00`);
                                const endObj = new Date(`${baseEndDate}T00:00:00`);
                                if (Number.isNaN(startObj.getTime()) || Number.isNaN(endObj.getTime())) {
                                    return { start: shiftDate, end: shiftDate };
                                }
                                const startTravel = new Date(startObj);
                                startTravel.setDate(startTravel.getDate() - 1);
                                const endTravel = new Date(endObj);
                                endTravel.setDate(endTravel.getDate() + 1);
                                return { start: toDateOnlyString(startTravel), end: toDateOnlyString(endTravel) };
                            };
                            
                            // Collect all CRCs assigned to this shift
                            const shiftCrcIds = new Set();
                            if (createdItem.crcId && createdItem.crcId.trim() !== '' && createdItem.crcId !== 'SITE_STAFF' && createdItem.crcId !== 'UNASSIGNED') {
                                shiftCrcIds.add(createdItem.crcId);
                            }
                            if (createdItem.crcIds && Array.isArray(createdItem.crcIds)) {
                                createdItem.crcIds.forEach(crcId => {
                                    if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                        shiftCrcIds.add(crcId);
                                    }
                                });
                            }
                            if (createdItem.roleAssignments && typeof createdItem.roleAssignments === 'object') {
                                Object.values(createdItem.roleAssignments).forEach(assignments => {
                                    if (Array.isArray(assignments)) {
                                        assignments.forEach(crcId => {
                                            if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                                shiftCrcIds.add(crcId);
                                            }
                                        });
                                    }
                                });
                            }
                            
                            context.log.info(`[TRAVEL PREFS DEBUG] CRCs assigned to shift: ${JSON.stringify([...shiftCrcIds])}`);
                            
                            // Check travelDayPreferences and create travel days for CRCs that have travel checked
                            if (createdItem.travelDayPreferences && typeof createdItem.travelDayPreferences === 'object') {
                                const defaults = computeDefaultTravelDates();
                                context.log.info(`[TRAVEL PREFS DEBUG] Default travel dates: start=${defaults.start}, end=${defaults.end}`);
                                
                                for (const [crcId, prefs] of Object.entries(createdItem.travelDayPreferences)) {
                                    context.log.info(`[TRAVEL PREFS DEBUG] Processing CRC ${crcId}: prefs=${JSON.stringify(prefs)}`);
                                    
                                    if (!crcId || crcId.trim() === '' || crcId === 'SITE_STAFF' || crcId === 'UNASSIGNED') {
                                        context.log.info(`[TRAVEL PREFS DEBUG] Skipping invalid CRC ID: ${crcId}`);
                                        continue;
                                    }
                                    if (!shiftCrcIds.has(crcId)) {
                                        context.log.info(`[TRAVEL PREFS DEBUG] Skipping CRC ${crcId} - not assigned to shift`);
                                        continue;
                                    }
                                    if (prefs && typeof prefs === 'object' && prefs.travelNotNeeded) {
                                        context.log.info(`[TRAVEL PREFS DEBUG] Skipping CRC ${crcId} - travelNotNeeded is true`);
                                        continue;
                                    }
                                    
                                    const includeStart = prefs === true || (prefs && typeof prefs === 'object' && prefs.includeStartTravel === true);
                                    const includeEnd = prefs === true || (prefs && typeof prefs === 'object' && prefs.includeEndTravel === true);
                                    const startDate = (prefs && typeof prefs === 'object' && prefs.startTravelDate) ? prefs.startTravelDate : defaults.start;
                                    const endDate = (prefs && typeof prefs === 'object' && prefs.endTravelDate) ? prefs.endTravelDate : defaults.end;
                                    
                                    context.log.info(`[TRAVEL PREFS DEBUG] CRC ${crcId}: includeStart=${includeStart}, includeEnd=${includeEnd}, startDate=${startDate}, endDate=${endDate}`);
                                    
                                    const datesToCreate = [];
                                    if (includeStart && startDate) datesToCreate.push(startDate);
                                    if (includeEnd && endDate && endDate !== startDate) datesToCreate.push(endDate);
                                    
                                    context.log.info(`[TRAVEL PREFS DEBUG] CRC ${crcId}: Creating travel days for dates: ${JSON.stringify(datesToCreate)}`);
                                    
                                    for (const travelDate of datesToCreate) {
                                        const { resources: allTravelDaysOnDate } = await eventsContainer.items.query({
                                            query: "SELECT * FROM c WHERE c.type = 'Travel Day' AND c.date = @date",
                                            parameters: [
                                                { name: "@date", value: travelDate }
                                            ]
                                        }).fetchAll();
                                        
                                        const existingTravelDay = (allTravelDaysOnDate || []).find(td => {
                                            if (!td || td.type !== 'Travel Day') return false;
                                            if (td.crcId === crcId) return true;
                                            if (td.crcIds && Array.isArray(td.crcIds) && td.crcIds.includes(crcId)) return true;
                                            return false;
                                        });
                                        
                                        if (!existingTravelDay) {
                                            const travelDayEvent = {
                                                id: generateId(),
                                                type: 'Travel Day',
                                                date: travelDate,
                                                startDate: travelDate,  // SINGLE DAY - not a range!
                                                endDate: travelDate,    // SINGLE DAY - not a range!
                                                crcId: crcId,
                                                crcIds: [crcId],
                                                name: 'Travel Day',
                                                siteId: createdItem.siteId || null,
                                                studyIds: Array.isArray(createdItem.studyIds) ? createdItem.studyIds : (createdItem.studyId ? [createdItem.studyId] : [])
                                            };
                                            
                                            Object.keys(travelDayEvent).forEach(key => {
                                                if (travelDayEvent[key] === null || travelDayEvent[key] === undefined) {
                                                    delete travelDayEvent[key];
                                                }
                                            });
                                            
                                            try {
                                                await eventsContainer.items.create(travelDayEvent);
                                                context.log.info(`[TRAVEL PREFS DEBUG] CREATED travel day ${travelDayEvent.id} for CRC ${crcId} on ${travelDate}`);
                                            } catch (createTravelError) {
                                                context.log.error(`[TRAVEL PREFS DEBUG] Failed to create travel day for CRC ${crcId}:`, createTravelError);
                                            }
                                        } else {
                                            context.log.info(`[TRAVEL PREFS DEBUG] Travel day already exists for CRC ${crcId} on ${travelDate}`);
                                        }
                                    }
                                }
                            }
                        } catch (travelDayError) {
                            // Log but don't fail the shift creation if travel day creation fails
                            context.log.warn(`[TRAVEL PREFS DEBUG] Error creating travel days from travelDayPreferences:`, travelDayError.message);
                        }
                    }
                    
                    // Triggered emails: new shift
                    if (containerName === 'events' && createdItem && createdItem.type === 'Site Assignment') {
                        try { await processEmailTriggers(context, { triggerType: 'new_shift', event: createdItem }); } catch (triggerErr) {
                            context.log.warn('processEmailTriggers (new_shift) failed:', triggerErr.message);
                        }
                    }
                    
                    return { status: 201, jsonBody: createdItem };
                } catch (createError) {
                    // Handle case where container doesn't exist
                    const errorCode = createError.code || createError.statusCode;
                    const errorMessage = (createError.message || '').toLowerCase();
                    
                    if (errorCode === 404 || 
                        errorMessage.includes('notfound') || 
                        errorMessage.includes('not found') ||
                        errorMessage.includes('container') ||
                        errorMessage.includes('does not exist')) {
                        context.log.error(`Container '${containerName}' does not exist. Please create it in Cosmos DB.`);
                        return {
                            status: 500,
                            jsonBody: { 
                                error: `Container '${containerName}' does not exist in Cosmos DB. Please create the container first.`,
                                containerName: containerName
                            },
                            headers: { 'Content-Type': 'application/json' }
                        };
                    }
                    throw createError;
                }
            
            case 'PUT':
                const requestBody = await request.json();
                const updateId = id || requestBody.id;
                const isValidCrcId = (value) =>
                    typeof value === 'string' &&
                    value.trim() !== '' &&
                    value.trim() !== 'SITE_STAFF' &&
                    value.trim() !== 'UNASSIGNED';
                const extractCrcId = (value) => {
                    if (typeof value === 'string') return value;
                    if (value && typeof value === 'object') {
                        const candidate =
                            value.crcId ||
                            value.id ||
                            value.userId ||
                            value.value ||
                            value.key;
                        if (typeof candidate === 'string') return candidate;
                    }
                    return null;
                };
                const normalizeRoleAssignments = (roleAssignments) => {
                    if (!roleAssignments || typeof roleAssignments !== 'object' || Array.isArray(roleAssignments)) {
                        return roleAssignments;
                    }
                    const normalized = {};
                    Object.entries(roleAssignments).forEach(([roleId, assignments]) => {
                        if (Array.isArray(assignments)) {
                            normalized[roleId] = assignments.map(entry => {
                                const id = extractCrcId(entry);
                                if (id === 'SITE_STAFF') return 'SITE_STAFF';
                                return isValidCrcId(id) ? id : null;
                            });
                        } else {
                            const id = extractCrcId(assignments);
                            normalized[roleId] = id === 'SITE_STAFF' ? ['SITE_STAFF'] : (isValidCrcId(id) ? [id] : [null]);
                        }
                    });
                    return normalized;
                };
                const hasLegacyAssignmentShape = (roleAssignments) => {
                    if (!roleAssignments || typeof roleAssignments !== 'object' || Array.isArray(roleAssignments)) {
                        return false;
                    }
                    return Object.values(roleAssignments).some(assignments => {
                        if (Array.isArray(assignments)) {
                            return assignments.some(entry => entry !== null && typeof entry !== 'string');
                        }
                        return assignments !== null && typeof assignments !== 'string';
                    });
                };
                const normalizeEventAssignments = (event) => {
                    try {
                        if (!event || typeof event !== 'object') return;
                        if (event.roleAssignments !== undefined && hasLegacyAssignmentShape(event.roleAssignments)) {
                            if (!event.legacyRoleAssignmentsRaw) {
                                event.legacyRoleAssignmentsRaw = event.roleAssignments;
                            }
                        }
                        if (event.crcId !== undefined) {
                            try {
                                const id = extractCrcId(event.crcId);
                                event.crcId = isValidCrcId(id) ? id : null;
                            } catch (e) {
                                // If crcId normalization fails, set to null
                                event.crcId = null;
                            }
                        }
                        if (Array.isArray(event.crcIds)) {
                            try {
                                if (event.crcIds.some(entry => entry !== null && typeof entry !== 'string')) {
                                    if (!event.legacyCrcIdsRaw) {
                                        event.legacyCrcIdsRaw = event.crcIds;
                                    }
                                }
                                event.crcIds = event.crcIds
                                    .map(extractCrcId)
                                    .filter(id => isValidCrcId(id));
                            } catch (e) {
                                // If crcIds normalization fails, filter to strings only
                                event.crcIds = event.crcIds.filter(id => typeof id === 'string' && isValidCrcId(id));
                            }
                        }
                        if (event.roleAssignments !== undefined) {
                            try {
                                event.roleAssignments = normalizeRoleAssignments(event.roleAssignments);
                            } catch (e) {
                                // If roleAssignments normalization fails, try to keep it as-is or set to empty
                                if (!event.roleAssignments || typeof event.roleAssignments !== 'object' || Array.isArray(event.roleAssignments)) {
                                    // Invalid shape, set to empty object
                                    event.roleAssignments = {};
                                }
                            }
                        }
                    } catch (e) {
                        // If entire normalization fails, log but don't crash
                        context.log.warn(`Normalization failed for event, continuing with original data:`, e.message);
                    }
                };
                try {
                    normalizeEventAssignments(requestBody);
                } catch (e) {
                    context.log.warn(`Failed to normalize requestBody, continuing anyway:`, e.message);
                }
                
                // For events, check if update would result in N/A entry - if so, delete instead
                if (containerName === 'events' && updateId) {
                    try {
                        const { resource: existingEvent } = await container.item(updateId, updateId).read();
                        if (existingEvent) {
                            // Check if this update would result in an N/A entry
                            const hasCrcId = isValidCrcId(requestBody.crcId);
                            const hasCrcIds = requestBody.crcIds && Array.isArray(requestBody.crcIds) && requestBody.crcIds.length > 0 && 
                                              requestBody.crcIds.some(id => isValidCrcId(id));
                            const hasValidRoleAssignments = requestBody.roleAssignments && 
                                Object.keys(requestBody.roleAssignments).length > 0 &&
                                Object.values(requestBody.roleAssignments).some(assignments => 
                                    Array.isArray(assignments) && assignments.some(crcId => isValidCrcId(crcId))
                                );
                            
                            // If updating would result in N/A (no CRC and no valid role assignments), delete the event instead
                            if (!hasCrcId && !hasCrcIds && !hasValidRoleAssignments) {
                                // Never delete on update: preserve data even if it's effectively N/A
                                context.log.warn(`Skipping auto-delete for event ${updateId} (would be N/A). Preserving data.`);
                            }
                        }
                    } catch (readError) {
                        // If we can't read the existing event, continue with normal update
                        context.log.warn(`Could not read existing event ${updateId} for N/A check:`, readError.message);
                    }
                }
                
                // For events, ensure crcIds and roleAssignments are properly preserved when updating
                if (containerName === 'events' && updateId) {
                    // Normalize Travel Day events: ensure type is set correctly
                    // Check for isTravelDay flag FIRST (before checking type) - this is the most reliable indicator
                    const isTravelDayFlag = requestBody.isTravelDay === true || requestBody.isTravelDay === 'true' || requestBody.travelDay === true;
                    const isTravelDayType = requestBody.type === 'Travel Day' || requestBody.type === 'travel day' || requestBody.type === 'travel';
                    
                    if (isTravelDayFlag || isTravelDayType || 
                        (requestBody.type === 'Site Assignment' && requestBody.isTravelDay === true)) {
                        requestBody.type = 'Travel Day';
                        
                        // Travel Days should use crcId/crcIds, not roleAssignments
                        // If roleAssignments are provided, extract CRC IDs from them
                        if (requestBody.roleAssignments && typeof requestBody.roleAssignments === 'object') {
                            const crcIdsFromRoles = [];
                            Object.values(requestBody.roleAssignments).forEach(assignments => {
                                if (Array.isArray(assignments)) {
                                    assignments.forEach(crcId => {
                                        if (isValidCrcId(crcId)) {
                                            if (!crcIdsFromRoles.includes(crcId)) {
                                                crcIdsFromRoles.push(crcId);
                                            }
                                        }
                                    });
                                }
                            });
                            
                            // If we found CRCs in roleAssignments, use them for crcIds
                            if (crcIdsFromRoles.length > 0) {
                                requestBody.crcIds = crcIdsFromRoles;
                                if (!isValidCrcId(requestBody.crcId)) {
                                    requestBody.crcId = crcIdsFromRoles[0];
                                }
                            }
                            
                            // Remove roleAssignments from Travel Days - they don't need them
                            delete requestBody.roleAssignments;
                        }
                    }
                    
                    try {
                        const { resource: existingEvent } = await container.item(updateId, updateId).read();
                        if (existingEvent) {
                            try {
                                normalizeEventAssignments(existingEvent);
                            } catch (e) {
                                context.log.warn(`Failed to normalize existingEvent, continuing anyway:`, e.message);
                            }
                            // CRITICAL: Check for isTravelDay flag - if set, force type to Travel Day
                            if (requestBody.isTravelDay === true || requestBody.isTravelDay === 'true' || requestBody.travelDay === true) {
                                requestBody.type = 'Travel Day';
                            }
                            
                            // For Travel Days, remove roleAssignments if they exist
                            if (existingEvent.type === 'Travel Day' || requestBody.type === 'Travel Day') {
                                // Force type to Travel Day if existing event is Travel Day
                                if (existingEvent.type === 'Travel Day') {
                                    requestBody.type = 'Travel Day';
                                }
                                if (requestBody.roleAssignments !== undefined) {
                                    delete requestBody.roleAssignments;
                                }
                                // Also remove from existing event if we're merging
                                if (existingEvent.roleAssignments) {
                                    delete existingEvent.roleAssignments;
                                }
                            }
                            // Prevent overriding training events
                            // Check if this event is linked to a training study
                            if (existingEvent.studyId) {
                                try {
                                    const studiesContainer = getContainer('studies');
                                    const { resource: study } = await studiesContainer.item(existingEvent.studyId, existingEvent.studyId).read();
                                    if (study && study.studyType === 'training') {
                                        // If trying to set isOverridden, reject it
                                        if (requestBody.isOverridden === true) {
                                            return {
                                                status: 400,
                                                jsonBody: { 
                                                    error: 'Cannot override training events',
                                                    message: 'Training events cannot be overridden. Please contact an administrator if changes are needed.'
                                                },
                                                headers: { 'Content-Type': 'application/json' }
                                            };
                                        }
                                        // If isOverridden is being set in the request, remove it
                                        if (requestBody.isOverridden !== undefined) {
                                            delete requestBody.isOverridden;
                                        }
                                    }
                                } catch (studyError) {
                                    // If we can't read the study, log but continue (don't block the update)
                                    context.log.warn(`Could not read study ${existingEvent.studyId} to check if training:`, studyError.message);
                                }
                            }
                            
                            // Also check if the event type itself indicates training
                            const eventType = String(existingEvent.type || '').toLowerCase().trim();
                            if (eventType === 'training' || eventType.includes('training')) {
                                if (requestBody.isOverridden === true) {
                                    return {
                                        status: 400,
                                        jsonBody: { 
                                            error: 'Cannot override training events',
                                            message: 'Training events cannot be overridden. Please contact an administrator if changes are needed.'
                                        },
                                        headers: { 'Content-Type': 'application/json' }
                                    };
                                }
                                if (requestBody.isOverridden !== undefined) {
                                    delete requestBody.isOverridden;
                                }
                            }
                            // CRITICAL: Preserve Travel Day type - never let it be overwritten
                            if (existingEvent.type === 'Travel Day') {
                                // Force the type to remain Travel Day - this is non-negotiable
                                requestBody.type = 'Travel Day';
                                
                                // Preserve ALL travel day specific fields from existing event
                                // Don't let shift updates overwrite travel day data
                                if (existingEvent.crcIds && Array.isArray(existingEvent.crcIds)) {
                                    requestBody.crcIds = existingEvent.crcIds;
                                }
                                if (existingEvent.crcId) {
                                    requestBody.crcId = existingEvent.crcId;
                                }
                                
                                // Preserve travel day linking fields
                                if (existingEvent.navanBookingId) {
                                    requestBody.navanBookingId = existingEvent.navanBookingId;
                                }
                                if (existingEvent.navanBookingUuid) {
                                    requestBody.navanBookingUuid = existingEvent.navanBookingUuid;
                                }
                                if (existingEvent.travelRecordId) {
                                    requestBody.travelRecordId = existingEvent.travelRecordId;
                                }
                                
                                // Ensure crcId is set from crcIds if missing
                                if (requestBody.crcIds && Array.isArray(requestBody.crcIds) && requestBody.crcIds.length > 0) {
                                    if (!isValidCrcId(requestBody.crcId)) {
                                        const firstValidCrcId = requestBody.crcIds.find(id => isValidCrcId(id));
                                        if (firstValidCrcId) {
                                            requestBody.crcId = firstValidCrcId;
                                        }
                                    }
                                }
                                
                                // CRITICAL: Remove roleAssignments - Travel Days don't use them and they cause open shift display
                                if (requestBody.roleAssignments !== undefined) {
                                    delete requestBody.roleAssignments;
                                }
                                // Also ensure it's removed from the merged object
                                delete existingEvent.roleAssignments;
                            } else {
                                // For non-Travel Day events, merge crcIds if not provided
                                if (!requestBody.crcIds && existingEvent.crcIds && Array.isArray(existingEvent.crcIds)) {
                                    requestBody.crcIds = existingEvent.crcIds;
                                }
                                
                                // Merge roleAssignments if not provided
                                if (!requestBody.roleAssignments && existingEvent.roleAssignments && typeof existingEvent.roleAssignments === 'object') {
                                    requestBody.roleAssignments = existingEvent.roleAssignments;
                                }
                            }
                            // If crcId is provided but crcIds is not, ensure crcIds array is set
                            if (requestBody.crcId && (!requestBody.crcIds || !Array.isArray(requestBody.crcIds) || requestBody.crcIds.length === 0)) {
                                requestBody.crcIds = [requestBody.crcId];
                            }
                            // If crcIds is provided but crcId is not, set crcId from first valid CRC
                            if (requestBody.crcIds && Array.isArray(requestBody.crcIds) && requestBody.crcIds.length > 0 && 
                                (!requestBody.crcId || !isValidCrcId(requestBody.crcId))) {
                                const firstValidCrcId = requestBody.crcIds.find(id => isValidCrcId(id));
                                if (firstValidCrcId) {
                                    requestBody.crcId = firstValidCrcId;
                                }
                            }
                            
                            // For Travel Day events, ensure type is preserved
                            if (existingEvent.type === 'Travel Day' && !requestBody.type) {
                                requestBody.type = 'Travel Day';
                            }
                            // Preserve volunteer-for-shift fields if not in request (partial updates)
                            if (requestBody.openForVolunteers === undefined && existingEvent.openForVolunteers !== undefined) {
                                requestBody.openForVolunteers = existingEvent.openForVolunteers;
                            }
                            if (requestBody.volunteerApplications === undefined && Array.isArray(existingEvent.volunteerApplications)) {
                                requestBody.volunteerApplications = existingEvent.volunteerApplications;
                            }
                            // Preserve roleQuantityOverrides so "0" for a role is remembered (shift won't show as unassigned)
                            if (requestBody.roleQuantityOverrides === undefined && existingEvent.roleQuantityOverrides && typeof existingEvent.roleQuantityOverrides === 'object') {
                                requestBody.roleQuantityOverrides = existingEvent.roleQuantityOverrides;
                            }
                        }
                    } catch (readError) {
                        // If we can't read the existing event, continue with normal update
                        context.log.warn(`Could not read existing event ${updateId} for data merge:`, readError.message);
                    }
                }
                
                // For users, fetch existing user data to merge with update data for validation
                let mergedRequestBody = requestBody;
                if (containerName === 'users' && updateId) {
                    try {
                        const { resource: existingUser } = await container.item(updateId, updateId).read();
                        if (existingUser) {
                            // Merge existing user data with update data, but exclude password from existing user
                            // to avoid issues with hashed vs plain text passwords
                            const { password: _, ...existingUserWithoutPassword } = existingUser;
                            mergedRequestBody = { ...existingUserWithoutPassword, ...requestBody };
                            
                            // Ensure username exists for validation (use existing username, id, email, or generate default)
                            if (!mergedRequestBody.username || typeof mergedRequestBody.username !== 'string') {
                                mergedRequestBody.username = existingUser.username || 
                                                           existingUser.id || 
                                                           existingUser.email || 
                                                           `user_${updateId}`;
                                context.log.info(`Generated default username for user ${updateId}: ${mergedRequestBody.username}`);
                            }
                        } else {
                            // User not found - this is an update, so we need the user to exist
                            context.log.warn(`User ${updateId} not found for update`);
                            // Continue with requestBody only - validation will fail if required fields are missing
                        }
                    } catch (error) {
                        // Log the error but continue - validation will catch if required fields are missing
                        context.log.error(`Error reading user ${updateId} for update:`, error.message || error);
                        // Continue with requestBody only
                    }
                }
                
                // Normalize cost fields for travel - convert empty strings to undefined
                if (containerName === 'travel') {
                    if (requestBody.flightCost === '' || requestBody.flightCost === null) requestBody.flightCost = undefined;
                    if (requestBody.carRentalCost === '' || requestBody.carRentalCost === null) requestBody.carRentalCost = undefined;
                    if (requestBody.hotelCost === '' || requestBody.hotelCost === null) requestBody.hotelCost = undefined;
                    
                    // Convert string numbers to numbers
                    if (requestBody.flightCost !== undefined && typeof requestBody.flightCost === 'string') {
                        requestBody.flightCost = parseFloat(requestBody.flightCost) || undefined;
                    }
                    if (requestBody.carRentalCost !== undefined && typeof requestBody.carRentalCost === 'string') {
                        requestBody.carRentalCost = parseFloat(requestBody.carRentalCost) || undefined;
                    }
                    if (requestBody.hotelCost !== undefined && typeof requestBody.hotelCost === 'string') {
                        requestBody.hotelCost = parseFloat(requestBody.hotelCost) || undefined;
                    }
                }
                
                // Normalize zip code fields for sites - map zip, postalCode, postal_code to zipCode
                if (containerName === 'sites') {
                    if (requestBody.zip && !requestBody.zipCode) {
                        requestBody.zipCode = requestBody.zip;
                    }
                    if (requestBody.postalCode && !requestBody.zipCode) {
                        requestBody.zipCode = requestBody.postalCode;
                    }
                    if (requestBody.postal_code && !requestBody.zipCode) {
                        requestBody.zipCode = requestBody.postal_code;
                    }
                }
                
                // For studies PUT: use request body as-is (no Cosmos read/merge) so saves always succeed.
                // The configure-study form sends a full study; we ensure id and strip Cosmos system fields.
                if (containerName === 'studies' && updateId) {
                    requestBody.id = updateId;
                    ['_rid', '_self', '_etag', '_attachments', '_ts'].forEach(k => { delete requestBody[k]; });
                }
                
                // Validate schema based on container
                try {
                    switch (containerName) {
                        case 'studies':
                            validateStudiesSchema(requestBody);
                            break;
                        case 'sites':
                            validateSitesSchema(requestBody);
                            break;
                        case 'patients':
                            validatePatientsSchema(requestBody);
                            break;
                        case 'crcs':
                            validateCrcsSchema(requestBody);
                            break;
                        case 'events':
                            validateEventsSchema(requestBody);
                            break;
                        case 'roles':
                            validateRolesSchema(requestBody);
                            break;
                        case 'users':
                            validateUsersSchema(mergedRequestBody);
                            // Hash password if provided
                            if (requestBody.password) {
                                requestBody.password = hashPassword(requestBody.password);
                            }
                            break;
                        case 'schedules':
                            // Finalization records (schedule-finalized-{monthKey}) store snapshot + finalized flag; skip strict schema
                            if (!updateId || !String(updateId).startsWith('schedule-finalized-')) {
                                validateSchedulesSchema(requestBody);
                                await validateSiteStudyRelationship(requestBody.siteId, requestBody.studyId);
                            }
                            break;
                        case 'surveys':
                            validateSurveysSchema(requestBody);
                            break;
                        case 'time-off-requests':
                            validateTimeOffRequestsSchema(requestBody);
                            break;
                        case 'travel':
                            validateTravelSchema(requestBody);
                            break;
                    }
                } catch (validationError) {
                    context.log.error(`Validation error for ${containerName}:`, validationError.message);
                    return {
                        status: 400,
                        jsonBody: { error: validationError.message },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                
                try {
                    // For events, ensure we preserve all fields when updating (merge with existing event)
                    let updatedItem = { ...requestBody, id: updateId };
                    if (containerName === 'studies' && updateId) {
                        try {
                            const { resource: existingStudy } = await container.item(updateId, updateId).read();
                            if (existingStudy) {
                                updatedItem = { ...existingStudy, ...requestBody, id: updateId };
                            }
                        } catch (readError) {
                            context.log.warn(`Could not read existing study ${updateId} for merge, proceeding with update:`, readError.message);
                        }
                    }
                    if (containerName === 'events' && updateId) {
                        try {
                            const { resource: existingEvent } = await container.item(updateId, updateId).read();
                            if (existingEvent) {
                                try {
                                    normalizeEventAssignments(existingEvent);
                                } catch (e) {
                                    context.log.warn(`Failed to normalize existingEvent in merge, continuing:`, e.message);
                                }
                                // CRITICAL: Preserve the type of existing event if it's a Travel Day
                                // Don't let the request body overwrite Travel Day type
                                const preservedType = existingEvent.type === 'Travel Day' ? 'Travel Day' : requestBody.type;
                                
                                // CRITICAL: Check for isTravelDay flag in requestBody - if set, this IS a Travel Day
                                const isTravelDayRequest = requestBody.isTravelDay === true || requestBody.isTravelDay === 'true' || requestBody.travelDay === true;
                                
                                // CRITICAL: If existing event is a Travel Day OR request has isTravelDay flag, preserve it completely
                                // Don't let shift updates overwrite travel day data
                                if (existingEvent.type === 'Travel Day' || isTravelDayRequest) {
                                    // Force type to Travel Day
                                    const finalType = 'Travel Day';
                                    
                                    // For Travel Days, only update non-critical fields, preserve all travel day specific data
                                    updatedItem = {
                                        ...existingEvent, // Start with existing travel day data (if it exists)
                                        ...requestBody,  // Apply updates
                                        id: updateId,
                                        type: finalType, // ALWAYS force type to Travel Day
                                        // Preserve existing travel day fields, but allow updates if provided
                                        crcId: requestBody.crcId || existingEvent.crcId,
                                        crcIds: requestBody.crcIds || existingEvent.crcIds,
                                        navanBookingId: requestBody.navanBookingId || existingEvent.navanBookingId,
                                        navanBookingUuid: requestBody.navanBookingUuid || existingEvent.navanBookingUuid,
                                        travelRecordId: requestBody.travelRecordId || existingEvent.travelRecordId
                                    };
                                    
                                    // Remove roleAssignments - Travel Days don't use them
                                    delete updatedItem.roleAssignments;
                                    
                                    // Ensure crcIds is an array
                                    if (!updatedItem.crcIds || !Array.isArray(updatedItem.crcIds)) {
                                        if (updatedItem.crcId) {
                                            updatedItem.crcIds = [updatedItem.crcId];
                                        } else {
                                            updatedItem.crcIds = [];
                                        }
                                    }
                                    
                                    // Ensure crcId is set from crcIds if needed
                                    if (updatedItem.crcIds && Array.isArray(updatedItem.crcIds) && updatedItem.crcIds.length > 0) {
                                        if (!updatedItem.crcId || updatedItem.crcId.trim() === '') {
                                            const firstValidCrcId = updatedItem.crcIds.find(id => id && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED');
                                            if (firstValidCrcId) {
                                                updatedItem.crcId = firstValidCrcId;
                                            }
                                        }
                                    }
                                    
                                    // Remove null/undefined fields
                                    Object.keys(updatedItem).forEach(key => {
                                        if (updatedItem[key] === null || updatedItem[key] === undefined) {
                                            delete updatedItem[key];
                                        }
                                    });
                                } else {
                                    // For non-Travel Day events, normal merge
                                    // CRITICAL: Normalize existingEvent FIRST to convert legacy fields before merging
                                    const normalizedExisting = { ...existingEvent };
                                    try {
                                        normalizeEventAssignments(normalizedExisting);
                                        // Convert legacy studyId to studyIds if needed
                                        if (normalizedExisting.studyId && typeof normalizedExisting.studyId === 'string' && (!normalizedExisting.studyIds || !Array.isArray(normalizedExisting.studyIds))) {
                                            normalizedExisting.studyIds = [normalizedExisting.studyId];
                                            delete normalizedExisting.studyId;
                                        }
                                        // Convert legacy crcId to crcIds if needed
                                        if (normalizedExisting.crcId && typeof normalizedExisting.crcId === 'string' && (!normalizedExisting.crcIds || !Array.isArray(normalizedExisting.crcIds))) {
                                            normalizedExisting.crcIds = [normalizedExisting.crcId];
                                        }
                                    } catch (e) {
                                        context.log.warn(`Failed to normalize existingEvent before merge:`, e.message);
                                    }
                                    
                                    // SAFEGUARD: Detect if update would clear roleAssignments on a Site Assignment
                                    const existingHasAssignments = normalizedExisting.roleAssignments && 
                                        typeof normalizedExisting.roleAssignments === 'object' &&
                                        Object.values(normalizedExisting.roleAssignments).some(arr => Array.isArray(arr) && arr.length > 0);
                                    const requestHasAssignments = requestBody.roleAssignments && 
                                        typeof requestBody.roleAssignments === 'object' &&
                                        Object.values(requestBody.roleAssignments).some(arr => Array.isArray(arr) && arr.length > 0);
                                    
                                    // If existing has assignments but request doesn't, PRESERVE existing assignments
                                    // This prevents accidental clearing of CRC assignments
                                    if (existingHasAssignments && !requestHasAssignments && normalizedExisting.type === 'Site Assignment') {
                                        context.log.warn(`[SAFEGUARD] Preserving roleAssignments for Site Assignment ${updateId} - request would have cleared them`);
                                        // Don't let requestBody.roleAssignments overwrite - preserve existing
                                        if (requestBody.roleAssignments !== undefined) {
                                            delete requestBody.roleAssignments;
                                        }
                                    }
                                    
                                    // Now merge normalized existing with requestBody (requestBody is already normalized)
                                    updatedItem = { ...normalizedExisting, ...requestBody, id: updateId };
                                    
                                    // Legacy field migration and normalization BEFORE final validation
                                    // Force legacy studyId -> studyIds and remove the old field
                                    if (!updatedItem.studyIds || !Array.isArray(updatedItem.studyIds)) {
                                        if (updatedItem.studyId && typeof updatedItem.studyId === 'string' && updatedItem.studyId.trim() !== '') {
                                            updatedItem.studyIds = [updatedItem.studyId];
                                        } else {
                                            updatedItem.studyIds = [];
                                        }
                                    }
                                    if (Array.isArray(updatedItem.studyIds) && updatedItem.studyIds.length > 1) {
                                        updatedItem.studyIds = [updatedItem.studyIds[0]];
                                    }
                                    if (updatedItem.studyId !== undefined) {
                                        delete updatedItem.studyId;
                                    }
                                    
                                    // Force legacy crcId -> crcIds if needed
                                    if (!updatedItem.crcIds || !Array.isArray(updatedItem.crcIds)) {
                                        if (updatedItem.crcId && typeof updatedItem.crcId === 'string' && updatedItem.crcId.trim() !== '' && updatedItem.crcId !== 'SITE_STAFF' && updatedItem.crcId !== 'UNASSIGNED') {
                                            updatedItem.crcIds = [updatedItem.crcId];
                                        } else {
                                            updatedItem.crcIds = [];
                                        }
                                    }
                                    
                                    // Force roleAssignments into object shape for validation safety
                                    if (!updatedItem.roleAssignments || typeof updatedItem.roleAssignments !== 'object' || Array.isArray(updatedItem.roleAssignments)) {
                                        updatedItem.roleAssignments = {};
                                    }
                                    
                                    // Final normalization pass on merged result
                                    try {
                                        normalizeEventAssignments(updatedItem);
                                    } catch (e) {
                                        context.log.warn(`Failed to normalize updatedItem in merge, continuing:`, e.message);
                                    }
                                    
                                    // Ensure roleAssignments is initialized for Site Assignment edits
                                    if (updatedItem.type === 'Site Assignment' && !updatedItem.roleAssignments) {
                                        updatedItem.roleAssignments = {};
                                    }
                                    
                                    if (preservedType) {
                                        updatedItem.type = preservedType;
                                    }
                                    // CRITICAL: Preserve travelDayPreferences if not explicitly provided in requestBody
                                    // This ensures travel day checkbox state is maintained when updating shifts
                                    if (requestBody.travelDayPreferences === undefined && existingEvent.travelDayPreferences) {
                                        updatedItem.travelDayPreferences = existingEvent.travelDayPreferences;
                                    }
                                    
                                    // Remove Cosmos DB system fields that shouldn't be in the update
                                    ['_rid', '_self', '_etag', '_attachments', '_ts'].forEach(k => { 
                                        if (k in updatedItem) delete updatedItem[k]; 
                                    });
                                    
                                    // CRITICAL: Normalize studyIds - requestBody takes precedence
                                    if (requestBody.studyIds !== undefined && Array.isArray(requestBody.studyIds)) {
                                        // User provided studyIds - use it
                                        updatedItem.studyIds = requestBody.studyIds;
                                    } else if (!updatedItem.studyIds || !Array.isArray(updatedItem.studyIds)) {
                                        // Fall back to normalized existing or convert legacy
                                        if (normalizedExisting.studyIds && Array.isArray(normalizedExisting.studyIds)) {
                                            updatedItem.studyIds = normalizedExisting.studyIds;
                                        } else if (normalizedExisting.studyId && typeof normalizedExisting.studyId === 'string') {
                                            updatedItem.studyIds = [normalizedExisting.studyId];
                                        } else {
                                            updatedItem.studyIds = [];
                                        }
                                    }
                                    // Always remove legacy studyId field
                                    if (updatedItem.studyId) {
                                        delete updatedItem.studyId;
                                    }
                                    
                                    // CRITICAL: requestBody.roleAssignments always wins - it's what the user is saving
                                    // Only fall back to existingEvent if requestBody doesn't have it
                                    if (requestBody.roleAssignments !== undefined) {
                                        // User provided roleAssignments - use it (already normalized)
                                        updatedItem.roleAssignments = requestBody.roleAssignments;
                                    } else if (updatedItem.roleAssignments === null || updatedItem.roleAssignments === undefined) {
                                        // No roleAssignments from user, try to use normalized existing
                                        if (normalizedExisting.roleAssignments && typeof normalizedExisting.roleAssignments === 'object') {
                                            updatedItem.roleAssignments = normalizedExisting.roleAssignments;
                                        } else {
                                            // No roleAssignments at all - set to empty object for Open Shifts
                                            updatedItem.roleAssignments = {};
                                        }
                                    }
                                    
                                    // CRITICAL: Normalize crcIds - requestBody takes precedence, but derive from roleAssignments if needed
                                    // If requestBody has roleAssignments, extract crcIds from it
                                    if (requestBody.roleAssignments && typeof requestBody.roleAssignments === 'object') {
                                        const crcIdsFromRoles = new Set();
                                        Object.values(requestBody.roleAssignments).forEach(assignments => {
                                            if (Array.isArray(assignments)) {
                                                assignments.forEach(crcId => {
                                                    if (isValidCrcId(crcId)) {
                                                        crcIdsFromRoles.add(crcId);
                                                    }
                                                });
                                            }
                                        });
                                        if (crcIdsFromRoles.size > 0) {
                                            updatedItem.crcIds = Array.from(crcIdsFromRoles);
                                        }
                                    } else if (requestBody.crcIds !== undefined && Array.isArray(requestBody.crcIds)) {
                                        // User provided crcIds directly - use it
                                        updatedItem.crcIds = requestBody.crcIds;
                                    } else if (!updatedItem.crcIds || !Array.isArray(updatedItem.crcIds)) {
                                        // Fall back to normalized existing or convert legacy
                                        if (normalizedExisting.crcIds && Array.isArray(normalizedExisting.crcIds)) {
                                            updatedItem.crcIds = normalizedExisting.crcIds;
                                        } else if (normalizedExisting.crcId && typeof normalizedExisting.crcId === 'string' && isValidCrcId(normalizedExisting.crcId)) {
                                            updatedItem.crcIds = [normalizedExisting.crcId];
                                        } else {
                                            updatedItem.crcIds = [];
                                        }
                                    }
                                    
                                    // If updating a Site Assignment shift, check if any CRCs were removed
                                    // and delete their travel days for this shift date
                                    if (existingEvent.type === 'Site Assignment' && existingEvent.date) {
                                        try {
                                            const eventsContainer = getContainer('events');
                                            
                                            // Collect CRCs that were in the original shift
                                            const originalCrcIds = new Set();
                                            if (existingEvent.crcId && existingEvent.crcId.trim() !== '' && existingEvent.crcId !== 'SITE_STAFF' && existingEvent.crcId !== 'UNASSIGNED') {
                                                originalCrcIds.add(existingEvent.crcId);
                                            }
                                            if (existingEvent.crcIds && Array.isArray(existingEvent.crcIds)) {
                                                existingEvent.crcIds.forEach(crcId => {
                                                    if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                                        originalCrcIds.add(crcId);
                                                    }
                                                });
                                            }
                                            if (existingEvent.roleAssignments && typeof existingEvent.roleAssignments === 'object') {
                                                Object.values(existingEvent.roleAssignments).forEach(assignments => {
                                                    if (Array.isArray(assignments)) {
                                                        assignments.forEach(crcId => {
                                                            if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                                                originalCrcIds.add(crcId);
                                                            }
                                                        });
                                                    }
                                                });
                                            }
                                            
                                            // Collect CRCs that are in the updated shift
                                            const updatedCrcIds = new Set();
                                            if (updatedItem.crcId && updatedItem.crcId.trim() !== '' && updatedItem.crcId !== 'SITE_STAFF' && updatedItem.crcId !== 'UNASSIGNED') {
                                                updatedCrcIds.add(updatedItem.crcId);
                                            }
                                            if (updatedItem.crcIds && Array.isArray(updatedItem.crcIds)) {
                                                updatedItem.crcIds.forEach(crcId => {
                                                    if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                                        updatedCrcIds.add(crcId);
                                                    }
                                                });
                                            }
                                            if (updatedItem.roleAssignments && typeof updatedItem.roleAssignments === 'object') {
                                                Object.values(updatedItem.roleAssignments).forEach(assignments => {
                                                    if (Array.isArray(assignments)) {
                                                        assignments.forEach(crcId => {
                                                            if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                                                updatedCrcIds.add(crcId);
                                                            }
                                                        });
                                                    }
                                                });
                                            }
                                            
                                            // Find CRCs that were removed
                                            const removedCrcIds = Array.from(originalCrcIds).filter(crcId => !updatedCrcIds.has(crcId));
                                            
                                            // If any CRCs were removed, delete their travel days for this date
                                            if (removedCrcIds.length > 0 && existingEvent.date) {
                                                const { resources: travelDays } = await eventsContainer.items.query({
                                                    query: "SELECT * FROM c WHERE c.type = 'Travel Day' AND c.date = @date",
                                                    parameters: [
                                                        { name: "@date", value: existingEvent.date }
                                                    ]
                                                }).fetchAll();
                                                
                                                // Delete travel days that belong to removed CRCs
                                                for (const travelDay of (travelDays || [])) {
                                                    if (!travelDay || travelDay.type !== 'Travel Day') continue;
                                                    
                                                    // Check if this travel day belongs to a removed CRC
                                                    let shouldDelete = false;
                                                    
                                                    if (travelDay.crcId && removedCrcIds.includes(travelDay.crcId)) {
                                                        // Single CRC travel day for a removed CRC
                                                        shouldDelete = true;
                                                    } else if (travelDay.crcIds && Array.isArray(travelDay.crcIds)) {
                                                        // Multi-CRC travel day - delete if all CRCs in it were removed
                                                        const travelDayCrcs = travelDay.crcIds.filter(id => id && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED');
                                                        if (travelDayCrcs.length > 0) {
                                                            const allCrcsRemoved = travelDayCrcs.every(crcId => removedCrcIds.includes(crcId));
                                                            const someCrcsRemoved = travelDayCrcs.some(crcId => removedCrcIds.includes(crcId));
                                                            // If all CRCs in the travel day were removed, delete it
                                                            // If only some were removed, we keep it (other CRCs still need it)
                                                            if (allCrcsRemoved) {
                                                                shouldDelete = true;
                                                            }
                                                        }
                                                    }
                                    
                                                    if (shouldDelete) {
                                                        try {
                                                            await eventsContainer.item(travelDay.id, travelDay.id).delete();
                                                            context.log.info(`Deleted travel day ${travelDay.id} because CRC(s) were removed from shift ${updateId}`);
                                                        } catch (deleteTravelError) {
                                                            context.log.warn(`Failed to delete travel day ${travelDay.id}: ${deleteTravelError.message}`);
                                                        }
                                                    }
                                                }
                                            }
                                        } catch (travelDeleteError) {
                                            // Log but don't fail the shift update if travel day deletion fails
                                            context.log.warn(`Error deleting travel days for removed CRCs from shift ${updateId}:`, travelDeleteError.message);
                                        }
                                    }
                                }
                            }
                        } catch (mergeError) {
                            // If we can't read existing event, use requestBody only
                            context.log.warn(`Could not read existing event ${updateId} for merge, using request body only:`, mergeError.message);
                        }
                    }
                    
                    // For users, ensure we preserve all existing fields when updating
                    if (containerName === 'users' && updateId) {
                        try {
                            const { resource: existingUser } = await container.item(updateId, updateId).read();
                            if (existingUser) {
                                // Protect admin user - prevent password changes and ensure correct settings
                                const isAdmin = existingUser.username && existingUser.username.toLowerCase().trim() === 'admin';
                                if (isAdmin) {
                                    // Admin password cannot be changed - always keep original password
                                    const originalPassword = existingUser.password;
                                    // Merge existing user fields with update fields, preserving existing data
                                    updatedItem = { ...existingUser, ...requestBody, id: updateId };
                                    // Restore original password - admin password is always "backdoor"
                                    updatedItem.password = originalPassword || hashPassword('backdoor');
                                    // Force admin settings
                                    updatedItem.permissionLevel = 'Manager';
                                    updatedItem.crcId = null;
                                    updatedItem.username = 'admin'; // Ensure username cannot be changed
                                } else {
                                    // Merge existing user fields with update fields, preserving existing data
                                    updatedItem = { ...existingUser, ...requestBody, id: updateId };
                                }
                                
                                // Correct admin user if needed (this will also save the correction)
                                updatedItem = await correctAdminUser(updatedItem, container, context);
                            }
                        } catch (readError) {
                            // If we can't read the existing user, proceed with just requestBody
                            // This might happen if the user was just created or there's a transient error
                            context.log.warn(`Could not read existing user ${updateId} for merge, proceeding with update:`, readError.message);
                            
                            // Still protect admin user even if we can't read existing user
                            const username = (requestBody.username || '').toLowerCase().trim();
                            if (username === 'admin') {
                                updatedItem.permissionLevel = 'Manager';
                                updatedItem.crcId = null;
                                updatedItem.username = 'admin';
                                // If password is being set, ensure it's the correct admin password
                                if (requestBody.password) {
                                    updatedItem.password = hashPassword('backdoor');
                                }
                            }
                        }
                    } else if (containerName === 'users' && requestBody.username) {
                        // For new users, protect admin username
                        const username = (requestBody.username || '').toLowerCase().trim();
                        if (username === 'admin') {
                            updatedItem.permissionLevel = 'Manager';
                            updatedItem.crcId = null;
                        }
                    }
                    
                    // Remove internal-only fields before upsert
                    const skipTravelDayProcessing = updatedItem.skipTravelDayProcessing === true;
                    if (updatedItem.skipTravelDayProcessing !== undefined) {
                        delete updatedItem.skipTravelDayProcessing;
                    }
                    
                    // Remove Cosmos DB system fields before upsert to avoid validation issues
                    ['_rid', '_self', '_etag', '_attachments', '_ts'].forEach(k => { 
                        if (k in updatedItem) delete updatedItem[k]; 
                    });
                    
                    // Ensure id is set
                    if (!updatedItem.id) {
                        updatedItem.id = updateId;
                    }
                    
                    // Final safety check: ensure studyIds and crcIds are arrays for events (only if missing)
                    // This is a minimal check - most normalization happens in the merge logic above
                    if (containerName === 'events') {
                        try {
                            normalizeEventAssignments(updatedItem);
                            // CRITICAL: Always ensure studyIds is an array (handle legacy studyId string)
                            if (!Array.isArray(updatedItem.studyIds)) {
                                if (updatedItem.studyId && typeof updatedItem.studyId === 'string' && updatedItem.studyId.trim() !== '') {
                                    updatedItem.studyIds = [updatedItem.studyId];
                                    delete updatedItem.studyId;
                                } else {
                                    updatedItem.studyIds = [];
                                }
                            }
                            
                            // CRITICAL: Always ensure crcIds is an array (handle legacy crcId string)
                            if (!Array.isArray(updatedItem.crcIds)) {
                                if (updatedItem.crcId && typeof updatedItem.crcId === 'string' && updatedItem.crcId.trim() !== '' && updatedItem.crcId !== 'SITE_STAFF' && updatedItem.crcId !== 'UNASSIGNED') {
                                    updatedItem.crcIds = [updatedItem.crcId];
                                } else {
                                    updatedItem.crcIds = [];
                                }
                            }
                            
                            // Validate the merged and normalized event before upsert
                            // If validation fails, log but don't block - try to fix and save anyway
                            try {
                                validateEventsSchema(updatedItem);
                            } catch (validationError) {
                                context.log.warn(`Validation error for merged event ${updateId}:`, validationError.message);
                                context.log.warn(`UpdatedItem structure:`, {
                                    type: updatedItem.type,
                                    hasStudyIds: !!updatedItem.studyIds,
                                    studyIdsType: typeof updatedItem.studyIds,
                                    studyIdsIsArray: Array.isArray(updatedItem.studyIds),
                                    hasCrcIds: !!updatedItem.crcIds,
                                    crcIdsType: typeof updatedItem.crcIds,
                                    crcIdsIsArray: Array.isArray(updatedItem.crcIds)
                                });
                                // Try to fix common validation issues
                                if (!updatedItem.type) updatedItem.type = 'Site Assignment';
                                if (!updatedItem.studyIds || !Array.isArray(updatedItem.studyIds)) {
                                    updatedItem.studyIds = updatedItem.studyId ? [updatedItem.studyId] : [];
                                    if (updatedItem.studyId) delete updatedItem.studyId;
                                }
                                if (!updatedItem.crcIds || !Array.isArray(updatedItem.crcIds)) {
                                    updatedItem.crcIds = updatedItem.crcId ? [updatedItem.crcId] : [];
                                }
                                // Don't throw - continue with save attempt
                            }
                        } catch (normalizeError) {
                            context.log.warn(`Error in final normalization for event ${updateId}:`, normalizeError.message);
                            // Don't throw - try to save anyway with what we have
                        }
                    }
                    
                    // AUDIT LOG: Record event updates for debugging/recovery
                    if (containerName === 'events') {
                        const roleAssignmentCrcs = updatedItem.roleAssignments ? 
                            Object.values(updatedItem.roleAssignments).flat().filter(id => id && id !== 'UNASSIGNED' && id !== 'SITE_STAFF') : [];
                        context.log.info(`[AUDIT UPDATE] Event ${updateId} | Type: ${updatedItem.type} | Date: ${updatedItem.date} | Site: ${updatedItem.siteId} | CRCs: ${JSON.stringify(updatedItem.crcIds || [])} | RoleAssignment CRCs: ${JSON.stringify(roleAssignmentCrcs)}`);
                    }
                    
                    let result;
                    try {
                        // Validate updatedItem structure before upsert
                        if (containerName === 'events') {
                            // Ensure required fields exist
                            if (!updatedItem.type) {
                                throw new Error('Event type is required');
                            }
                            if (!updatedItem.id) {
                                throw new Error('Event id is required');
                            }
                            // Ensure studyIds is an array (final check)
                            if (updatedItem.studyIds !== undefined && !Array.isArray(updatedItem.studyIds)) {
                                context.log.warn(`studyIds is not an array for event ${updateId}, normalizing...`);
                                if (updatedItem.studyId && typeof updatedItem.studyId === 'string') {
                                    updatedItem.studyIds = [updatedItem.studyId];
                                    delete updatedItem.studyId;
                                } else {
                                    updatedItem.studyIds = [];
                                }
                            }
                            // Ensure crcIds is an array (final check)
                            if (updatedItem.crcIds !== undefined && !Array.isArray(updatedItem.crcIds)) {
                                context.log.warn(`crcIds is not an array for event ${updateId}, normalizing...`);
                                if (updatedItem.crcId && typeof updatedItem.crcId === 'string' && updatedItem.crcId !== 'SITE_STAFF' && updatedItem.crcId !== 'UNASSIGNED') {
                                    updatedItem.crcIds = [updatedItem.crcId];
                                } else {
                                    updatedItem.crcIds = [];
                                }
                            }
                        }
                        
                        const upsertResult = await container.items.upsert(updatedItem);
                        result = upsertResult.resource;
                    } catch (upsertError) {
                        context.log.error(`Error upserting ${containerName} ${updateId}:`, upsertError);
                        context.log.error(`Upsert error details:`, {
                            message: upsertError.message,
                            code: upsertError.code,
                            statusCode: upsertError.statusCode,
                            stack: upsertError.stack
                        });
                        context.log.error(`UpdatedItem keys:`, Object.keys(updatedItem));
                        context.log.error(`UpdatedItem type:`, updatedItem?.type);
                        context.log.error(`UpdatedItem studyIds:`, updatedItem?.studyIds);
                        context.log.error(`UpdatedItem crcIds:`, updatedItem?.crcIds);
                        // Re-throw to be caught by outer catch
                        throw upsertError;
                    }
                    
                    // For users, ensure admin is corrected after upsert
                    if (containerName === 'users') {
                        const correctedResult = await correctAdminUser(result, container, context);
                        return { jsonBody: correctedResult };
                    }
                    
                    // Calculate enrollment for studies (non-fatal: never cause 500)
                    if (containerName === 'studies') {
                        try {
                            result.enrolled = await calculateStudyEnrollment(result.id);
                        } catch (e) {
                            context.log.warn('Study enrollment calc failed:', e?.message || e);
                            result.enrolled = result.enrolled ?? 0;
                        }
                    }
                    
                    // For Site Assignment shifts, handle travel days from travelDayPreferences
                    if (!skipTravelDayProcessing && containerName === 'events' && result && result.type === 'Site Assignment' && result.date) {
                        try {
                            const eventsContainer = getContainer('events');
                            const shiftDate = toDateOnlyString(result.date);
                            const baseStartDate = result.startDate || result.date;
                            const baseEndDate = result.endDate || result.date;
                            const computeDefaultTravelDates = () => {
                                const startObj = new Date(`${baseStartDate}T00:00:00`);
                                const endObj = new Date(`${baseEndDate}T00:00:00`);
                                if (Number.isNaN(startObj.getTime()) || Number.isNaN(endObj.getTime())) {
                                    return { start: shiftDate, end: shiftDate };
                                }
                                const startTravel = new Date(startObj);
                                startTravel.setDate(startTravel.getDate() - 1);
                                const endTravel = new Date(endObj);
                                endTravel.setDate(endTravel.getDate() + 1);
                                return { start: toDateOnlyString(startTravel), end: toDateOnlyString(endTravel) };
                            };
                            
                            // Skip if date is invalid
                            if (!shiftDate) {
                                context.log.warn(`Invalid date for travel day processing: ${result.date}`);
                                // Continue without processing travel days
                            } else {
                                // Collect all CRCs assigned to this shift
                            const shiftCrcIds = new Set();
                            if (result.crcId && result.crcId.trim() !== '' && result.crcId !== 'SITE_STAFF' && result.crcId !== 'UNASSIGNED') {
                                shiftCrcIds.add(result.crcId);
                            }
                            if (result.crcIds && Array.isArray(result.crcIds)) {
                                result.crcIds.forEach(crcId => {
                                    if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                        shiftCrcIds.add(crcId);
                                    }
                                });
                            }
                            if (result.roleAssignments && typeof result.roleAssignments === 'object') {
                                Object.values(result.roleAssignments).forEach(assignments => {
                                    if (Array.isArray(assignments)) {
                                        assignments.forEach(crcId => {
                                            if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                                shiftCrcIds.add(crcId);
                                            }
                                        });
                                    }
                                });
                            }
                            
                            const getTravelDaysForDate = async (travelDate) => {
                                try {
                                    const queryResult = await eventsContainer.items.query({
                                        query: "SELECT * FROM c WHERE c.type = 'Travel Day' AND c.date = @date",
                                        parameters: [
                                            { name: "@date", value: travelDate }
                                        ]
                                    }).fetchAll();
                                    return queryResult.resources || [];
                                } catch (queryError) {
                                    context.log.error(`Error querying existing travel days for date ${travelDate}:`, queryError);
                                    return [];
                                }
                            };
                            
                            // Process travelDayPreferences
                            if (result.travelDayPreferences && typeof result.travelDayPreferences === 'object') {
                                // First, clean up travel days for CRCs that are no longer in the shift
                                // This handles the case where someone is removed from a shift
                                for (const [crcId, hasTravel] of Object.entries(result.travelDayPreferences)) {
                                    // If CRC is not in the shift anymore, delete their travel day (even if travelDayPreferences still has them checked)
                                    if (!shiftCrcIds.has(crcId) && crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                        const prefs = hasTravel && typeof hasTravel === 'object' ? hasTravel : {};
                                        const startDate = prefs.startTravelDate || shiftDate;
                                        const endDate = prefs.endTravelDate || shiftDate;
                                        const datesToCheck = Array.from(new Set([startDate, endDate].filter(Boolean)));
                                        for (const travelDate of datesToCheck) {
                                            const travelDaysOnDate = await getTravelDaysForDate(travelDate);
                                            const travelDayToDelete = (travelDaysOnDate || []).find(td => {
                                                if (!td || td.type !== 'Travel Day') return false;
                                                if (td.crcId === crcId) return true;
                                                if (td.crcIds && Array.isArray(td.crcIds) && td.crcIds.length === 1 && td.crcIds[0] === crcId) return true;
                                                return false;
                                            });
                                            if (travelDayToDelete && travelDayToDelete.id) {
                                                try {
                                                    await eventsContainer.item(travelDayToDelete.id, travelDayToDelete.id).delete();
                                                    context.log.info(`Deleted travel day ${travelDayToDelete.id} for CRC ${crcId} because they were removed from the shift`);
                                                } catch (deleteTravelError) {
                                                    context.log.warn(`Failed to delete travel day ${travelDayToDelete.id}: ${deleteTravelError.message}`);
                                                }
                                            }
                                        }
                                    }
                                }
                                
                                // Now create/check travel days for CRCs that are in the shift
                                for (const [crcId, travelPrefs] of Object.entries(result.travelDayPreferences)) {
                                    try {
                                        // Skip if CRC ID is invalid
                                        if (!crcId || crcId.trim() === '' || crcId === 'SITE_STAFF' || crcId === 'UNASSIGNED') {
                                            continue;
                                        }
                                        
                                        // Check if this CRC should have travel days
                                        // travelPrefs can be:
                                        // - true (legacy boolean format)
                                        // - an object with includeStartTravel/includeEndTravel properties
                                        // - an object with travelNotNeeded: true
                                        const shouldHaveTravel = (
                                            travelPrefs === true || 
                                            (typeof travelPrefs === 'object' && travelPrefs !== null && 
                                             (travelPrefs.includeStartTravel === true || travelPrefs.includeEndTravel === true) &&
                                             !travelPrefs.travelNotNeeded)
                                        );
                                        
                                        if (shouldHaveTravel && shiftCrcIds.has(crcId)) {
                                            const includeStart = travelPrefs === true || (typeof travelPrefs === 'object' && travelPrefs.includeStartTravel === true);
                                            const includeEnd = travelPrefs === true || (typeof travelPrefs === 'object' && travelPrefs.includeEndTravel === true);
                                            const defaults = computeDefaultTravelDates();
                                            const startDate = (typeof travelPrefs === 'object' && travelPrefs.startTravelDate) ? travelPrefs.startTravelDate : defaults.start;
                                            const endDate = (typeof travelPrefs === 'object' && travelPrefs.endTravelDate) ? travelPrefs.endTravelDate : defaults.end;
                                            const datesToCreate = [];
                                            if (includeStart && startDate) datesToCreate.push(startDate);
                                            if (includeEnd && endDate && endDate !== startDate) datesToCreate.push(endDate);
                                            
                                            for (const travelDate of datesToCreate) {
                                                const travelDaysOnDate = await getTravelDaysForDate(travelDate);
                                                const existingTravelDay = (travelDaysOnDate || []).find(td => {
                                                    if (!td || td.type !== 'Travel Day') return false;
                                                    if (td.crcId === crcId) return true;
                                                    if (td.crcIds && Array.isArray(td.crcIds) && td.crcIds.includes(crcId)) return true;
                                                    return false;
                                                });
                                                
                                                if (!existingTravelDay) {
                                                    const travelDayEvent = {
                                                        id: generateId(),
                                                        type: 'Travel Day',
                                                        date: travelDate,
                                                        startDate: travelDate,  // SINGLE DAY - not a range!
                                                        endDate: travelDate,    // SINGLE DAY - not a range!
                                                        crcId: crcId,
                                                        crcIds: [crcId],
                                                        name: 'Travel Day',
                                                        siteId: result.siteId || null,
                                                        studyIds: Array.isArray(result.studyIds) ? result.studyIds : (result.studyId ? [result.studyId] : [])
                                                    };
                                                    
                                                    Object.keys(travelDayEvent).forEach(key => {
                                                        if (travelDayEvent[key] === null || travelDayEvent[key] === undefined) {
                                                            delete travelDayEvent[key];
                                                        }
                                                    });
                                                    
                                                    try {
                                                        await eventsContainer.items.create(travelDayEvent);
                                                        context.log.info(`Created travel day ${travelDayEvent.id} for CRC ${crcId} on ${travelDate} from travelDayPreferences`);
                                                    } catch (createTravelError) {
                                                        context.log.error(`Failed to create travel day for CRC ${crcId}:`, createTravelError);
                                                    }
                                                } else {
                                                    context.log.info(`Skipped creating travel day for CRC ${crcId} on ${travelDate} - travel day already exists (ID: ${existingTravelDay.id})`);
                                                }
                                            }
                                        } else if (travelPrefs === false || travelPrefs === undefined || 
                                                   (typeof travelPrefs === 'object' && travelPrefs !== null && 
                                                    travelPrefs.travelNotNeeded === true &&
                                                    !travelPrefs.includeStartTravel && !travelPrefs.includeEndTravel)) {
                                            // If travel is unchecked or removed, delete travel day for this CRC
                                            const defaults = computeDefaultTravelDates();
                                            const startDate = (typeof travelPrefs === 'object' && travelPrefs.startTravelDate) ? travelPrefs.startTravelDate : defaults.start;
                                            const endDate = (typeof travelPrefs === 'object' && travelPrefs.endTravelDate) ? travelPrefs.endTravelDate : defaults.end;
                                            const datesToCheck = Array.from(new Set([startDate, endDate].filter(Boolean)));
                                            for (const travelDate of datesToCheck) {
                                                const travelDaysOnDate = await getTravelDaysForDate(travelDate);
                                                const travelDayToDelete = (travelDaysOnDate || []).find(td => {
                                                    if (!td || td.type !== 'Travel Day') return false;
                                                    if (td.crcId === crcId) return true;
                                                    if (td.crcIds && Array.isArray(td.crcIds) && td.crcIds.length === 1 && td.crcIds[0] === crcId) return true;
                                                    return false;
                                                });
                                                
                                                if (travelDayToDelete && travelDayToDelete.id) {
                                                    try {
                                                        await eventsContainer.item(travelDayToDelete.id, travelDayToDelete.id).delete();
                                                        context.log.info(`Deleted travel day ${travelDayToDelete.id} for CRC ${crcId} because travel was unchecked`);
                                                    } catch (deleteTravelError) {
                                                        context.log.error(`Failed to delete travel day ${travelDayToDelete.id}:`, deleteTravelError);
                                                    }
                                                }
                                            }
                                        }
                                    } catch (crcError) {
                                        // Log error for this specific CRC but continue processing others
                                        context.log.error(`Error processing travel day preferences for CRC ${crcId}:`, crcError);
                                    }
                                }
                            } else if (result.travelDayPreferences === null || result.travelDayPreferences === undefined) {
                                // If travelDayPreferences is removed entirely, check if we should clean up travel days
                                // Only delete travel days that were created for this specific shift (we can't easily track this, so we'll be conservative)
                                // Actually, let's not delete automatically - let the user manage travel days explicitly
                            }
                            }
                        } catch (travelDayError) {
                            // Log but don't fail the shift update if travel day creation fails
                            context.log.error(`Error handling travel days from travelDayPreferences:`, travelDayError);
                            context.log.error(`Travel day error stack:`, travelDayError.stack);
                            // Don't rethrow - let the shift update succeed even if travel day handling fails
                        }
                    }
                    
                    // Triggered emails: shift edit
                    if (containerName === 'events' && result && result.type === 'Site Assignment') {
                        try { await processEmailTriggers(context, { triggerType: 'shift_edit', event: result }); } catch (triggerErr) {
                            context.log.warn('processEmailTriggers (shift_edit) failed:', triggerErr.message);
                        }
                    }
                    // Triggered emails: schedule finalized
                    if (containerName === 'schedules' && updateId && String(updateId).startsWith('schedule-finalized-') && result && result.finalized) {
                        try { await processEmailTriggers(context, { triggerType: 'finalized_schedule', scheduleMonthKey: result.monthKey, eventsSnapshot: result.events || [] }); } catch (triggerErr) {
                            context.log.warn('processEmailTriggers (finalized_schedule) failed:', triggerErr.message);
                        }
                    }
                    
                    return { jsonBody: result };
                } catch (upsertError) {
                    context.log.error(`Error upserting ${containerName} item:`, upsertError.message || upsertError);
                    return {
                        status: 500,
                        jsonBody: { error: `Failed to update ${containerName}: ${upsertError.message || 'Unknown error'}` },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }

            case 'DELETE':
                if (!id) return { status: 400, jsonBody: { error: 'id is required' } };
                try {
                    // Check if resource exists first
                    let resource = null;
                    try {
                        const readResult = await container.item(id, id).read();
                        resource = readResult.resource || null;
                        if (!resource) {
                            // Treat missing as already deleted
                            return { status: 204 };
                        }
                    } catch (readError) {
                        // If read fails (e.g., not found), return 204 for idempotency
                        const errorCode = readError.code || readError.statusCode;
                        const errorMessage = (readError.message || '').toLowerCase();
                        if (errorCode === 404 || 
                            errorMessage.includes('notfound') || 
                            errorMessage.includes('not found')) {
                            return { status: 204 };
                        }
                        // For other read errors, log but continue to try delete
                        context.log.warn(`Error reading ${containerName} ${id} before delete:`, readError.message);
                    }
                    
                    // AUDIT LOG: Record what's being deleted for debugging/recovery
                    if (containerName === 'events' && resource) {
                        context.log.info(`[AUDIT DELETE] Event ${id} | Type: ${resource.type} | Date: ${resource.date} | Site: ${resource.siteId} | CRCs: ${JSON.stringify(resource.crcIds || resource.crcId)} | RoleAssignments: ${JSON.stringify(Object.keys(resource.roleAssignments || {}))}`);
                    }
                    
                    // If deleting a Site Assignment shift, also delete associated travel days
                    if (containerName === 'events' && resource && resource.type === 'Site Assignment' && resource.date) {
                        try {
                            const eventsContainer = getContainer('events');
                            
                            // Collect all CRC IDs assigned to this shift
                            const shiftCrcIds = new Set();
                            
                            // Add crcId if present
                            if (resource.crcId && resource.crcId.trim() !== '' && resource.crcId !== 'SITE_STAFF' && resource.crcId !== 'UNASSIGNED') {
                                shiftCrcIds.add(resource.crcId);
                            }
                            
                            // Add crcIds array if present
                            if (resource.crcIds && Array.isArray(resource.crcIds)) {
                                resource.crcIds.forEach(crcId => {
                                    if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                        shiftCrcIds.add(crcId);
                                    }
                                });
                            }
                            
                            // Add CRCs from roleAssignments
                            if (resource.roleAssignments && typeof resource.roleAssignments === 'object') {
                                Object.values(resource.roleAssignments).forEach(assignments => {
                                    if (Array.isArray(assignments)) {
                                        assignments.forEach(crcId => {
                                            if (crcId && crcId.trim() !== '' && crcId !== 'SITE_STAFF' && crcId !== 'UNASSIGNED') {
                                                shiftCrcIds.add(crcId);
                                            }
                                        });
                                    }
                                });
                            }
                            
                            // Find and delete travel days for these CRCs on this date
                            if (shiftCrcIds.size > 0) {
                                const { resources: travelDays } = await eventsContainer.items.query({
                                    query: "SELECT * FROM c WHERE c.type = 'Travel Day' AND c.date = @date",
                                    parameters: [
                                        { name: "@date", value: resource.date }
                                    ]
                                }).fetchAll();
                                
                                // Delete travel days that belong to CRCs assigned to this shift
                                for (const travelDay of (travelDays || [])) {
                                    if (!travelDay || travelDay.type !== 'Travel Day') continue;
                                    
                                    // Check if this travel day belongs to any CRC in the shift
                                    let shouldDelete = false;
                                    
                                    if (travelDay.crcId && shiftCrcIds.has(travelDay.crcId)) {
                                        shouldDelete = true;
                                    } else if (travelDay.crcIds && Array.isArray(travelDay.crcIds)) {
                                        // If travel day has multiple CRCs, only delete if ALL of them are in the shift
                                        // OR if it's a single CRC travel day that matches
                                        const travelDayCrcs = travelDay.crcIds.filter(id => id && id.trim() !== '' && id !== 'SITE_STAFF' && id !== 'UNASSIGNED');
                                        if (travelDayCrcs.length === 1 && shiftCrcIds.has(travelDayCrcs[0])) {
                                            shouldDelete = true;
                                        } else if (travelDayCrcs.length > 1) {
                                            // For multi-CRC travel days, only delete if all CRCs are being removed from the shift
                                            const allCrcsInShift = travelDayCrcs.every(crcId => shiftCrcIds.has(crcId));
                                            if (allCrcsInShift) {
                                                shouldDelete = true;
                                            }
                                        }
                                    }
                                    
                                    if (shouldDelete) {
                                        try {
                                            await eventsContainer.item(travelDay.id, travelDay.id).delete();
                                            context.log.info(`Deleted travel day ${travelDay.id} because shift ${id} was deleted`);
                                        } catch (deleteTravelError) {
                                            context.log.warn(`Failed to delete travel day ${travelDay.id}: ${deleteTravelError.message}`);
                                        }
                                    }
                                }
                            }
                        } catch (travelDeleteError) {
                            // Log but don't fail the shift deletion if travel day deletion fails
                            context.log.warn(`Error deleting travel days for shift ${id}:`, travelDeleteError.message);
                        }
                    }
                    
                    // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                    try {
                        await container.item(id, id).delete();
                        return { status: 204 };
                    } catch (deleteError) {
                        // If delete fails with not found, treat as success (idempotency)
                        const errorCode = deleteError.code || deleteError.statusCode;
                        const errorMessage = (deleteError.message || '').toLowerCase();
                        if (errorCode === 404 || 
                            errorMessage.includes('notfound') || 
                            errorMessage.includes('not found')) {
                            return { status: 204 };
                        }
                        // Re-throw other errors
                        throw deleteError;
                    }
                } catch (error) {
                    context.log.error(`Error deleting ${containerName} ${id}:`, error.message || error);
                    return handleError(context, error, `Failed to delete ${containerName} with id ${id}`);
                }

            case 'OPTIONS':
                return { status: 200 };

            default:
                return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
        }
    } catch (error) {
        // Special handling for travel container - if it doesn't exist yet, return empty array for GET requests
        // This is a new container that might not exist yet, so we're defensive about errors
        if (containerName === 'travel' && method === 'GET') {
            const errorCode = error.code || error.statusCode;
            const errorMessage = (error.message || '').toLowerCase();
            
            // Log the error for debugging
            context.log.warn(`Error accessing travel container (might not exist yet):`, error.message);
            
            // If it's any kind of not-found or container-related error, return empty array
            // Also catch any other errors that might occur when container doesn't exist
            if (errorCode === 404 || 
                errorCode === 400 ||
                errorMessage.includes('notfound') || 
                errorMessage.includes('container') || 
                errorMessage.includes('does not exist') ||
                errorMessage.includes('not found') ||
                errorMessage.includes('bad request')) {
                context.log.warn(`Container '${containerName}' does not exist yet, returning empty array`);
                return { 
                    jsonBody: [],
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // For any other error on travel GET, also return empty array to prevent 500 errors
            // This is safe because GET requests are idempotent and returning empty array is valid
            context.log.warn(`Unexpected error accessing travel container, returning empty array:`, error.message);
            return { 
                jsonBody: [],
                headers: { 'Content-Type': 'application/json' }
            };
        }
        
        return handleError(context, error, `Database operation failed on ${containerName}`);
    }
}

// =================================================================================
// V4 FUNCTION REGISTRATION
// =================================================================================

app.http('studies', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'studies/{id?}', 
    handler: (request, context) => crudHandler(context, request, 'studies'),
});

app.http('sites', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'sites/{id?}',
    handler: (request, context) => crudHandler(context, request, 'sites'),
});

app.http('patients', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'patients/{id?}',
    handler: (request, context) => crudHandler(context, request, 'patients'),
});

app.http('crcs', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'crcs/{id?}',
    handler: (request, context) => crudHandler(context, request, 'crcs'),
});

app.http('events', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'events/{id?}',
    handler: (request, context) => crudHandler(context, request, 'events'),
});

app.http('roles', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'roles/{id?}',
    handler: (request, context) => crudHandler(context, request, 'roles'),
});

app.http('training-types', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'training-types/{id?}',
    handler: async (request, context) => {
        try {
            // Build training types dynamically from CRC embedded trainings
            const container = getContainer('crcs');
            const { resources: crcs } = await container.items.readAll().fetchAll();
            const names = new Set();
            (crcs || []).forEach(crc => {
                (crc.trainings || []).forEach(t => {
                    if (t && typeof t.name === 'string' && t.name.trim() !== '') {
                        names.add(t.name.trim());
                    }
                });
            });
            const result = Array.from(names).sort().map(n => ({ id: n, name: n }));
            return { jsonBody: result };
        } catch (error) {
            return handleError(context, error, 'Build training-types from CRCs');
        }
    },
});

app.http('schedules', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'schedules/{id?}',
    handler: (request, context) => crudHandler(context, request, 'schedules'),
});

app.http('surveys', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'surveys/{id?}',
    handler: (request, context) => crudHandler(context, request, 'surveys'),
});

app.http('travel', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'travel/{id?}',
    handler: (request, context) => crudHandler(context, request, 'travel'),
});

app.http('announcements', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'announcements/{id?}',
    handler: (request, context) => crudHandler(context, request, 'announcements'),
});

// Announcement reactions endpoint - allows CRCs to mark announcements as read/reacted
app.http('announcementReactions', {
    methods: ['POST', 'PUT', 'GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'announcements/{id}/reactions',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return { status: 200 };
        }
        
        try {
            const announcementsContainer = getContainer('announcements');
            const id = getIdFromRequest(request);
            
            if (!id) {
                return {
                    status: 400,
                    jsonBody: { error: 'Announcement ID is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Get the announcement
            let announcement;
            try {
                const { resource } = await announcementsContainer.item(id, id).read();
                if (!resource) {
                    return {
                        status: 404,
                        jsonBody: { error: 'Announcement not found' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                announcement = resource;
            } catch (readError) {
                return {
                    status: 404,
                    jsonBody: { error: 'Announcement not found' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Initialize reactions if not present
            if (!announcement.reactions) {
                announcement.reactions = {};
            }
            
            if (request.method === 'GET') {
                // Return current reactions
                return {
                    jsonBody: {
                        announcementId: id,
                        reactions: announcement.reactions || {}
                    }
                };
            }
            
            // POST/PUT: Add or update reaction
            const body = await request.json();
            const userId = body.userId || body.crcId || body.user || null;
            const reaction = body.reaction || 'read'; // Default to 'read', can be 'thumbsup', 'read', etc.
            
            if (!userId) {
                return {
                    status: 400,
                    jsonBody: { error: 'userId or crcId is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Store reaction with timestamp
            if (!announcement.reactions[userId]) {
                announcement.reactions[userId] = [];
            }
            
            // Check if user already reacted with this reaction type
            const existingReactionIndex = announcement.reactions[userId].findIndex(r => r.type === reaction);
            const reactionData = {
                type: reaction,
                timestamp: new Date().toISOString()
            };
            
            if (existingReactionIndex >= 0) {
                // Update existing reaction
                announcement.reactions[userId][existingReactionIndex] = reactionData;
            } else {
                // Add new reaction
                announcement.reactions[userId].push(reactionData);
            }
            
            // Update announcement
            const { resource: updatedAnnouncement } = await announcementsContainer.items.upsert(announcement);
            
            return {
                jsonBody: {
                    announcementId: id,
                    userId: userId,
                    reaction: reaction,
                    reactions: updatedAnnouncement.reactions || {}
                }
            };
        } catch (error) {
            return handleError(context, error, 'Announcement reaction operation failed');
        }
    },
});

// Schedule export endpoints - for CRC dashboard "Print my schedule" buttons
app.http('scheduleExport', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'schedule-export/{crcId}',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return { status: 200 };
        }
        
        try {
            const crcId = getIdFromRequest(request);
            if (!crcId) {
                return {
                    status: 400,
                    jsonBody: { error: 'CRC ID is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Get query parameters
            const query = request.query || {};
            const period = (typeof query.get === 'function' ? query.get('period') : query.period) || 'weekly'; // 'weekly' or 'monthly'
            const format = (typeof query.get === 'function' ? query.get('format') : query.format) || 'excel'; // 'excel' or 'ical'
            
            // Calculate date range
            const today = new Date();
            let startDate, endDate;
            
            if (period === 'monthly') {
                // First day of current month to last day of current month
                startDate = new Date(today.getFullYear(), today.getMonth(), 1);
                endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
            } else {
                // Weekly: Monday to Sunday of current week
                const dayOfWeek = today.getDay();
                const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust when day is Sunday
                startDate = new Date(today.setDate(diff));
                startDate.setHours(0, 0, 0, 0);
                endDate = new Date(startDate);
                endDate.setDate(endDate.getDate() + 6);
                endDate.setHours(23, 59, 59, 999);
            }
            
            const startDateStr = toDateOnlyString(startDate);
            const endDateStr = toDateOnlyString(endDate);
            
            // Get CRC name
            const crcsContainer = getContainer('crcs');
            let crcName = crcId;
            try {
                const { resource: crc } = await crcsContainer.item(crcId, crcId).read();
                if (crc && crc.name) {
                    crcName = crc.name;
                }
            } catch (e) {
                context.log.warn(`Could not load CRC ${crcId} for schedule export: ${e.message}`);
            }
            
            // Build schedule context
            const scheduleContext = await buildRecipientEmailContext({
                crcId: crcId,
                startDate: startDateStr,
                endDate: endDateStr
            }, context);
            
            const shifts = scheduleContext.schedule?.shifts || [];
            const timeOff = [
                ...(scheduleContext.timeOff?.requests || []),
                ...(scheduleContext.timeOff?.events || [])
            ];
            const travel = scheduleContext.travel?.records || [];
            
            // Generate export based on format
            if (format === 'ical') {
                const icalContent = buildScheduleIcal({
                    crcName: crcName,
                    startDate: startDateStr,
                    endDate: endDateStr,
                    shifts: shifts,
                    timeOff: timeOff,
                    travel: travel
                });
                
                const filename = `schedule_${crcName.replace(/[^a-z0-9]+/gi, '_')}_${period}_${startDateStr}_${endDateStr}.ics`;
                
                return {
                    status: 200,
                    body: icalContent,
                    headers: {
                        'Content-Type': 'text/calendar; charset=utf-8',
                        'Content-Disposition': `attachment; filename="${filename}"`
                    }
                };
            } else {
                // Excel format (CSV)
                const csvContent = buildScheduleCsv({
                    crcName: crcName,
                    startDate: startDateStr,
                    endDate: endDateStr,
                    shifts: shifts,
                    timeOff: timeOff,
                    travel: travel
                });
                
                const filename = `schedule_${crcName.replace(/[^a-z0-9]+/gi, '_')}_${period}_${startDateStr}_${endDateStr}.csv`;
                
                return {
                    status: 200,
                    body: csvContent,
                    headers: {
                        'Content-Type': 'text/csv; charset=utf-8',
                        'Content-Disposition': `attachment; filename="${filename}"`
                    }
                };
            }
        } catch (error) {
            return handleError(context, error, 'Schedule export failed');
        }
    },
});

app.http('templates', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'templates/{id?}',
    handler: (request, context) => crudHandler(context, request, 'templates'),
});

// ---------------------------------------------------------------------------------
// TRIGGERED EMAILS: process rules when events occur (new shift, shift edit, finalized schedule, PTO request)
// ---------------------------------------------------------------------------------
const TRIGGER_DEFAULTS = {
    new_shift: { subject: 'New shift assigned', body: 'A new shift has been added to the schedule.' },
    shift_edit: { subject: 'Shift updated', body: 'A shift has been updated on the schedule.' },
    finalized_schedule: { subject: 'Schedule finalized', body: 'The schedule has been finalized for the month.' },
    pto_request: { subject: 'Time off request submitted', body: 'A time off request has been submitted for approval.' },
    pto_approved: { subject: 'Time off approved', body: 'Your time off request has been approved.' }
};

async function processEmailTriggers(context, payload) {
    const { triggerType, event, timeOffRequest, scheduleMonthKey, eventsSnapshot } = payload || {};
    if (!triggerType || !context) return;
    const log = context.log || console;
    try {
        await ensureEmailTriggersContainer();
        const triggersContainer = getContainer('email-triggers');
        const { resources: rules } = await triggersContainer.items.query({
            query: 'SELECT * FROM c WHERE c.enabled = true AND c.triggerType = @triggerType',
            parameters: [{ name: '@triggerType', value: triggerType }]
        }).fetchAll();
        if (!rules || rules.length === 0) return;

        // For pto_request and pto_approved, filter rules by ptoTypes if specified (rule applies only to selected types)
        let filteredRules = rules;
        if ((triggerType === 'pto_request' || triggerType === 'pto_approved') && timeOffRequest) {
            const requestType = (timeOffRequest.type || 'Time Off').trim();
            filteredRules = rules.filter(rule => {
                const ptoTypes = rule.ptoTypes;
                if (!ptoTypes || !Array.isArray(ptoTypes) || ptoTypes.length === 0) return true;
                return ptoTypes.some(t => String(t).trim().toLowerCase() === requestType.toLowerCase());
            });
        }

        const senderAddress = process.env.EMAIL_SENDER_ADDRESS;
        if (!senderAddress) {
            log.warn('processEmailTriggers: EMAIL_SENDER_ADDRESS not set, skipping');
            return;
        }

        const usersContainer = getContainer('users');
        const crcsContainer = getContainer('crcs');
        const { resources: userList } = await usersContainer.items.readAll().fetchAll();
        const { resources: crcList } = await crcsContainer.items.readAll().fetchAll();
        const usersById = new Map((userList || []).filter(u => u && u.id).map(u => [u.id, u]));
        const usersByCrcId = new Map((userList || []).filter(u => u && u.crcId).map(u => [u.crcId, u]));
        const crcsById = new Map((crcList || []).filter(c => c && c.id).map(c => [c.id, c]));

        const resolveToEmails = (crcIds, userIdsOrEmails) => {
            const out = [];
            const seen = new Set();
            if (Array.isArray(crcIds)) {
                crcIds.forEach(crcId => {
                    if (!crcId || seen.has(crcId)) return;
                    seen.add(crcId);
                    const user = usersByCrcId.get(crcId);
                    const crc = crcsById.get(crcId);
                    const email = user?.email || crc?.email;
                    if (email) out.push({ email: email.trim(), displayName: user?.name || user?.username || crc?.name || email });
                });
            }
            if (Array.isArray(userIdsOrEmails)) {
                userIdsOrEmails.forEach(id => {
                    if (!id || seen.has(id)) return;
                    seen.add(id);
                    if (String(id).includes('@')) {
                        out.push({ email: id.trim(), displayName: id });
                        return;
                    }
                    const user = usersById.get(id);
                    if (user && user.email) {
                        out.push({ email: user.email.trim(), displayName: user.name || user.username || user.email });
                        return;
                    }
                    const crc = crcsById.get(id);
                    const u2 = usersByCrcId.get(id);
                    const email = (u2 && u2.email) || (crc && crc.email);
                    if (email) out.push({ email: email.trim(), displayName: (u2 && (u2.name || u2.username)) || crc?.name || email });
                });
            }
            return out;
        };

        const getCrcIdsFromEvent = (ev) => {
            const set = new Set();
            if (!ev) return set;
            if (ev.crcId && ev.crcId !== 'SITE_STAFF' && ev.crcId !== 'UNASSIGNED') set.add(ev.crcId);
            if (Array.isArray(ev.crcIds)) ev.crcIds.forEach(id => { if (id && id !== 'SITE_STAFF' && id !== 'UNASSIGNED') set.add(id); });
            if (ev.roleAssignments && typeof ev.roleAssignments === 'object') {
                Object.values(ev.roleAssignments).forEach(assignments => {
                    if (Array.isArray(assignments)) assignments.forEach(id => { if (id && id !== 'SITE_STAFF' && id !== 'UNASSIGNED') set.add(id); });
                });
            }
            return set;
        };

        const getManagerEmails = () => {
            return (userList || [])
                .filter(u => u && (u.permissionLevel || '').toLowerCase() === 'manager')
                .map(u => ({ email: (u.email || '').trim(), displayName: u.name || u.username || u.email }))
                .filter(r => r.email);
        };

        const getCrcDisplayName = (crcId) => {
            const user = usersByCrcId.get(crcId);
            const crc = crcsById.get(crcId);
            return (user && (user.name || user.username)) || (crc && crc.name) || crcId || '';
        };

        const buildTriggerContext = () => {
            const base = { triggerType };
            if ((triggerType === 'pto_request' || triggerType === 'pto_approved') && timeOffRequest) {
                const start = timeOffRequest.startDate || timeOffRequest.date;
                const end = timeOffRequest.endDate || timeOffRequest.date || timeOffRequest.startDate;
                let ptoDates = '';
                if (start && end && String(start).trim() !== String(end).trim()) {
                    ptoDates = `${String(start).split('T')[0]} – ${String(end).split('T')[0]}`;
                } else {
                    ptoDates = start ? String(start).split('T')[0] : (timeOffRequest.date ? String(timeOffRequest.date).split('T')[0] : '');
                }
                return {
                    ...base,
                    ptoType: timeOffRequest.type || 'Time Off',
                    ptoDates,
                    startDate: start ? String(start).split('T')[0] : '',
                    endDate: end ? String(end).split('T')[0] : '',
                    date: timeOffRequest.date ? String(timeOffRequest.date).split('T')[0] : '',
                    crcId: timeOffRequest.crcId || '',
                    crcName: getCrcDisplayName(timeOffRequest.crcId),
                    requestId: timeOffRequest.id || '',
                    status: timeOffRequest.status || 'pending',
                    requestedBy: timeOffRequest.requestedBy || ''
                };
            }
            if ((triggerType === 'new_shift' || triggerType === 'shift_edit') && event) {
                const crcIds = Array.from(getCrcIdsFromEvent(event));
                const crcNames = crcIds.map(getCrcDisplayName).filter(Boolean).join(', ') || '—';
                const eventDate = event.date || event.startDate || '';
                return {
                    ...base,
                    eventId: event.id || '',
                    eventDate: eventDate ? String(eventDate).split('T')[0] : '',
                    eventType: event.type || event.name || 'Shift',
                    crcNames,
                    siteId: event.siteId || '',
                    studyIds: Array.isArray(event.studyIds) ? event.studyIds.join(', ') : (event.studyId || '')
                };
            }
            if (triggerType === 'finalized_schedule') {
                const count = Array.isArray(eventsSnapshot) ? eventsSnapshot.length : 0;
                return { ...base, scheduleMonthKey: scheduleMonthKey || '', eventCount: String(count) };
            }
            return base;
        };

        const emailClient = getEmailClient();
        const defaults = TRIGGER_DEFAULTS[triggerType] || { subject: 'Notification', body: 'You have a notification.' };

        for (const rule of filteredRules) {
            let recipients = [];
            if (rule.sendTo === 'on_shift') {
                if ((triggerType === 'pto_request' || triggerType === 'pto_approved') && timeOffRequest && timeOffRequest.crcId) {
                    recipients = resolveToEmails([timeOffRequest.crcId], []);
                } else if (event) {
                    recipients = resolveToEmails(Array.from(getCrcIdsFromEvent(event)), []);
                } else if (triggerType === 'finalized_schedule' && Array.isArray(eventsSnapshot)) {
                    const allCrcIds = new Set();
                    eventsSnapshot.forEach(ev => getCrcIdsFromEvent(ev).forEach(id => allCrcIds.add(id)));
                    recipients = resolveToEmails(Array.from(allCrcIds), []);
                }
            } else if (rule.sendTo === 'managers') {
                recipients = getManagerEmails();
            } else if (rule.sendTo === 'specific' && Array.isArray(rule.specificRecipientIds) && rule.specificRecipientIds.length > 0) {
                recipients = resolveToEmails([], rule.specificRecipientIds);
            }
            if (recipients.length === 0) continue;

            let subject = rule.subject || defaults.subject;
            let plainText = rule.body || rule.plainText || defaults.body;
            if (rule.templateId) {
                try {
                    const templatesContainer = getContainer('templates');
                    const { resource: template } = await templatesContainer.item(rule.templateId, rule.templateId).read();
                    if (template) {
                        subject = template.subject || template.title || subject;
                        plainText = template.plainText || template.text || template.html || template.bodyHtml || template.body || plainText;
                    }
                } catch (e) {
                    log.warn(`processEmailTriggers: template ${rule.templateId} not found, using defaults`);
                }
            }

            const triggerContext = buildTriggerContext();
            subject = renderTemplateString(subject, triggerContext);
            plainText = renderTemplateString(plainText, triggerContext);

            for (const r of recipients) {
                if (!r.email) continue;
                try {
                    const message = {
                        senderAddress,
                        content: { subject, plainText },
                        recipients: { to: [{ address: r.email, displayName: r.displayName || undefined }] }
                    };
                    await emailClient.beginSend(message).then(p => p.pollUntilDone());
                    log.info(`Triggered email sent to ${r.email} for rule ${rule.id} (${triggerType})`);
                } catch (sendErr) {
                    log.warn(`Triggered email failed to ${r.email}: ${sendErr.message}`);
                }
            }
        }
    } catch (err) {
        log.warn(`processEmailTriggers failed: ${err.message}`);
    }
}

app.http('email-triggers', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'email-triggers/{id?}',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
        }
        let container;
        try {
            await ensureEmailTriggersContainer();
            container = getContainer('email-triggers');
        } catch (e) {
            context.log.error('Error getting email-triggers container:', e);
            return { status: 500, jsonBody: { error: 'Database container error. Ensure the email-triggers container exists.' }, headers: { 'Content-Type': 'application/json' } };
        }
        const id = (request.params && request.params.id) || (request.query && request.query.id);
        const { method } = request;
        try {
            if (method === 'GET') {
                if (id) {
                    try {
                        const { resource } = await container.item(id, id).read();
                        if (!resource) return { status: 404, jsonBody: { error: 'Not found' } };
                        return { jsonBody: resource };
                    } catch (e) {
                        return { status: 404, jsonBody: { error: 'Not found' } };
                    }
                }
                const { resources } = await container.items.readAll().fetchAll();
                return { jsonBody: resources || [] };
            }
            if (method === 'POST') {
                const body = await request.json();
                const newItem = {
                    id: generateId(),
                    name: body.name || '',
                    triggerType: body.triggerType || 'new_shift',
                    ptoTypes: Array.isArray(body.ptoTypes) ? body.ptoTypes : [],
                    sendTo: body.sendTo || 'managers',
                    specificRecipientIds: Array.isArray(body.specificRecipientIds) ? body.specificRecipientIds : [],
                    templateId: body.templateId || null,
                    subject: body.subject || null,
                    body: body.body || null,
                    enabled: body.enabled !== false,
                    createdAt: new Date().toISOString()
                };
                const { resource } = await container.items.create(newItem);
                return { status: 201, jsonBody: resource };
            }
            if (method === 'PUT') {
                const body = await request.json();
                const updateId = id || body.id;
                if (!updateId) return { status: 400, jsonBody: { error: 'id required' } };
                const updated = {
                    ...body,
                    id: updateId,
                    name: body.name !== undefined ? body.name : undefined,
                    triggerType: body.triggerType !== undefined ? body.triggerType : undefined,
                    ptoTypes: Array.isArray(body.ptoTypes) ? body.ptoTypes : undefined,
                    sendTo: body.sendTo !== undefined ? body.sendTo : undefined,
                    specificRecipientIds: Array.isArray(body.specificRecipientIds) ? body.specificRecipientIds : undefined,
                    templateId: body.templateId !== undefined ? body.templateId : undefined,
                    subject: body.subject !== undefined ? body.subject : undefined,
                    body: body.body !== undefined ? body.body : undefined,
                    enabled: body.enabled !== undefined ? body.enabled : undefined
                };
                Object.keys(updated).forEach(k => { if (updated[k] === undefined) delete updated[k]; });
                const { resource } = await container.items.upsert(updated);
                return { jsonBody: resource };
            }
            if (method === 'DELETE') {
                if (!id) return { status: 400, jsonBody: { error: 'id required' } };
                try {
                    await container.item(id, id).delete();
                } catch (e) { /* ignore */ }
                return { status: 204 };
            }
            return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
        } catch (err) {
            return handleError(context, err, 'email-triggers operation failed');
        }
    }
});

app.http('send-email', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'send-email',
    handler: async (request, context) => {
        // Handle OPTIONS request for CORS
        if (request.method === 'OPTIONS') {
            return {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                }
            };
        }

        try {
            const body = await request.json();

            const senderAddress = process.env.EMAIL_SENDER_ADDRESS;
            if (!senderAddress) {
                return {
                    status: 500,
                    jsonBody: { error: 'Email sender address missing. Set EMAIL_SENDER_ADDRESS in app settings.' },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }

            // Payload shape:
            // {
            //   templateId?: string,
            //   template?: { subject?: string, html?: string, plainText?: string },
            //   recipients: [{ userId?: string, email?: string, crcId?: string, name?: string }],
            //   range?: { startDate?: string, endDate?: string },
            //   attachments?: [{ name, contentType, contentInBase64, contentId? }],
            //   attachPersonalizedCsv?: boolean
            // }
            const recipients = Array.isArray(body.recipients) ? body.recipients : [];
            if (recipients.length === 0) {
                return {
                    status: 400,
                    jsonBody: { error: 'recipients is required' },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }

            const rangeStart = body.range?.startDate || body.startDate || null;
            const rangeEnd = body.range?.endDate || body.endDate || null;

            let template = body.template && typeof body.template === 'object' ? body.template : null;
            if (!template && body.templateId) {
                try {
                    const templatesContainer = getContainer('templates');
                    const { resource } = await templatesContainer.item(body.templateId, body.templateId).read();
                    template = resource || null;
                } catch (e) {
                    return {
                        status: 404,
                        jsonBody: { error: 'Template not found', detail: e.message },
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    };
                }
            }
            if (!template) {
                return {
                    status: 400,
                    jsonBody: { error: 'templateId or template is required' },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }

            // Normalize attachments (applies to all recipients)
            const baseAttachments = Array.isArray(body.attachments) ? body.attachments : [];
            const attachments = baseAttachments
                .filter(a => a && a.name && a.contentType && a.contentInBase64)
                .map(a => ({
                    name: String(a.name),
                    contentType: String(a.contentType),
                    contentInBase64: String(a.contentInBase64),
                    ...(a.contentId ? { contentId: String(a.contentId) } : {})
                }));

            const attachPersonalizedCsv = !!body.attachPersonalizedCsv;

            // Resolve user → email/crcId if needed
            const usersContainer = getContainer('users');
            const crcsContainer = getContainer('crcs');
            const { resources: crcList } = await crcsContainer.items.readAll().fetchAll();
            const crcResolver = buildCrcResolver(crcList || []);
            // Lookups for sites/studies/roles so template variables can include names/locations/details
            const siteNameById = new Map();
            const siteLocationById = new Map();
            const siteDetailsById = new Map();
            const studyNameById = new Map();
            const studyDetailsById = new Map();
            const roleNameById = new Map();
            try {
                const sitesContainer = getContainer('sites');
                const { resources: sites } = await sitesContainer.items.readAll().fetchAll();
                (sites || []).forEach(s => {
                    if (!s || !s.id) return;
                    const name = s.name || s.siteName || s.title || s.id;
                    siteNameById.set(s.id, name);
                    siteDetailsById.set(s.id, s);
                    const location = [
                        s.address1,
                        s.city,
                        s.state,
                        s.zipCode || s.zip,
                        s.country
                    ].filter(Boolean).join(', ');
                    const fallbackLocation = [s.city, s.state].filter(Boolean).join(', ');
                    siteLocationById.set(s.id, location || fallbackLocation || '');
                });
            } catch (e) {
                context?.log?.warn?.(`Failed to load sites for email lookups: ${e.message}`);
            }
            try {
                const studiesContainer = getContainer('studies');
                const { resources: studies } = await studiesContainer.items.readAll().fetchAll();
                (studies || []).forEach(st => {
                    if (!st || !st.id) return;
                    const title = st.title || st.name || st.protocolNumber || st.id;
                    studyNameById.set(st.id, title);
                    studyDetailsById.set(st.id, st);
                });
            } catch (e) {
                context?.log?.warn?.(`Failed to load studies for email lookups: ${e.message}`);
            }
            try {
                const rolesContainer = getContainer('roles');
                const { resources: roles } = await rolesContainer.items.readAll().fetchAll();
                (roles || []).forEach(r => {
                    if (!r || !r.id) return;
                    roleNameById.set(r.id, r.name || r.id);
                });
            } catch (e) {
                context?.log?.warn?.(`Failed to load roles for email lookups: ${e.message}`);
            }

            const emailClient = getEmailClient();

            const results = [];
            let sent = 0;
            let failed = 0;

            for (const r of recipients) {
                try {
                    let email = r.email ? String(r.email).trim() : '';
                    let crcId = r.crcId ? String(r.crcId).trim() : '';
                    let displayName = r.name ? String(r.name) : '';

                    if (r.userId && (!email || !crcId || !displayName)) {
                        try {
                            const userId = String(r.userId);
                            const { resource: user } = await usersContainer.item(userId, userId).read();
                            if (user) {
                                if (!email && user.email) email = String(user.email).trim();
                                if (!crcId && user.crcId) crcId = String(user.crcId).trim();
                                if (!displayName) displayName = user.name || user.username || user.email || '';
                            }
                        } catch (e) {
                            // continue; we can still send if email provided
                        }
                    }

                    if (!crcId && email) {
                        const key = email.toLowerCase();
                        if (crcResolver.byEmail.has(key)) {
                            crcId = crcResolver.byEmail.get(key).id;
                        }
                    }

                    if (!email) {
                        throw new Error('Recipient email missing');
                    }

                    const ctx = await buildRecipientEmailContext(
                        { crcId, startDate: rangeStart, endDate: rangeEnd, recipient: r, user: { id: r.userId || null, email, name: displayName, crcId } },
                        context,
                        { siteNameById, siteLocationById, siteDetailsById, studyNameById, studyDetailsById, roleNameById }
                    );
                    const subjectTpl = template.subject || template.title || 'Message';
                    const plainTpl = template.plainText || template.text || template.html || template.bodyHtml || template.body || '';

                    const subject = renderTemplateString(subjectTpl, ctx);
                    const plainText = renderTemplateString(plainTpl, ctx);

                    const perRecipientAttachments = [...attachments];
                    if (attachPersonalizedCsv) {
                        const csv = buildScheduleCsv({
                            crcName: ctx.crc?.name || ctx.crcName,
                            startDate: ctx.range?.start,
                            endDate: ctx.range?.end,
                            shifts: (ctx.schedule?.shifts || []).map(s => ({ ...s, summary: s.summary })),
                            timeOff: [
                                ...(ctx.timeOff?.requests || []),
                                ...(ctx.timeOff?.events || [])
                            ],
                            travel: (ctx.travel?.records || [])
                        });
                        perRecipientAttachments.push({
                            name: `schedule_${(ctx.crc?.name || 'recipient').replace(/[^a-z0-9]+/gi, '_')}_${ctx.range?.start || ''}_${ctx.range?.end || ''}.csv`,
                            contentType: 'text/csv',
                            contentInBase64: Buffer.from(csv, 'utf8').toString('base64')
                        });
                    }

                    const message = {
                        senderAddress,
                        content: {
                            subject,
                            ...(plainText ? { plainText } : {})
                        },
                        recipients: {
                            to: [{ address: email, displayName: displayName || undefined }]
                        },
                        ...(perRecipientAttachments.length > 0 ? { attachments: perRecipientAttachments } : {})
                    };

                    const poller = await emailClient.beginSend(message);
                    const sendResult = await poller.pollUntilDone();
                    sent += 1;
                    results.push({
                        recipient: { email, crcId: crcId || null, name: displayName || null },
                        status: 'sent',
                        messageId: sendResult?.id || null
                    });
                } catch (e) {
                    failed += 1;
                    results.push({
                        recipient: { email: r.email || null, crcId: r.crcId || null, userId: r.userId || null },
                        status: 'failed',
                        error: e.message || String(e)
                    });
                }
            }

            return {
                status: 200,
                jsonBody: { sent, failed, results },
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        } catch (error) {
            return handleError(context, error, 'Send email failed');
        }
    }
});

app.http('timeOffRequestsBulkDelete', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'time-off-requests/bulk-delete',
    handler: async (request, context) => {
        // Handle OPTIONS request for CORS
        if (request.method === 'OPTIONS') {
            return {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                }
            };
        }

        try {
            const body = await request.json();
            const crcId = body?.crcId ? String(body.crcId).trim() : '';
            const startDate = toDateOnlyString(body?.startDate || body?.range?.startDate);
            const endDate = toDateOnlyString(body?.endDate || body?.range?.endDate);
            const statuses = Array.isArray(body?.statuses) ? body.statuses.map(s => String(s || '').toLowerCase()) : null;
            const limitRaw = Number(body?.limit);
            const limit = Number.isFinite(limitRaw) ? Math.max(25, Math.min(limitRaw, 500)) : 200;

            if (!crcId || !startDate || !endDate) {
                return {
                    status: 400,
                    jsonBody: { error: 'crcId, startDate, and endDate are required' },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }
            if (startDate > endDate) {
                return {
                    status: 400,
                    jsonBody: { error: 'startDate must be <= endDate' },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }

            const container = getContainer('time-off-requests');

            // Cosmos doesn't allow parametrized TOP; embed the validated number.
            const querySpec = {
                query:
                    `SELECT TOP ${limit} c.id, c.status, c.date, c.startDate ` +
                    `FROM c WHERE c.crcId = @crcId ` +
                    `AND ((c.date >= @start AND c.date <= @end) OR (c.startDate >= @start AND c.startDate <= @end))`,
                parameters: [
                    { name: '@crcId', value: crcId },
                    { name: '@start', value: startDate },
                    { name: '@end', value: endDate }
                ]
            };

            const { resources } = await container.items.query(querySpec, { maxItemCount: limit }).fetchAll();
            let candidates = Array.isArray(resources) ? resources : [];

            if (statuses && statuses.length > 0 && !statuses.includes('all')) {
                const allowed = new Set(statuses.map(s => String(s).toLowerCase()));
                candidates = candidates.filter(r => {
                    const st = String(r?.status || '').toLowerCase();
                    return allowed.has(st);
                });
            }

            const ids = candidates.map(r => r.id).filter(Boolean);
            if (ids.length === 0) {
                return {
                    status: 200,
                    jsonBody: { deleted: 0, attempted: 0, done: true },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }

            // Delete with limited concurrency to avoid timeouts/RU spikes
            const concurrency = 25;
            let deleted = 0;
            let idx = 0;
            const worker = async () => {
                while (idx < ids.length) {
                    const current = ids[idx++];
                    try {
                        await container.item(current, current).delete();
                        deleted += 1;
                    } catch (e) {
                        // Ignore not-found to be idempotent
                        const code = e.code || e.statusCode;
                        if (code !== 404) {
                            context?.log?.warn?.(`Failed to delete time off request ${current}: ${e.message}`);
                        }
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));

            return {
                status: 200,
                jsonBody: { deleted, attempted: ids.length, done: ids.length < limit },
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        } catch (error) {
            return handleError(context, error, 'Bulk delete time off requests failed');
        }
    }
});

app.http('timeOffRequestsDedupe', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'time-off-requests/dedupe',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                }
            };
        }

        try {
            const body = await request.json();
            const crcId = body?.crcId ? String(body.crcId).trim() : '';
            const startDate = toDateOnlyString(body?.startDate || body?.range?.startDate);
            const endDate = toDateOnlyString(body?.endDate || body?.range?.endDate);
            const dryRun = !!body?.dryRun;

            if (!crcId || !startDate || !endDate) {
                return {
                    status: 400,
                    jsonBody: { error: 'crcId, startDate, and endDate are required' },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }
            if (startDate > endDate) {
                return {
                    status: 400,
                    jsonBody: { error: 'startDate must be <= endDate' },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }

            const container = getContainer('time-off-requests');

            // Simple approach: query by CRC, filter in JS (more reliable than complex Cosmos queries)
            let candidates = [];
            try {
                const { resources: allForCrc } = await container.items
                    .query({
                        query: "SELECT * FROM c WHERE c.crcId = @crcId",
                        parameters: [{ name: "@crcId", value: crcId }]
                    })
                    .fetchAll();
                
                // Filter to date range in JS
                candidates = (Array.isArray(allForCrc) ? allForCrc : []).filter(req => {
                    const d = toDateOnlyString(req?.date || req?.startDate);
                    if (!d) return false;
                    return d >= startDate && d <= endDate;
                });
            } catch (queryError) {
                context?.log?.error?.(`Failed to query time off requests: ${queryError.message}`);
                return {
                    status: 500,
                    jsonBody: { error: 'Failed to query time off requests', detail: queryError.message },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }

            const groups = new Map(); // dateStr -> array
            const rangeLike = [];
            candidates.forEach(r => {
                const d = toDateOnlyString(r?.date || r?.startDate);
                const sd = toDateOnlyString(r?.startDate || r?.date);
                const ed = toDateOnlyString(r?.endDate || r?.startDate || r?.date);
                if (sd && ed && sd !== ed) {
                    rangeLike.push(r);
                }
                if (!d) return;
                if (!groups.has(d)) groups.set(d, []);
                groups.get(d).push(r);
            });

            const statusRank = (s) => {
                const v = String(s || '').toLowerCase();
                if (v === 'approved') return 3;
                if (v === 'pending') return 2;
                if (v === 'rejected') return 1;
                return 0;
            };

            const pickPrimary = (arr) => {
                return [...arr].sort((a, b) => {
                    const sr = statusRank(b.status) - statusRank(a.status);
                    if (sr !== 0) return sr;
                    const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                    const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                    return bT - aT;
                })[0];
            };

            const uniqueJoin = (vals) => {
                const out = [];
                const seen = new Set();
                vals.forEach(v => {
                    const s = String(v || '').trim();
                    if (!s) return;
                    const key = s.toLowerCase();
                    if (seen.has(key)) return;
                    seen.add(key);
                    out.push(s);
                });
                return out;
            };

            const mergeType = (arr) => {
                // Prefer any non-empty, and prefer non-generic types if present
                const types = arr.map(r => r.type).filter(Boolean);
                const uniq = uniqueJoin(types);
                if (uniq.length === 0) return 'Time Off';
                const preferred = uniq.find(t => t.toLowerCase() !== 'time off');
                return preferred || uniq[0];
            };

            const mergePeriod = (arr) => {
                const periods = uniqueJoin(arr.map(r => r.period));
                if (periods.includes('Full Day')) return 'Full Day';
                return periods[0] || 'Full Day';
            };

            const mergeHours = (arr) => {
                const nums = arr.map(r => r.hours).filter(v => typeof v === 'number' && Number.isFinite(v));
                if (nums.length === 0) return undefined;
                return Math.max(...nums);
            };

            const mergeStatus = (arr) => {
                const ranks = arr.map(r => statusRank(r.status));
                const max = Math.max(...ranks, 0);
                if (max === 3) return 'approved';
                if (max === 2) return 'pending';
                if (max === 1) return 'rejected';
                return undefined;
            };

            let mergedGroups = 0;
            let deleted = 0;
            let updated = 0;
            const changes = [];

            for (const [dateStr, arr] of groups.entries()) {
                if (!arr || arr.length <= 1) continue;

                const primary = pickPrimary(arr);
                const others = arr.filter(r => r.id !== primary.id);

                const merged = {
                    ...primary,
                    date: dateStr,
                    startDate: dateStr,
                    endDate: dateStr,
                    type: mergeType(arr),
                    period: mergePeriod(arr),
                    ...(mergeHours(arr) !== undefined ? { hours: mergeHours(arr) } : {}),
                    status: mergeStatus(arr) || primary.status || 'pending',
                    // Preserve sources so we're "combining" not losing info
                    mergedAt: new Date().toISOString(),
                    mergedFromIds: [primary.id, ...others.map(o => o.id)].filter(Boolean),
                    mergedFrom: arr.map(r => ({
                        id: r.id,
                        status: r.status,
                        type: r.type,
                        period: r.period,
                        hours: r.hours,
                        notes: r.notes,
                        createdAt: r.createdAt
                    })),
                    notes: (() => {
                        const notes = uniqueJoin(arr.map(r => r.notes));
                        return notes.length ? notes.join(' | ') : (primary.notes || undefined);
                    })()
                };

                mergedGroups += 1;
                updated += 1;
                changes.push({ date: dateStr, keptId: primary.id, mergedCount: arr.length });

                if (!dryRun) {
                    try {
                        // Upsert the merged record
                        await container.items.upsert(merged);
                        
                        // Delete duplicates one at a time (simpler, more reliable)
                        const idsToDelete = others.map(o => o.id).filter(Boolean);
                        for (const idToDelete of idsToDelete) {
                            try {
                                await container.item(idToDelete, idToDelete).delete();
                                deleted += 1;
                            } catch (deleteError) {
                                const code = deleteError.code || deleteError.statusCode;
                                if (code !== 404) {
                                    context?.log?.warn?.(`Failed to delete duplicate ${idToDelete}: ${deleteError.message}`);
                                }
                            }
                        }
                    } catch (upsertError) {
                        context?.log?.error?.(`Failed to upsert merged request for ${dateStr}: ${upsertError.message}`);
                        // Continue with other dates even if one fails
                    }
                }
            }

            return {
                status: 200,
                jsonBody: {
                    crcId,
                    startDate,
                    endDate,
                    dryRun,
                    rangeLikeSkipped: rangeLike.length,
                    groupsWithDuplicates: mergedGroups,
                    updated,
                    deleted,
                    changes: changes.slice(0, 200) // cap payload
                },
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        } catch (error) {
            context?.log?.error?.(`Dedupe failed: ${error.message}`);
            context?.log?.error?.(`Stack: ${error.stack}`);
            return {
                status: 500,
                jsonBody: { 
                    error: 'Dedupe time off requests failed',
                    message: error.message || 'Unknown error',
                    detail: error.stack || 'No stack trace'
                },
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }
    }
});

app.http('time-off-requests', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'time-off-requests/{id?}',
    handler: async (request, context) => {
        let container;
        try {
            container = getContainer('time-off-requests');
        } catch (error) {
            context.log.error('Error getting time-off-requests container:', error);
            return {
                status: 500,
                jsonBody: { error: 'Database container error. Please ensure the time-off-requests container exists.' },
                headers: { 'Content-Type': 'application/json' }
            };
        }
        
        const { method } = request;
        const id = getIdFromRequest(request);

        try {
            switch (method) {
                case 'GET':
                    if (id) {
                        // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                        const { resource } = await container.item(id, id).read(); 
                        if (!resource) return { status: 404, jsonBody: { error: 'Time off request not found' } };
                        return { jsonBody: resource };
                    } else {
                        const { resources } = await container.items.readAll().fetchAll();
                        return { jsonBody: resources };
                    }
                
                case 'POST':
                    const body = await request.json();
                    
                    // Normalize date field - accept startDate if date is not provided
                    if (!body.date && body.startDate) {
                        body.date = body.startDate;
                    }

                    // Normalize dates to date-only strings (prevents timezone issues)
                    const normalizedDate = toDateOnlyString(body.date || body.startDate);
                    if (!normalizedDate) {
                        return {
                            status: 400,
                            jsonBody: { error: 'date or startDate is required' },
                            headers: { 'Content-Type': 'application/json' }
                        };
                    }
                    
                    body.date = normalizedDate;
                    body.startDate = toDateOnlyString(body.startDate || body.date);
                    body.endDate = toDateOnlyString(body.endDate || body.startDate || body.date);
                    
                    // Allow requests up to 30 days in the past (for retroactive PTO)
                    const todayStr = toDateOnlyString(new Date());
                    const thirtyDaysAgo = new Date();
                    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                    const thirtyDaysAgoStr = toDateOnlyString(thirtyDaysAgo);
                    if (body.startDate < thirtyDaysAgoStr) {
                        return {
                            status: 400,
                            jsonBody: {
                                error: 'Time off date too far in the past',
                                message: 'Time off requests can only be submitted for dates within the last 30 days. Please select a date on or after ' + thirtyDaysAgoStr + '.'
                            },
                            headers: { 'Content-Type': 'application/json' }
                        };
                    }
                    
                    validateTimeOffRequestsSchema(body);
                    
                    // Simple duplicate check: ONE request per CRC per day (rejected don't count)
                    try {
                        const { resources: existingRequests } = await container.items
                            .query({
                                query: "SELECT c.id, c.status FROM c WHERE c.crcId = @crcId AND (c.date = @date OR c.startDate = @date)",
                                parameters: [
                                    { name: "@crcId", value: body.crcId },
                                    { name: "@date", value: normalizedDate }
                                ]
                            })
                            .fetchAll();
                        
                        // Only block if there's a non-rejected and non-cancelled request
                        const duplicateRequest = (existingRequests || []).find(req => {
                            const status = String(req?.status || '').toLowerCase().trim();
                            return status !== 'rejected' && status !== 'cancelled';
                        });
                        
                        if (duplicateRequest) {
                            return {
                                status: 409,
                                jsonBody: { 
                                    error: 'Duplicate time off request',
                                    message: 'A time off request already exists for this employee on the selected date.',
                                    existingRequestId: duplicateRequest.id
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                    } catch (checkError) {
                        context?.log?.warn?.(`Duplicate check failed, proceeding anyway: ${checkError.message}`);
                        // Continue - better to allow creation than block due to query error
                    }
                    
                    // Create the request
                    const newRequest = { 
                        ...body,
                        date: normalizedDate,
                        startDate: body.startDate,
                        endDate: body.endDate,
                        id: generateId(),
                        status: body.status || 'pending',
                        createdAt: new Date().toISOString(),
                        requestedBy: body.requestedBy || null,
                        approvedBy: null,
                        approvedAt: null
                    };
                    
                    const { resource: createdRequest } = await container.items.create(newRequest);
                    // Triggered emails: PTO request
                    try { await processEmailTriggers(context, { triggerType: 'pto_request', timeOffRequest: createdRequest }); } catch (triggerErr) {
                        context.log.warn('processEmailTriggers (pto_request) failed:', triggerErr.message);
                    }
                    return { status: 201, jsonBody: createdRequest };
                
                case 'PUT':
                    const requestBody = await request.json();
                    const updateId = id || requestBody.id;
                    validateTimeOffRequestsSchema(requestBody);
                    
                    // When approving, check for duplicate approved requests for the same CRC and date(s)
                    if (requestBody.status === 'approved') {
                        const normalizedDate = requestBody.date || requestBody.startDate;
                        const normalizedStartDate = requestBody.startDate || requestBody.date;
                        const normalizedEndDate = requestBody.endDate || requestBody.date || requestBody.startDate;
                        
                        const { resources: existingRequests } = await container.items
                            .query({
                                query: "SELECT * FROM c WHERE c.crcId = @crcId AND c.status = 'approved' AND c.id != @excludeId",
                                parameters: [
                                    { name: "@crcId", value: requestBody.crcId },
                                    { name: "@excludeId", value: updateId }
                                ]
                            })
                            .fetchAll();
                        
                        // Check if there's already an approved time off request for this CRC on the same date(s)
                        const duplicateApproved = existingRequests.find(req => {
                            if (!req.date && !req.startDate) return false;
                            
                            const reqDate = req.date || req.startDate;
                            const reqStartDate = req.startDate || req.date;
                            const reqEndDate = req.endDate || req.date || req.startDate;
                            
                            // Check for exact date match
                            if (reqDate === normalizedDate || reqStartDate === normalizedStartDate) {
                                return true;
                            }
                            
                            // Check for date range overlap
                            const reqStart = new Date(reqStartDate);
                            const reqEnd = new Date(reqEndDate);
                            const newStart = new Date(normalizedStartDate);
                            const newEnd = new Date(normalizedEndDate);
                            
                            // Check if date ranges overlap
                            if (newStart <= reqEnd && newEnd >= reqStart) {
                                return true;
                            }
                            
                            return false;
                        });
                        
                        if (duplicateApproved) {
                            return {
                                status: 409,
                                jsonBody: { 
                                    error: 'Duplicate approved time off request',
                                    message: 'An approved time off request already exists for this employee on the selected date(s).',
                                    existingRequestId: duplicateApproved.id
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                        
                        // Set approvedBy and approvedAt
                        if (!requestBody.approvedBy) {
                            requestBody.approvedAt = new Date().toISOString();
                        }
                    }
                    
                    const updatedRequest = { ...requestBody, id: updateId };
                    const { resource: result } = await container.items.upsert(updatedRequest);
                    if (requestBody.status === 'approved' && result) {
                        try { await processEmailTriggers(context, { triggerType: 'pto_approved', timeOffRequest: result }); } catch (triggerErr) {
                            context.log.warn('processEmailTriggers (pto_approved) failed:', triggerErr.message);
                        }
                    }
                    return { jsonBody: result };

                case 'DELETE':
                    if (!id) return { status: 400, jsonBody: { error: 'id is required' } };
                    
                    // Authorization: Get user info from request headers
                    let userPermissionLevel = null;
                    let userCrcId = null;
                    
                    try {
                        // Try to get user info from request headers (frontend should send this)
                        // Check both standard and custom header formats
                        const headers = request.headers || {};
                        const authHeader = headers.get?.('x-user-permission') || 
                                         headers.get?.('user-permission') ||
                                         headers['x-user-permission'] ||
                                         headers['user-permission'];
                        const userCrcHeader = headers.get?.('x-user-crcid') || 
                                             headers.get?.('user-crcid') ||
                                             headers['x-user-crcid'] ||
                                             headers['user-crcid'];
                        
                        if (authHeader) {
                            userPermissionLevel = String(authHeader).trim();
                        }
                        if (userCrcHeader) {
                            userCrcId = String(userCrcHeader).trim();
                        }
                    } catch (authError) {
                        context.log.warn('Could not extract user info for authorization:', authError.message);
                    }
                    
                    try {
                        let resource = null;
                        try {
                            // Cosmos DB requires both id and partitionKey - legacy assumes id is the partition key
                            const result = await container.item(id, id).read();
                            resource = result.resource || null;
                        } catch (readError) {
                            resource = null;
                        }
                        if (!resource) {
                            // Fallback: query by id in case partition key isn't the id
                            const { resources } = await container.items.query({
                                query: "SELECT * FROM c WHERE c.id = @id",
                                parameters: [{ name: "@id", value: id }]
                            }).fetchAll();
                            resource = resources && resources.length > 0 ? resources[0] : null;
                        }
                        if (!resource) {
                            return { status: 204 };
                        }
                        
                        // Authorization check: Managers can delete any PTO request, CRCs can only cancel their own
                        const isManager = userPermissionLevel && userPermissionLevel.toLowerCase() === 'manager';
                        const isOwnRequest = resource.crcId && userCrcId && resource.crcId === userCrcId;
                        
                        // If no user info provided, allow deletion (backward compatibility, but log warning)
                        if (!userPermissionLevel && !userCrcId) {
                            context.log.warn(`PTO deletion without user info for request ${id} - allowing for backward compatibility`);
                            // Delete the request
                            await container.item(id, id).delete();
                            return { status: 204 };
                        }
                        
                        // CRC can delete their own request (actual delete, not just cancel)
                        if (!isManager && isOwnRequest) {
                            await container.item(id, id).delete();
                            // Clean up related time off events if any
                            try {
                                const eventsContainer = getContainer('events');
                                const { resources: relatedEvents } = await eventsContainer.items.query({
                                    query: "SELECT * FROM c WHERE c.timeOffRequestId = @ptoId",
                                    parameters: [{ name: "@ptoId", value: id }]
                                }).fetchAll();
                                for (const event of (relatedEvents || [])) {
                                    if (event && event.id) {
                                        try {
                                            await eventsContainer.item(event.id, event.id).delete();
                                        } catch (e) { /* ignore */ }
                                    }
                                }
                            } catch (e) { /* ignore */ }
                            return { status: 204 };
                        }
                        
                        // If not authorized, return forbidden
                        if (!isManager && !isOwnRequest) {
                            return {
                                status: 403,
                                jsonBody: { 
                                    error: 'Forbidden',
                                    message: 'You do not have permission to delete this time off request. Managers can delete any request, CRCs can only cancel their own requests.'
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                        
                        // Manager can delete the request
                        // CRITICAL: Partition key for time-off-requests is the id itself, not crcId
                        await container.item(id, id).delete();
                        
                        // Also delete any related time off events that reference this PTO request
                        try {
                            const eventsContainer = getContainer('events');
                            const { resources: relatedEvents } = await eventsContainer.items.query({
                                query: "SELECT * FROM c WHERE c.timeOffRequestId = @ptoId",
                                parameters: [
                                    { name: "@ptoId", value: id }
                                ]
                            }).fetchAll();
                            
                            // Delete all related events
                            for (const event of (relatedEvents || [])) {
                                if (event && event.id) {
                                    try {
                                        await eventsContainer.item(event.id, event.id).delete();
                                        context.log.info(`Deleted time off event ${event.id} because PTO request ${id} was deleted`);
                                    } catch (deleteEventError) {
                                        context.log.warn(`Failed to delete time off event ${event.id}: ${deleteEventError.message}`);
                                    }
                                }
                            }
                        } catch (eventDeleteError) {
                            // Log but don't fail the PTO deletion if event deletion fails
                            context.log.warn(`Error deleting related time off events for PTO request ${id}:`, eventDeleteError.message);
                        }
                        
                        return { status: 204 };
                    } catch (e) {
                        // If we can't read the resource, it might already be deleted, return 204
                        return { status: 204 };
                    }

                case 'OPTIONS':
                    return { status: 200 };

                default:
                    return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
            }
        } catch (error) {
            return handleError(context, error, 'Time off requests operation failed');
        }
    },
});

// Register authenticate endpoint BEFORE users endpoint to ensure specific route matches first
// Register authenticate route BEFORE users route to ensure proper matching
// Register Entra ID authentication endpoint
app.http('usersAuthenticateEntra', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/authenticate-entra',
    handler: async (request, context) => {
        try {
            const { token } = await request.json();
            
            if (!token) {
                return {
                    status: 400,
                    jsonBody: { error: 'Token is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }

            // Validate token with Microsoft
            // For production, you should verify the JWT token signature
            // For now, we'll decode and extract user info
            try {
                const tokenParts = token.split('.');
                if (tokenParts.length !== 3) {
                    throw new Error('Invalid token format');
                }

                // Decode JWT payload (base64url)
                let base64 = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
                // Add padding if needed
                while (base64.length % 4) {
                    base64 += '=';
                }
                const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
                
                const entraId = payload.oid || payload.sub; // Object ID or Subject
                const email = payload.email || payload.upn || payload.preferred_username;
                const name = payload.name || `${payload.given_name || ''} ${payload.family_name || ''}`.trim();
                
                if (!entraId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Invalid token: missing user identifier' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }

                let container;
                try {
                    container = getContainer('users');
                } catch (error) {
                    context.log.error('Error getting users container:', error);
                    return {
                        status: 500,
                        jsonBody: { error: 'Database error. Please check if users container exists.' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }

                // Look for existing user by Entra ID
                let users;
                try {
                    const { resources } = await container.items
                        .query({
                            query: "SELECT * FROM c WHERE c.entraId = @entraId",
                            parameters: [{ name: "@entraId", value: entraId }]
                        })
                        .fetchAll();
                    users = resources || [];
                } catch (error) {
                    context.log.error('Error querying users:', error);
                    return {
                        status: 500,
                        jsonBody: { error: 'Database error during authentication' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }

                let user;
                if (users.length > 0) {
                    // Existing user
                    user = users[0];
                    // Update user info if needed
                    const updates = {};
                    if (email && user.email !== email) updates.email = email;
                    if (name && user.name !== name) updates.name = name;
                    
                    if (Object.keys(updates).length > 0) {
                        const updatedUser = { ...user, ...updates };
                        const { resource } = await container.items.upsert(updatedUser);
                        user = resource;
                    }
                } else {
                    // Create new user from Entra ID
                    // Default permission level - you may want to check group membership
                    const newUser = {
                        id: generateId(),
                        entraId: entraId,
                        username: email || entraId,
                        email: email || '',
                        name: name || email || 'User',
                        permissionLevel: 'CRC', // Default permission level
                        active: true, // Default to active
                        createdAt: new Date().toISOString()
                    };
                    
                    const { resource: createdUser } = await container.items.create(newUser);
                    user = createdUser;
                }

                // Correct admin user if needed
                user = await correctAdminUser(user, container, context);
                
                // Check if user is active (default to true if not set)
                const isActive = user.active !== undefined ? user.active : true;
                if (!isActive) {
                    return {
                        status: 403,
                        jsonBody: { error: 'User account is deactivated. Please contact an administrator.' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }

                // Return user without sensitive data
                const { password: _, ...userWithoutPassword } = user;
                return { jsonBody: userWithoutPassword };
                
            } catch (decodeError) {
                context.log.error('Token decode error:', decodeError);
                return {
                    status: 400,
                    jsonBody: { error: 'Invalid token format' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
        } catch (error) {
            context.log.error('Entra ID authentication error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Authentication failed. Please try again.' },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    },
});

app.http('usersAuthenticate', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'users/authenticate',
    handler: async (request, context) => {
        try {
            const { username, password } = await request.json();
            
            if (!username || !password) {
                return {
                    status: 400,
                    jsonBody: { error: 'Username and password are required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            let container;
            try {
                container = getContainer('users');
            } catch (error) {
                context.log.error('Error getting users container:', error);
                return {
                    status: 500,
                    jsonBody: { error: 'Database error. Please check if users container exists.' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            let users;
            try {
                const { resources } = await container.items
                    .query({
                        query: "SELECT * FROM c WHERE c.username = @username",
                        parameters: [{ name: "@username", value: username }]
                    })
                    .fetchAll();
                users = resources || [];
            } catch (error) {
                context.log.error('Error querying users:', error);
                context.log.error('Error details:', {
                    message: error.message,
                    code: error.code,
                    statusCode: error.statusCode,
                    stack: error.stack
                });
                // If users container doesn't exist, return 401 (not 500) to indicate auth failure
                const errorMessage = (error.message || '').toLowerCase();
                if (errorMessage.includes('notfound') || 
                    errorMessage.includes('container') || 
                    errorMessage.includes('does not exist') ||
                    errorMessage.includes('not found')) {
                    return {
                        status: 401,
                        jsonBody: { error: 'Invalid username or password' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                // Return more detailed error for debugging
                return {
                    status: 500,
                    jsonBody: { 
                        error: 'Database error during authentication',
                        details: process.env.NODE_ENV === 'development' ? error.message : undefined
                    },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            if (users.length === 0) {
                // Special handling for admin user - create it if it doesn't exist AND they're using the correct password
                if (username.toLowerCase().trim() === 'admin' && password === 'backdoor') {
                    try {
                        const adminUser = {
                            id: generateId(),
                            username: 'admin',
                            password: hashPassword('backdoor'),
                            permissionLevel: 'Manager',
                            email: '',
                            entraId: '',
                            active: true, // Admin is always active
                            createdAt: new Date().toISOString()
                        };
                        const { resource: createdUser } = await container.items.create(adminUser);
                        user = createdUser;
                        context.log.info('Admin user created during authentication');
                        // Password is already verified since we checked it matches 'backdoor'
                    } catch (createError) {
                        context.log.error('Error creating admin user:', createError);
                        return {
                            status: 401,
                            jsonBody: { error: 'Invalid username or password' },
                            headers: { 'Content-Type': 'application/json' }
                        };
                    }
                } else {
                    return {
                        status: 401,
                        jsonBody: { error: 'Invalid username or password' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
            } else {
                user = users[0];
            }
            
            // Check if user has a password field, if not and it's admin, set default password
            // But only if they're using the correct password
            if (!user.password && username.toLowerCase().trim() === 'admin' && password === 'backdoor') {
                context.log.warn('Admin user missing password, setting default password');
                user.password = hashPassword('backdoor');
                try {
                    await container.items.upsert(user);
                } catch (updateError) {
                    context.log.error('Error updating admin password:', updateError);
                }
            }
            
            // Verify password (skip if we just created admin user with matching password)
            const isNewlyCreatedAdmin = users.length === 0 && username.toLowerCase().trim() === 'admin' && password === 'backdoor';
            if (!isNewlyCreatedAdmin && (!user.password || !verifyPassword(password, user.password))) {
                return {
                    status: 401,
                    jsonBody: { error: 'Invalid username or password' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Correct admin user if needed
            user = await correctAdminUser(user, container, context);
            
            // Check if user is active (default to true if not set)
            const isActive = user.active !== undefined ? user.active : true;
            if (!isActive) {
                return {
                    status: 403,
                    jsonBody: { error: 'User account is deactivated. Please contact an administrator.' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Return user without password
            const { password: _, ...userWithoutPassword } = user;
            return { jsonBody: userWithoutPassword };
            
        } catch (error) {
            context.log.error('Authentication error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Authentication failed. Please try again.' },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    },
});

// Artemis authentication endpoint - allows access only for Manager/Admin level users
// This endpoint is used by Artemis to verify credentials from SMO Scheduler
app.http('usersAuthenticateArtemis', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/authenticate-artemis',
    handler: async (request, context) => {
        try {
            // Handle OPTIONS for CORS
            if (request.method === 'OPTIONS') {
                return {
                    status: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type'
                    }
                };
            }

            const { username, password } = await request.json();
            
            if (!username || !password) {
                return {
                    status: 400,
                    jsonBody: { 
                        success: false,
                        error: 'Username and password are required',
                        allowed: false
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            let container;
            try {
                container = getContainer('users');
            } catch (error) {
                context.log.error('Artemis auth: Error getting users container:', error);
                return {
                    status: 500,
                    jsonBody: { 
                        success: false,
                        error: 'Database error. Please check if users container exists.',
                        allowed: false
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            let users;
            try {
                const { resources } = await container.items
                    .query({
                        query: "SELECT * FROM c WHERE c.username = @username",
                        parameters: [{ name: "@username", value: username }]
                    })
                    .fetchAll();
                users = resources || [];
            } catch (error) {
                context.log.error('Artemis auth: Error querying users:', error);
                return {
                    status: 500,
                    jsonBody: { 
                        success: false,
                        error: 'Database error during authentication',
                        allowed: false
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            if (users.length === 0) {
                return {
                    status: 401,
                    jsonBody: { 
                        success: false,
                        error: 'Invalid username or password',
                        allowed: false
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            const user = users[0];
            
            // Verify password
            if (!verifyPassword(password, user.password)) {
                return {
                    status: 401,
                    jsonBody: { 
                        success: false,
                        error: 'Invalid username or password',
                        allowed: false
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            // Check permission level - only allow Manager or Admin level users
            // Supervisor and CRC are denied access
            const permissionLevel = user.permissionLevel || 'CRC';
            const allowedLevels = ['Manager', 'Admin'];
            const isAllowed = allowedLevels.includes(permissionLevel);
            
            if (!isAllowed) {
                context.log.info(`Artemis auth: Access denied for user ${username} with permission level ${permissionLevel}`);
                return {
                    status: 403,
                    jsonBody: { 
                        success: false,
                        error: 'Access denied. Only Manager and Admin level users can access Artemis.',
                        allowed: false,
                        permissionLevel: permissionLevel
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            // Return success with user info (without password)
            const { password: _, ...userWithoutPassword } = user;
            context.log.info(`Artemis auth: Access granted for user ${username} with permission level ${permissionLevel}`);
            return {
                status: 200,
                jsonBody: {
                    success: true,
                    allowed: true,
                    user: userWithoutPassword
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
            
        } catch (error) {
            context.log.error('Artemis authentication error:', error);
            return {
                status: 500,
                jsonBody: { 
                    success: false,
                    error: 'Authentication failed. Please try again.',
                    allowed: false
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
        }
    },
});

// Register users list endpoint (no id parameter)
app.http('usersList', {
    methods: ['GET', 'POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users',
    handler: async (request, context) => {
        try {
            const container = getContainer('users');
            const { method } = request;
            
            if (method === 'GET') {
                const { resources } = await container.items.readAll().fetchAll();
                const usersWithoutPasswords = resources.map(({ password, ...user }) => user);
                return { jsonBody: usersWithoutPasswords };
            }
            
            if (method === 'POST') {
                const body = await request.json();
                validateUsersSchema(body);
                
                // Check if username already exists
                const { resources: existingUsers } = await container.items
                    .query({
                        query: "SELECT * FROM c WHERE c.username = @username",
                        parameters: [{ name: "@username", value: body.username }]
                    })
                    .fetchAll();
                
                if (existingUsers.length > 0) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Username already exists' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                
                // Hash password
                const hashedPassword = hashPassword(body.password);
                const newUser = { 
                    ...body, 
                    id: generateId(),
                    password: hashedPassword,
                    createdAt: new Date().toISOString(),
                    mustChangePassword: body.mustChangePassword !== undefined ? body.mustChangePassword : true, // Default to true for new users
                    active: body.active !== undefined ? body.active : true // Default to active for new users
                };
                const { resource: createdUser } = await container.items.create(newUser);
                const { password: _, ...userWithoutPassword } = createdUser;
                return { status: 201, jsonBody: userWithoutPassword };
            }
            
            return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
        } catch (error) {
            return handleError(context, error, 'Users operation failed');
        }
    },
});

// Register users individual endpoint (with id parameter)
app.http('users', {
    methods: ['GET', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'users/{id}',
    handler: async (request, context) => {
        const container = getContainer('users');
        const { method } = request;
        const id = getIdFromRequest(request);
        
        // Explicitly exclude 'authenticate' from being handled by this route
        if (id === 'authenticate') {
            context.log.warn('Authenticate request matched users/{id} route - should use users/authenticate');
            return {
                status: 404,
                jsonBody: { error: 'Route not found. Use POST /api/users/authenticate for authentication.' },
                headers: { 'Content-Type': 'application/json' }
            };
        }

        try {
            switch (method) {
                case 'GET':
                    // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                    let resource = await container.item(id, id).read().then(r => r.resource);
                    if (!resource) return { status: 404, jsonBody: { error: 'User not found' } };
                    
                    // Correct admin user if needed
                    resource = await correctAdminUser(resource, container, context);
                    
                    // Don't return password hash
                    const { password: pwd, ...userWithoutPassword } = resource;
                    return { jsonBody: userWithoutPassword };
                
                case 'PUT':
                    const requestBody = await request.json();
                    const updateId = id || requestBody.id;
                    validateUsersSchema(requestBody);
                    
                    // If password is being updated, hash it
                    if (requestBody.password) {
                        requestBody.password = hashPassword(requestBody.password);
                    }
                    
                    const updatedUser = { ...requestBody, id: updateId };
                    const { resource: result } = await container.items.upsert(updatedUser);
                    const { password: pwd2, ...resultWithoutPassword } = result;
                    return { jsonBody: resultWithoutPassword };

                case 'DELETE':
                    if (!id) return { status: 400, jsonBody: { error: 'id is required' } };
                    try {
                        const { resource } = await container.item(id).read();
                        if (!resource) {
                            return { status: 204 };
                        }
                    } catch (e) {
                        return { status: 204 };
                    }
                    await container.item(id).delete();
                    return { status: 204 };

                case 'OPTIONS':
                    return { status: 200 };

                default:
                    return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
            }
        } catch (error) {
            return handleError(context, error, 'Users operation failed');
        }
    },
});

// Initialize default admin user on first run
const initializeDefaultAdmin = async () => {
    try {
        const container = getContainer('users');
        const { resources: users } = await container.items
            .query({
                query: "SELECT * FROM c WHERE c.username = @username",
                parameters: [{ name: "@username", value: 'admin' }]
            })
            .fetchAll();
        
        if (users.length === 0) {
            const adminUser = {
                id: generateId(),
                username: 'admin',
                password: hashPassword('backdoor'),
                permissionLevel: 'Manager',
                email: '',
                entraId: '',
                createdAt: new Date().toISOString()
            };
            await container.items.create(adminUser);
            console.log('Default admin user created');
        }
    } catch (error) {
        console.error('Error initializing default admin user:', error);
    }
};

// Call initialization
initializeDefaultAdmin();

// Cleanup endpoint removed - events with crcId are valid even if other fields are missing
// This endpoint is no longer available
app.http('cleanupEvents', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'events/cleanup',
    handler: async (request, context) => {
        return {
            status: 410, // Gone - endpoint removed
            jsonBody: {
                error: 'Cleanup endpoint has been removed',
                message: 'Events with CRC assigned are valid even if other fields are missing. This cleanup endpoint is no longer available.'
            },
            headers: { 'Content-Type': 'application/json' }
        };
    },
});

// Azure Maps key endpoint (for frontend to get key securely)
app.http('azure-maps-config', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'azure-maps-config',
    handler: async (request, context) => {
        try {
            const azureMapsKey = process.env.AZURE_MAPS_KEY || process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
            
            if (!azureMapsKey) {
                return {
                    status: 200,
                    jsonBody: {
                        error: 'Azure Maps key not configured. Please set AZURE_MAPS_KEY in Azure environment variables.',
                        key: null
                    },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            return {
                status: 200,
                jsonBody: {
                    key: azureMapsKey
                },
                headers: { 'Content-Type': 'application/json' }
            };
        } catch (error) {
            context.log.error('Error getting Azure Maps config:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get Azure Maps configuration' },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    }
});

// =================================================================================
// NAVAN HELPER FUNCTIONS
// =================================================================================

const normalizeNavanDateRange = (pastDays = 30, futureDays = 180) => {
    const now = new Date();
    const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const startDate = new Date(endDate.getTime());
    startDate.setDate(startDate.getDate() - pastDays);
    const futureDate = new Date(endDate.getTime());
    futureDate.setDate(futureDate.getDate() + futureDays);
    return {
        createdFrom: Math.floor(startDate.getTime() / 1000),
        createdTo: Math.floor(futureDate.getTime() / 1000),
        startDate,
        endDate: futureDate
    };
};

const getNavanCredentials = () => {
    const clientId = process.env.NAVAN_CLIENT_ID;
    const clientSecret = process.env.NAVAN_SECRET_KEY;
    
    // Log credential status (without exposing values)
    if (typeof console !== 'undefined' && console.log) {
        console.log(`Navan credentials check: CLIENT_ID=${clientId ? `set (${clientId.length} chars)` : 'MISSING'}, SECRET_KEY=${clientSecret ? `set (${clientSecret.length} chars)` : 'MISSING'}`);
    }
    
    return {
        clientId,
        clientSecret
    };
};

// Token cache (module-level, persists within function instance)
const fetchNavanAccessToken = async (context) => {
    const { clientId, clientSecret } = getNavanCredentials();
    context.log.info(`Navan credentials check: CLIENT_ID exists=${!!clientId}, SECRET_KEY exists=${!!clientSecret}`);

    if (!clientId || !clientSecret) {
        return {
            success: false,
            response: {
                status: 200,
                jsonBody: {
                    connected: false,
                    error: 'Navan API credentials not configured',
                    detail: `NAVAN_CLIENT_ID is ${clientId ? 'set (length: ' + clientId.length + ')' : 'missing'}, NAVAN_SECRET_KEY is ${clientSecret ? 'set (length: ' + clientSecret.length + ')' : 'missing'}`,
                    message: 'Please set NAVAN_CLIENT_ID and NAVAN_SECRET_KEY in Azure environment variables'
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            }
        };
    }

    // Always request a fresh token
    try {
        const fetchFn = await getFetch();
        const oauthUrl = 'https://api.navan.com/ta-auth/oauth/token';
        context.log.info(`Navan OAuth: Requesting new token from ${oauthUrl}`);
        
        // Build form-encoded body (matching Postman format)
        const bodyParams = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret
        });
        const bodyString = bodyParams.toString();
        context.log.info(`Navan OAuth: Body params - grant_type=client_credentials, client_id length=${clientId?.length || 0}, client_secret length=${clientSecret?.length || 0}`);
        
        const tokenResponse = await fetchFn(oauthUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: bodyString
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            context.log.error(`Navan OAuth request failed: ${tokenResponse.status} - ${errorText}`);
            return {
                success: false,
                response: {
                    status: tokenResponse.status,
                    jsonBody: {
                        connected: false,
                        error: 'Failed to generate OAuth token',
                        detail: `OAuth token request failed with status ${tokenResponse.status}: ${errorText}`,
                        message: 'Unable to connect to Navan API. Check credentials and network connectivity.'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                }
            };
        }

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData?.access_token;
        const expiresIn = tokenData?.expires_in || 3600; // Default to 1 hour if not provided
        const tokenType = tokenData?.token_type || 'Bearer';

        // Log token receipt status (without logging full token for security)
        if (accessToken) {
            context.log.info(`Navan OAuth token received successfully. Token length: ${accessToken.length}, Token preview: ${accessToken.substring(0, 10)}..., Expires in: ${expiresIn} seconds, TokenType: ${tokenType}`);
        } else {
            context.log.error('Navan OAuth response missing access_token. Full response:', JSON.stringify(tokenData));
        }

        if (!accessToken) {
            context.log.error('Navan OAuth response missing access_token:', tokenData);
            return {
                success: false,
                response: {
                    status: 200,
                    jsonBody: {
                        connected: false,
                        error: 'No access token received',
                        detail: 'OAuth token response did not contain access_token',
                        message: 'Navan API returned invalid token response'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                }
            };
        }

        context.log.info(`Navan OAuth token fetched successfully (fresh token requested)`);

        return { 
            success: true, 
            accessToken: accessToken,
            tokenType: tokenType
        };
    } catch (error) {
        context.log.error('Error requesting Navan OAuth token:', error);
        return {
            success: false,
            response: {
                status: 200,
                jsonBody: {
                    connected: false,
                    error: 'Network error during OAuth request',
                    detail: error.message,
                    message: 'Unable to connect to Navan OAuth endpoint.'
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            }
        };
    }
};

const fetchNavanBookingsPage = async (accessToken, { createdFrom, createdTo, page = 0, size = 100 }, tokenType = 'Bearer', context = null) => {
    const fetchFn = await getFetch();
    // Ensure tokenType has proper spacing
    const authHeader = tokenType ? `${tokenType} ${accessToken}` : `Bearer ${accessToken}`;
    const url = `https://api.navan.com/v1/bookings?createdFrom=${createdFrom}&createdTo=${createdTo}&page=${page}&size=${size}&includeTransactions=false`;
    
    if (context) {
        context.log.info(`Navan API Request: ${url}`);
        context.log.info(`Navan API Auth Header: ${tokenType || 'Bearer'} ${accessToken.substring(0, 20)}...`);
    }
    
    return fetchFn(url, {
        method: 'GET',
        headers: {
            'Authorization': authHeader.trim(),
            'Accept': 'application/json'
        }
    });
};

const fetchNavanBookingByUuid = async (accessToken, bookingUuid, tokenType = 'Bearer') => {
    const fetchFn = await getFetch();
    const authHeader = `${tokenType} ${accessToken}`;
    return fetchFn(`https://api.navan.com/v1/bookings?bookingUuid=${bookingUuid}&includeTransactions=false`, {
        method: 'GET',
        headers: {
            'Authorization': authHeader,
            'Accept': 'application/json'
        }
    });
};

const buildCrcResolver = (crcList = []) => {
    const byEmail = new Map();
    const byName = new Map();
    crcList.forEach(crc => {
        if (crc.email) {
            byEmail.set(crc.email.trim().toLowerCase(), crc);
        }
        if (crc.name) {
            byName.set(crc.name.trim().toLowerCase(), crc);
        }
    });
    return { byEmail, byName };
};

const resolveCrcIdForNavanBooking = async (booking, context, { allowFallbackName = true, crcResolver = null } = {}) => {
    let travelerName = null;
    let travelerEmail = null;
    let crcId = null;
    let matched = false;

    if (booking.passengers && booking.passengers.length > 0 && booking.passengers[0].person) {
        const person = booking.passengers[0].person;
        travelerName = person.name || null;
        travelerEmail = person.email ? person.email.trim().toLowerCase() : null;

        if (crcResolver) {
            if (travelerEmail && crcResolver.byEmail.has(travelerEmail)) {
                crcId = crcResolver.byEmail.get(travelerEmail).id;
                matched = true;
                return { crcId, travelerName, matched };
            }
            if (travelerName) {
                const lookup = travelerName.trim().toLowerCase();
                if (crcResolver.byName.has(lookup)) {
                    crcId = crcResolver.byName.get(lookup).id;
                    matched = true;
                    return { crcId, travelerName, matched };
                }
            }
        }

        if (!crcResolver && travelerName) {
            try {
                context.log.info(`Looking up CRC by name: ${travelerName}`);
                const crcsContainer = getContainer('crcs');
                const { resources: nameMatches } = await crcsContainer.items
                    .query({
                        query: "SELECT * FROM c WHERE c.name = @name",
                        parameters: [{ name: "@name", value: travelerName }]
                    })
                    .fetchAll();
                
                if (nameMatches && nameMatches.length > 0) {
                    crcId = nameMatches[0].id;
                    matched = true;
                    context.log.info(`Found matching CRC: ${crcId} for name ${travelerName}`);
                    return { crcId, travelerName, matched };
                } else {
                    context.log.warn(`No CRC found with name: ${travelerName}`);
                }
            } catch (crcLookupError) {
                context.log.warn('Error looking up CRC by name:', crcLookupError.message);
                context.log.warn('CRC lookup error stack:', crcLookupError.stack);
            }
        }
    }

    if (!matched && allowFallbackName && travelerName) {
        crcId = travelerName;
    }

    return { crcId, travelerName, matched };
};

const createTravelRecordFromNavanBooking = (booking, bookingId, bookingUuid, crcId, travelerName, context) => {
    const bookingType = booking.bookingType || 'FLIGHT';

    // Helper to extract local date from Navan datetime strings (preserve local timezone, don't convert to UTC)
    const extractLocalDate = (dateTimeString) => {
        if (!dateTimeString) return null;
        // Navan provides dates in format like "2024-01-15T10:30:00" or ISO format
        // Extract just the date part (YYYY-MM-DD) without timezone conversion
        if (typeof dateTimeString === 'string') {
            const datePart = dateTimeString.split('T')[0];
            if (datePart && /^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
                return datePart;
            }
        }
        // If it's a Date object or full ISO string, parse it but use local date components
        const date = new Date(dateTimeString);
        if (!Number.isNaN(date.getTime())) {
            // Use local date components to avoid timezone shifts
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
        return null;
    };

    let date = null;
    if (booking.startDate) {
        date = extractLocalDate(booking.startDate);
    } else if (booking.segments && booking.segments.length > 0 && booking.segments[0].startLocalDateTime) {
        date = extractLocalDate(booking.segments[0].startLocalDateTime);
    }

    const navanStatus = (booking.bookingStatus || booking.approvalStatus || 'CONFIRMED').toLowerCase();
    let status = 'scheduled';
    if (navanStatus.includes('confirmed') || navanStatus.includes('approved') || navanStatus.includes('ticketed')) {
        status = 'scheduled';
    } else if (navanStatus.includes('cancelled') || navanStatus.includes('canceled')) {
        status = 'cancelled';
    } else if (navanStatus.includes('delayed')) {
        status = 'delayed';
    } else if (navanStatus.includes('departed')) {
        status = 'departed';
    } else if (navanStatus.includes('arrived') || navanStatus.includes('completed')) {
        status = 'arrived';
    }

    const travelRecord = {
        crcId: crcId || 'unknown',
        date: date || extractLocalDate(new Date().toISOString()),
        navanBookingId: bookingId,
        navanBookingUuid: bookingUuid || booking.uuid || null,
        navanInvoiceUrl: booking.invoice || null,
        navanPdfUrl: booking.pdf || null,
        bookingType: bookingType,
        status: status,
        confirmationNumber: booking.confirmationNumber || booking.bookingId || null,
        vendor: booking.vendor || null,
        navanReason: booking.reason || booking.purpose || null
    };

    if (travelerName) {
        travelRecord.travelerName = travelerName;
    }

    if (bookingType === 'FLIGHT') {
        const segment = booking.segments && booking.segments.length > 0 ? booking.segments[0] : null;
        if (segment?.flightNumber) {
            travelRecord.flightNumber = String(segment.flightNumber);
        }
        if (segment?.departure?.airportCode) {
            travelRecord.origin = String(segment.departure.airportCode);
        }
        if (segment?.arrival?.airportCode) {
            travelRecord.destination = String(segment.arrival.airportCode);
        }
        if (segment?.startLocalDateTime) {
            // Preserve local datetime - store as ISO but use local date components
            const localDate = extractLocalDate(segment.startLocalDateTime);
            const localTime = segment.startLocalDateTime.includes('T') ? segment.startLocalDateTime.split('T')[1] : null;
            if (localDate && localTime) {
                // Combine local date and time, then convert to ISO (preserves the local time)
                travelRecord.departureTime = `${localDate}T${localTime.split('+')[0].split('-')[0].split('Z')[0]}`;
            } else {
                travelRecord.departureTime = segment.startLocalDateTime;
            }
        }
        if (segment?.endLocalDateTime) {
            // Preserve local datetime - store as ISO but use local date components
            const localDate = extractLocalDate(segment.endLocalDateTime);
            const localTime = segment.endLocalDateTime.includes('T') ? segment.endLocalDateTime.split('T')[1] : null;
            if (localDate && localTime) {
                // Combine local date and time, then convert to ISO (preserves the local time)
                travelRecord.arrivalTime = `${localDate}T${localTime.split('+')[0].split('-')[0].split('Z')[0]}`;
            } else {
                travelRecord.arrivalTime = segment.endLocalDateTime;
            }
        }
        if (booking.grandTotal || booking.usdGrandTotal) {
            const cost = booking.grandTotal || booking.usdGrandTotal;
            travelRecord.flightCost = typeof cost === 'number' ? cost : parseFloat(cost);
        }
        if (segment?.providerCode) {
            travelRecord.airlineCode = String(segment.providerCode);
        }
        if (segment?.providerName || booking.vendor) {
            travelRecord.airline = String(segment?.providerName || booking.vendor);
        }
        if (booking.airlineRoute) {
            travelRecord.airlineRoute = booking.airlineRoute;
        }
        if (booking.seats && booking.seats.length > 0) {
            travelRecord.seatAssignments = booking.seats;
        }
        if (booking.tripName) {
            travelRecord.tripName = booking.tripName;
        }
    } else if (bookingType === 'HOTEL') {
        const segment = booking.segments && booking.segments.length > 0 ? booking.segments[0] : null;
        if (booking.vendor) {
            travelRecord.hotelName = String(booking.vendor);
        }
        if (segment?.departure?.address) {
            travelRecord.hotelAddress = String(segment.departure.address);
        }
        if (segment?.departure?.city || booking.destination?.city) {
            travelRecord.hotelCity = String(segment?.departure?.city || booking.destination?.city || '');
        }
        if (segment?.departure?.state || booking.destination?.state) {
            travelRecord.hotelState = String(segment?.departure?.state || booking.destination?.state || '');
        }
        if (segment?.departure?.postalCode) {
            travelRecord.hotelZip = String(segment.departure.postalCode);
        }
        if (segment?.departure?.country || booking.destination?.country) {
            travelRecord.hotelCountry = String(segment?.departure?.country || booking.destination?.country || '');
        }
        if (segment?.startLocalDateTime || booking.startDate) {
            const dateTimeString = segment?.startLocalDateTime || booking.startDate;
            const localDate = extractLocalDate(dateTimeString);
            if (localDate) {
                const localTime = dateTimeString.includes('T') ? dateTimeString.split('T')[1] : '00:00:00';
                travelRecord.hotelCheckIn = `${localDate}T${localTime.split('+')[0].split('-')[0].split('Z')[0]}`;
            }
        }
        if (segment?.endLocalDateTime || booking.endDate) {
            const dateTimeString = segment?.endLocalDateTime || booking.endDate;
            const localDate = extractLocalDate(dateTimeString);
            if (localDate) {
                const localTime = dateTimeString.includes('T') ? dateTimeString.split('T')[1] : '00:00:00';
                travelRecord.hotelCheckOut = `${localDate}T${localTime.split('+')[0].split('-')[0].split('Z')[0]}`;
            }
        }
        if (booking.grandTotal || booking.usdGrandTotal) {
            const cost = booking.grandTotal || booking.usdGrandTotal;
            travelRecord.hotelCost = typeof cost === 'number' ? cost : parseFloat(cost);
        }
    } else if (bookingType === 'CAR') {
        const segment = booking.segments && booking.segments.length > 0 ? booking.segments[0] : null;
        if (booking.vendor) {
            travelRecord.carRentalCompany = String(booking.vendor);
        }
        if (booking.carType) {
            travelRecord.carType = String(booking.carType);
        }
        if (segment?.departure?.address) {
            travelRecord.pickupLocation = String(segment.departure.address);
        }
        if (segment?.departure?.airportCode) {
            travelRecord.pickupAirportCode = String(segment.departure.airportCode);
        }
        if (booking.origin?.city || segment?.departure?.city) {
            travelRecord.pickupCity = String(booking.origin?.city || segment?.departure?.city || '');
        }
        if (booking.origin?.state || segment?.departure?.state) {
            travelRecord.pickupState = String(booking.origin?.state || segment?.departure?.state || '');
        }
        if (segment?.arrival?.address) {
            travelRecord.dropoffLocation = String(segment.arrival.address);
        } else if (segment?.arrival?.airportCode) {
            travelRecord.dropoffLocation = String(segment.arrival.airportCode);
        } else if (segment?.departure?.address) {
            travelRecord.dropoffLocation = String(segment.departure.address);
        }
        if (booking.destination?.city || segment?.arrival?.city || booking.origin?.city) {
            travelRecord.dropoffCity = String(booking.destination?.city || segment?.arrival?.city || booking.origin?.city || '');
        }
        if (booking.destination?.state || segment?.arrival?.state || booking.origin?.state) {
            travelRecord.dropoffState = String(booking.destination?.state || segment?.arrival?.state || booking.origin?.state || '');
        }
        if (segment?.arrival?.airportCode) {
            travelRecord.dropoffAirportCode = String(segment.arrival.airportCode);
        } else if (segment?.departure?.airportCode) {
            travelRecord.dropoffAirportCode = String(segment.departure.airportCode);
        }
        if (segment?.startLocalDateTime || booking.startDate) {
            const pickup = segment?.startLocalDateTime ? new Date(segment.startLocalDateTime) : new Date(booking.startDate);
            travelRecord.pickupDate = pickup.toISOString();
        }
        if (segment?.endLocalDateTime || booking.endDate) {
            const dropoff = segment?.endLocalDateTime ? new Date(segment.endLocalDateTime) : new Date(booking.endDate);
            travelRecord.dropoffDate = dropoff.toISOString();
        }
        if (booking.grandTotal || booking.usdGrandTotal) {
            const cost = booking.grandTotal || booking.usdGrandTotal;
            travelRecord.carRentalCost = typeof cost === 'number' ? cost : parseFloat(cost);
        }
    }

    if (booking.reason) {
        travelRecord.reason = String(booking.reason);
    }

    if (booking.numberOfPassengers !== undefined) {
        travelRecord.navanPassengerCount = booking.numberOfPassengers;
    }

    if (booking.segments && Array.isArray(booking.segments)) {
        travelRecord.navanSegments = booking.segments;
    }

    Object.keys(travelRecord).forEach(key => {
        if (key === 'confirmationNumber') {
            return;
        }
        if (travelRecord[key] === null || travelRecord[key] === undefined || travelRecord[key] === '') {
            delete travelRecord[key];
        }
    });

    return travelRecord;
};

// Sync travel record to Travel Day event
// This ensures that when Navan imports create travel records, corresponding Travel Day events are created/updated
const syncTravelRecordToTravelDayEvent = async (context, travelRecord, action = 'created') => {
    try {
        const eventsContainer = getContainer('events');
        const travelDate = travelRecord.date || travelRecord.departureDate || travelRecord.startDate;
        
        if (!travelDate || !travelRecord.crcId) {
            context.log.warn(`Cannot sync travel record to Travel Day event: missing date or crcId. Travel record ID: ${travelRecord.id}`);
            return null;
        }
        
        // Normalize date to date-only string
        const normalizedDate = toDateOnlyString(travelDate);
        if (!normalizedDate) {
            context.log.warn(`Cannot sync travel record to Travel Day event: invalid date. Travel record ID: ${travelRecord.id}`);
            return null;
        }
        
        // Find existing Travel Day event linked to this travel record
        let existingEvent = null;
        try {
            let query = null;
            let parameters = [];
            
            // First try to find by Navan booking IDs (most reliable)
            if (travelRecord.navanBookingId || travelRecord.navanBookingUuid) {
                query = "SELECT * FROM c WHERE c.type = 'Travel Day' AND (c.navanBookingId = @bookingId OR c.navanBookingUuid = @bookingUuid)";
                parameters = [
                    { name: "@bookingId", value: travelRecord.navanBookingId || '' },
                    { name: "@bookingUuid", value: travelRecord.navanBookingUuid || '' }
                ];
            }
            // If no Navan IDs, try to find by travelRecordId
            else if (travelRecord.id) {
                query = "SELECT * FROM c WHERE c.type = 'Travel Day' AND c.travelRecordId = @travelRecordId";
                parameters = [
                    { name: "@travelRecordId", value: travelRecord.id }
                ];
            }
            // Last resort: find by date and crcId (less reliable, might match wrong event)
            else if (normalizedDate && travelRecord.crcId) {
                query = "SELECT * FROM c WHERE c.type = 'Travel Day' AND c.date = @date AND c.crcId = @crcId";
                parameters = [
                    { name: "@date", value: normalizedDate },
                    { name: "@crcId", value: travelRecord.crcId }
                ];
            }
            
            if (query) {
                const { resources } = await eventsContainer.items.query({
                    query: query,
                    parameters: parameters
                }).fetchAll();
                
                if (resources && resources.length > 0) {
                    existingEvent = resources[0];
                }
            }
        } catch (queryError) {
            context.log.warn(`Error querying for existing Travel Day event: ${queryError.message}`);
        }
        
        // If travel record is cancelled, remove or mark the Travel Day event as cancelled
        if (travelRecord.status === 'cancelled') {
            if (existingEvent) {
                try {
                    await eventsContainer.item(existingEvent.id, existingEvent.id).delete();
                    context.log.info(`Deleted Travel Day event ${existingEvent.id} because travel record ${travelRecord.id} was cancelled`);
                    return { action: 'deleted', eventId: existingEvent.id };
                } catch (deleteError) {
                    context.log.warn(`Error deleting cancelled Travel Day event: ${deleteError.message}`);
                }
            }
            return null;
        }
        
        // Create or update Travel Day event
        const travelDayEvent = {
            type: 'Travel Day',
            date: normalizedDate,
            crcId: travelRecord.crcId,
            crcIds: [travelRecord.crcId], // Travel Days use crcIds array
            navanBookingId: travelRecord.navanBookingId || null,
            navanBookingUuid: travelRecord.navanBookingUuid || null,
            travelRecordId: travelRecord.id, // Link back to travel record
            name: travelRecord.origin && travelRecord.destination 
                ? `${travelRecord.origin} → ${travelRecord.destination}` 
                : travelRecord.bookingType || 'Travel Day',
            notes: travelRecord.confirmationNumber 
                ? `Confirmation: ${travelRecord.confirmationNumber}` 
                : null,
            // Store travel details for reference
            bookingType: travelRecord.bookingType || null,
            origin: travelRecord.origin || null,
            destination: travelRecord.destination || null,
            flightNumber: travelRecord.flightNumber || null,
            status: travelRecord.status || 'scheduled'
        };
        
        // Remove null/undefined fields
        Object.keys(travelDayEvent).forEach(key => {
            if (travelDayEvent[key] === null || travelDayEvent[key] === undefined) {
                delete travelDayEvent[key];
            }
        });
        
        if (existingEvent) {
            // Only LINK to Navan - don't overwrite existing event data
            // Just add/update the Navan linking fields
            const linkedEvent = {
                ...existingEvent,
                navanBookingId: travelRecord.navanBookingId || existingEvent.navanBookingId || null,
                navanBookingUuid: travelRecord.navanBookingUuid || existingEvent.navanBookingUuid || null,
                travelRecordId: travelRecord.id || existingEvent.travelRecordId || null
            };
            
            // Remove null fields
            Object.keys(linkedEvent).forEach(key => {
                if (linkedEvent[key] === null) {
                    delete linkedEvent[key];
                }
            });
            
            try {
                const { resource: updatedEvent } = await eventsContainer.items.upsert(linkedEvent);
                context.log.info(`Linked Travel Day event ${updatedEvent.id} to Navan travel record ${travelRecord.id}`);
                return { action: 'linked', eventId: updatedEvent.id, event: updatedEvent };
            } catch (updateError) {
                context.log.error(`Error linking Travel Day event: ${updateError.message}`);
                throw updateError;
            }
        } else {
            // Create new event only if one doesn't exist
            travelDayEvent.id = generateId();
            try {
                const { resource: createdEvent } = await eventsContainer.items.create(travelDayEvent);
                context.log.info(`Created Travel Day event ${createdEvent.id} from travel record ${travelRecord.id}`);
                return { action: 'created', eventId: createdEvent.id, event: createdEvent };
            } catch (createError) {
                context.log.error(`Error creating Travel Day event: ${createError.message}`);
                throw createError;
            }
        }
    } catch (error) {
        // Log error but don't fail the travel record creation/update
        context.log.error(`Error syncing travel record to Travel Day event: ${error.message}`);
        context.log.error(`Travel record ID: ${travelRecord.id}, Error stack: ${error.stack}`);
        return null;
    }
};

const upsertNavanBooking = async (context, booking, {
    bookingId,
    bookingUuid = null,
    readOnly = false,
    updateOnly = false, // If true, only update existing records, don't create new ones
    crcResolver = null,
    allowFallbackCrc = true
} = {}) => {
    let travelContainer = null;
    if (!readOnly) {
        try {
            travelContainer = getContainer('travel');
        } catch (containerError) {
            context.log.error('upsertNavanBooking: Error getting travel container:', containerError.message);
            context.log.error('upsertNavanBooking: Container error stack:', containerError.stack);
            // If container doesn't exist, throw a clear error
            if (containerError.code === 404 || (containerError.message && containerError.message.includes('NotFound'))) {
                throw new Error("DATABASE_ERROR: 'travel' container not found. Please create the 'travel' container in Cosmos DB with partition key '/id'.");
            }
            throw containerError;
        }
    }
    const { crcId, travelerName, matched } = await resolveCrcIdForNavanBooking(booking, context, { allowFallbackName: allowFallbackCrc, crcResolver });

    if (!crcId) {
        context.log.warn(`No CRC match found for booking ${bookingId || bookingUuid || booking.uuid}. Skipping import.`);
        return { skipped: true, reason: 'CRC not found', travelerName };
    }

    const travelRecord = createTravelRecordFromNavanBooking(booking, bookingId || booking.bookingId, bookingUuid || booking.uuid, crcId, travelerName, context);

    if (!matched && allowFallbackCrc && crcId === travelerName) {
        context.log.warn(`Using traveler name as temporary CRC identifier for booking ${bookingId || bookingUuid}`);
    }

    if (readOnly) {
        return { travelRecord, action: 'readOnly', saved: false, matched };
    }

    const bookingIdentifier = bookingId || travelRecord.navanBookingId;
    const bookingUuidIdentifier = bookingUuid || travelRecord.navanBookingUuid;

    let existingTravel = null;
    try {
        const { resources: existingRecords } = await travelContainer.items
            .query({
                query: "SELECT * FROM c WHERE (IS_DEFINED(c.navanBookingId) AND c.navanBookingId = @bookingId) OR (IS_DEFINED(c.navanBookingUuid) AND c.navanBookingUuid = @uuid)",
                parameters: [
                    { name: "@bookingId", value: bookingIdentifier },
                    { name: "@uuid", value: bookingUuidIdentifier || '' }
                ]
            })
            .fetchAll();

        if (existingRecords && existingRecords.length > 0) {
            existingTravel = existingRecords[0];
        }
    } catch (queryError) {
        // Check if this is a container missing error
        if (queryError.code === 404 || (queryError.message && queryError.message.includes('NotFound'))) {
            throw new Error("DATABASE_ERROR: 'travel' container not found. Please create the 'travel' container in Cosmos DB with partition key '/id'.");
        }
        context.log.warn('Error querying for existing travel record:', queryError.message);
        context.log.warn('Query error stack:', queryError.stack);
    }

    if (existingTravel) {
        const updatedTravel = { ...existingTravel, ...travelRecord, id: existingTravel.id };
        try {
            await travelContainer.items.upsert(updatedTravel);
            context.log.info(`Updated existing travel record for Navan booking ${bookingIdentifier}`);
            
            // Sync to Travel Day event
            try {
                await syncTravelRecordToTravelDayEvent(context, updatedTravel, 'updated');
            } catch (syncError) {
                // Log but don't fail - travel record was updated successfully
                context.log.warn(`Failed to sync travel record to Travel Day event: ${syncError.message}`);
            }
            
            return { travelRecord: updatedTravel, action: 'updated', saved: true, matched };
        } catch (upsertError) {
            // Check if this is a container missing error
            if (upsertError.code === 404 || (upsertError.message && upsertError.message.includes('NotFound'))) {
                throw new Error("DATABASE_ERROR: 'travel' container not found. Please create the 'travel' container in Cosmos DB with partition key '/id'.");
            }
            context.log.error('Error upserting travel record:', upsertError.message);
            context.log.error('Upsert error stack:', upsertError.stack);
            context.log.error('Upsert error details:', safeStringify(upsertError));
            throw upsertError;
        }
    } else {
        // If updateOnly is true, skip creating new records
        if (updateOnly) {
            context.log.info(`Skipping creation of new travel record for Navan booking ${bookingIdentifier} (updateOnly mode)`);
            return { travelRecord, action: 'skipped', saved: false, matched, reason: 'updateOnly mode - record does not exist' };
        }
        
        const newTravel = { ...travelRecord, id: generateId() };
        context.log.info('Creating new travel record with data:', safeStringify(newTravel));
        try {
            await travelContainer.items.create(newTravel);
            context.log.info(`Created new travel record for Navan booking ${bookingIdentifier}`);
            
            // Sync to Travel Day event
            try {
                await syncTravelRecordToTravelDayEvent(context, newTravel, 'created');
            } catch (syncError) {
                // Log but don't fail - travel record was created successfully
                context.log.warn(`Failed to sync travel record to Travel Day event: ${syncError.message}`);
            }
            
            return { travelRecord: newTravel, action: 'created', saved: true, matched };
        } catch (createError) {
            // Check if this is a container missing error (in case query didn't catch it)
            if (createError.code === 404 || (createError.message && createError.message.includes('NotFound'))) {
                throw new Error("DATABASE_ERROR: 'travel' container not found. Please create the 'travel' container in Cosmos DB with partition key '/id'.");
            }
            context.log.error('Error creating travel record:', createError.message);
            context.log.error('Create error stack:', createError.stack);
            context.log.error('Create error details:', safeStringify(createError));
            context.log.error('Travel record that failed to create:', safeStringify(newTravel));
            throw createError;
        }
    }
};

// Navan booking lookup endpoint
// This endpoint calls Navan API to get booking information by bookingId
// Step 1: Get OAuth token from https://api.navan.com/ta-auth/oauth/token
// Step 2: Call Navan Bookings API: https://api.navan.com/v1/bookings?createdFrom={timestamp}&createdTo={timestamp}
//        Then filter results by bookingId client-side
// Configure API credentials in Azure Static Web App environment variables:
// - NAVAN_CLIENT_ID: Set in Azure environment variables
// - NAVAN_SECRET_KEY: Set in Azure environment variables
app.http('navanLookup', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'navan-lookup',
    handler: async (request, context) => {
        ensureContextLogger(context);
        // Handle OPTIONS request for CORS
        if (request.method === 'OPTIONS') {
            return {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                }
            };
        }
        
        let bookingId = null;
        let bookingUuidParam = null;
        
        try {
            // Gets quersy parameters - try multiple methods for compatibility
            if (request.query && request.query.bookingId) {
                bookingId = request.query.bookingId;
            } else if (request.query && typeof request.query.get === 'function') {
                bookingId = request.query.get('bookingId');
            } else if (request.url) {
                try {
                    // Try to parse as full URL
                    let urlString = request.url;
                    if (!urlString.startsWith('http')) {
                        // If relative, construct full URL
                        urlString = `https://${request.headers?.['host'] || 'localhost'}${urlString}`;
                    }
                    const url = new URL(urlString);
                    bookingId = url.searchParams.get('bookingId');
                } catch (error) {
                    context.log.warn('Error parsing URL:', error.message);
                    // Try simple query string parsing
                    const match = request.url.match(/[?&]bookingId=([^&]+)/);
                    if (match) {
                        bookingId = decodeURIComponent(match[1]);
                    }
                }
            }
            if (request.query && request.query.bookingUuid) {
                bookingUuidParam = request.query.bookingUuid;
            } else if (request.query && typeof request.query.get === 'function') {
                bookingUuidParam = request.query.get('bookingUuid');
            } else if (request.url) {
                const matchUuid = request.url.match(/[?&]bookingUuid=([^&]+)/);
                if (matchUuid) {
                    bookingUuidParam = decodeURIComponent(matchUuid[1]);
                }
            }
            
            if (!bookingId && !bookingUuidParam) {
                context.log.error('Navan lookup: bookingId or bookingUuid parameter missing. URL:', request.url);
                return {
                    status: 400,
                    jsonBody: { error: 'bookingId or bookingUuid parameter is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Check if this is a read-only request (no database write)
            const readOnly = request.query?.readOnly === 'true' || 
                           (request.query && typeof request.query.get === 'function' && request.query.get('readOnly') === 'true') ||
                           (request.url && request.url.includes('readOnly=true'));
            
            context.log.info(`Navan booking lookup request for: ${bookingId || 'N/A'} uuid: ${bookingUuidParam || 'N/A'} (readOnly: ${readOnly})`);
            
            // Step 1: Get OAuth token from Navan
            const tokenResult = await fetchNavanAccessToken(context);
            if (!tokenResult.success) {
                return tokenResult.response;
            }
            const accessToken = tokenResult.accessToken;
            const tokenType = tokenResult.tokenType || 'Bearer';
            context.log.info(`OAuth token obtained successfully. TokenType: ${tokenType}`);
            
            // Step 2: Get booking data from Navan
            // Strategy: First try to find booking by bookingId, then use its UUID for direct lookup
            context.log.info(`Fetching booking ${bookingId} from Navan...`);
            
            let bookingData = null;
            let bookingUuid = bookingUuidParam || null;
            
            try {
                const fetchFn = await getFetch();
                if (bookingUuid) {
                    context.log.info(`Direct UUID lookup for bookingUuid=${bookingUuid}`);
                    const authHeader = `${tokenType} ${accessToken}`;
                    const uuidResponse = await fetchFn(`https://api.navan.com/v1/bookings?bookingUuid=${bookingUuid}&includeTransactions=false`, {
                        method: 'GET',
                        headers: {
                            'Authorization': authHeader,
                            'Accept': 'application/json'
                        }
                    });
                    if (!uuidResponse.ok) {
                        const errorText = await uuidResponse.text();
                        context.log.error(`UUID lookup failed: ${uuidResponse.status} - ${errorText}`);
                        return {
                            status: uuidResponse.status,
                            jsonBody: {
                                error: 'Failed to fetch booking from Navan using UUID',
                                bookingUuid: bookingUuid,
                                details: errorText
                            },
                            headers: { 'Content-Type': 'application/json' }
                        };
                    }
                    const uuidBookingData = await uuidResponse.json();
                    if (uuidBookingData.data && uuidBookingData.data.length > 0) {
                        bookingData = { data: [uuidBookingData.data[0]] };
                        bookingId = bookingData.data[0].bookingId || bookingId;
                        context.log.info('Full booking details retrieved via UUID');
                    } else {
                        context.log.warn(`No booking returned for bookingUuid=${bookingUuid}`);
                        return {
                            status: 404,
                            jsonBody: {
                                error: 'Booking not found',
                                bookingUuid: bookingUuid,
                                message: 'No booking returned for the provided booking UUID.'
                            },
                            headers: { 'Content-Type': 'application/json' }
                        };
                    }
                } else {
                    // Search by bookingId within date window
                    const queryCreatedFrom = request.query?.createdFrom || request.query?.get?.('createdFrom');
                    const queryCreatedTo = request.query?.createdTo || request.query?.get?.('createdTo');
                    const midnightToday = Math.floor(new Date(new Date().toISOString().split('T')[0] + 'T23:59:59Z').getTime() / 1000);
                    const defaultCreatedFrom = midnightToday - (89 * 24 * 60 * 60);
                    const createdFrom = queryCreatedFrom ? parseInt(queryCreatedFrom, 10) : defaultCreatedFrom;
                    const createdTo = queryCreatedTo ? parseInt(queryCreatedTo, 10) : midnightToday;
                    
                    context.log.info(`Searching for bookingId ${bookingId} between ${new Date(createdFrom * 1000).toISOString()} and ${new Date(createdTo * 1000).toISOString()}`);
                    
                    let page = 0;
                    const pageSize = 100;
                    let foundBooking = null;
                    
                    while (!foundBooking && page < 10) {
                        context.log.info(`Fetching page ${page} of bookings to find bookingId...`);
                        const authHeader = `${tokenType} ${accessToken}`;
                        const bookingResponse = await fetchFn(`https://api.navan.com/v1/bookings?createdFrom=${createdFrom}&createdTo=${createdTo}&page=${page}&size=${pageSize}&includeTransactions=false`, {
                            method: 'GET',
                            headers: {
                                'Authorization': authHeader,
                                'Accept': 'application/json'
                            }
                        });
                        
                        if (!bookingResponse.ok) {
                            const errorText = await bookingResponse.text();
                            context.log.error(`Booking request failed: ${bookingResponse.status} - ${errorText}`);
                            return {
                                status: bookingResponse.status,
                                jsonBody: {
                                    error: 'Failed to fetch bookings from Navan',
                                    bookingId: bookingId,
                                    details: errorText
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                        
                        const allBookings = await bookingResponse.json();
                        foundBooking = allBookings.data?.find(b => b.bookingId === bookingId) || null;
                        if (foundBooking) {
                            bookingUuid = foundBooking.uuid;
                            context.log.info(`Booking found with UUID ${bookingUuid}, retrieving full details`);
                            const authHeader = `${tokenType} ${accessToken}`;
                            const uuidResponse = await fetchFn(`https://api.navan.com/v1/bookings?bookingUuid=${bookingUuid}&includeTransactions=false`, {
                                method: 'GET',
                                headers: {
                                    'Authorization': authHeader,
                                    'Accept': 'application/json'
                                }
                            });
                            if (uuidResponse.ok) {
                                const uuidBookingData = await uuidResponse.json();
                                if (uuidBookingData.data && uuidBookingData.data.length > 0) {
                                    bookingData = { data: [uuidBookingData.data[0]] };
                                } else {
                                    bookingData = { data: [foundBooking] };
                                }
                            } else {
                                const errorText = await uuidResponse.text();
                                context.log.warn(`UUID lookup failed (status ${uuidResponse.status}): ${errorText}`);
                                bookingData = { data: [foundBooking] };
                            }
                            break;
                        }
                        
                        if (allBookings.page && allBookings.page.totalPages && page < allBookings.page.totalPages - 1) {
                            page++;
                        } else {
                            break;
                        }
                    }
                    
                    if (!bookingData) {
                        context.log.warn(`Booking ${bookingId} not found within provided timeframe`);
                        return {
                            status: 404,
                            jsonBody: {
                                error: 'Booking not found',
                                bookingId: bookingId,
                                message: 'Booking not found in recent bookings. The booking may be outside the date window or the bookingId may be incorrect.'
                            },
                            headers: { 'Content-Type': 'application/json' }
                        };
                    }
                }
            } catch (fetchError) {
                context.log.error('Error fetching booking from Navan:', fetchError.message);
                context.log.error('Fetch error stack:', fetchError.stack);
                throw fetchError;
            }
            
            if (!bookingData || !bookingData.data || bookingData.data.length === 0) {
                return {
                    status: 404,
                    jsonBody: {
                        error: 'Booking not found',
                        bookingId: bookingId,
                        bookingUuid: bookingUuid,
                        message: 'No booking data returned from Navan.'
                    },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            const booking = bookingData.data[0];
            const importResult = await upsertNavanBooking(context, booking, {
                bookingId,
                bookingUuid: bookingUuid || booking.uuid,
                readOnly,
                allowFallbackCrc: true
            });

            if (importResult.skipped) {
                return {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    jsonBody: {
                        error: 'Booking not linked',
                        detail: 'No matching CRC was found for this booking.',
                        bookingId,
                        bookingUuid: bookingUuid || booking.uuid
                    }
                };
            }

            const responseBody = {
                data: bookingData.data,
                navanImport: {
                    action: importResult.action,
                    saved: importResult.saved,
                    matched: importResult.matched
                }
            };

            if (readOnly) {
                responseBody.readOnly = true;
                responseBody.travelRecord = importResult.travelRecord;
                responseBody.message = 'Booking data retrieved successfully (read-only mode - not saved to database)';
            }

            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                jsonBody: responseBody
            };
            
        } catch (error) {
            context.log.error('Navan lookup error:', error.message);
            context.log.error('Error stack:', error.stack);
            context.log.error('Error details:', safeStringify(error));
            
            return {
                status: 200, // Return 200 so frontend can see error details
                jsonBody: { 
                    error: 'Navan lookup failed',
                    detail: error.message || 'Unknown error occurred',
                    stack: error.stack || 'No stack trace available',
                    originalMessage: 'Navan lookup exception',
                    bookingId: bookingId || null
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
        }
    },
});

// Navan API connection test endpoint
// Tests OAuth token generation to verify Navan API connectivity
app.http('navanTest', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'navan-test',
    handler: async (request, context) => {
        ensureContextLogger(context);
        let skipApiCall = false;
        let includeFullToken = false;
        // Wrap everything in a try-catch to ensure we always return a response
        try {
            // Default error response
            const errorResponse = (error, detail) => ({
                status: 200, // Always return 200 so frontend can see error details
                jsonBody: {
                    connected: false,
                    error: error || 'Connection test failed',
                    detail: detail || 'Unknown error occurred',
                        message: 'Failed to test Navan API connection',
                        diagnostic: {
                            skipApiCall,
                            includeFullToken
                        }
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
            
            // Handle OPTIONS request for CORS
            if (request.method === 'OPTIONS') {
                return {
                    status: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type'
                    }
                };
            }
            
            try {
                context.log.info('Navan API connection test requested');
            
            // Get Navan API credentials from environment variables
            let clientId, clientSecret;
            try {
                clientId = process.env.NAVAN_CLIENT_ID;
                clientSecret = process.env.NAVAN_SECRET_KEY;
            } catch (envError) {
                context.log.error('Error reading environment variables:', envError);
                return errorResponse('Environment variable read error', envError.message);
            }
            
            // Check if credentials are available
            if (!clientId || !clientSecret) {
                context.log.error('Navan credentials not configured');
                context.log.error(`NAVAN_CLIENT_ID: ${clientId ? 'set (length: ' + clientId.length + ')' : 'missing'}`);
                context.log.error(`NAVAN_SECRET_KEY: ${clientSecret ? 'set (length: ' + clientSecret.length + ')' : 'missing'}`);
                return {
                    status: 200, // Return 200 so frontend can see the error details
                    jsonBody: {
                        connected: false,
                        error: 'Navan API credentials not configured',
                        detail: `NAVAN_CLIENT_ID is ${clientId ? 'set (length: ' + clientId.length + ')' : 'missing'}, NAVAN_SECRET_KEY is ${clientSecret ? 'set (length: ' + clientSecret.length + ')' : 'missing'}`,
                        message: 'Please set NAVAN_CLIENT_ID and NAVAN_SECRET_KEY in Azure environment variables'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            skipApiCall = (() => {
                const querySkip = request.query?.skipApiCall || request.query?.get?.('skipApiCall');
                if (typeof querySkip === 'string') {
                    return querySkip.toLowerCase() !== 'false';
                }
                if (request.url && request.url.includes('skipApiCall=false')) {
                    return false;
                }
                return false; // default: execute API call
            })();

            includeFullToken = (() => {
                const queryInclude = request.query?.includeToken || request.query?.get?.('includeToken');
                if (typeof queryInclude === 'string') {
                    return queryInclude.toLowerCase() === 'true';
                }
                if (request.url && request.url.includes('includeToken=true')) {
                    return true;
                }
                return false;
            })();

            // Test OAuth token generation
            context.log.info('Testing OAuth token generation...');
            let tokenResponse;
            try {
                const fetchFn = await getFetch();
                const oauthUrl = 'https://api.navan.com/ta-auth/oauth/token';
                context.log.info(`Navan OAuth Test: Requesting token from ${oauthUrl}`);
                
                // Build form-encoded body (matching Postman format)
                const bodyParams = new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: clientId,
                    client_secret: clientSecret
                });
                const bodyString = bodyParams.toString();
                context.log.info(`Navan OAuth Test: Body params - grant_type=client_credentials, client_id length=${clientId?.length || 0}, client_secret length=${clientSecret?.length || 0}`);
                
                tokenResponse = await fetchFn(oauthUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: bodyString
                });
            } catch (fetchError) {
                context.log.error('Fetch error during OAuth token request:', fetchError);
                return errorResponse('Network error during OAuth request', fetchError.message);
            }
            
            if (!tokenResponse.ok) {
                let errorText = 'Unknown error';
                try {
                    errorText = await tokenResponse.text();
                } catch (textError) {
                    context.log.error('Error reading error response text:', textError);
                }
                context.log.error(`OAuth token test failed: ${tokenResponse.status} - ${errorText}`);
                return {
                    status: 200, // Return 200 so frontend can see the error details
                    jsonBody: {
                        connected: false,
                        error: 'Failed to generate OAuth token',
                        detail: `OAuth token request failed with status ${tokenResponse.status}: ${errorText}`,
                        message: 'Unable to connect to Navan API. Check credentials and network connectivity.'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            let tokenData;
            try {
                tokenData = await tokenResponse.json();
            } catch (jsonError) {
                context.log.error('Error parsing token response JSON:', jsonError);
                let responseText = 'Unable to read response';
                try {
                    responseText = await tokenResponse.text();
                } catch (textError) {
                    // Ignore
                }
                return errorResponse('Invalid token response format', `Failed to parse JSON: ${jsonError.message}. Response: ${responseText.substring(0, 200)}`);
            }
            
            const accessToken = tokenData?.access_token;
            const tokenType = tokenData?.token_type || 'Bearer';
            
            if (!accessToken) {
                context.log.error('No access token in response:', tokenData);
                return {
                    status: 200,
                    jsonBody: {
                        connected: false,
                        error: 'No access token received',
                        detail: 'OAuth token response did not contain access_token',
                        message: 'Navan API returned invalid token response'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            if (skipApiCall) {
                context.log.info('OAuth token generated; skipping bookings API call (diagnostic mode).');
                return {
                    status: 200,
                    jsonBody: {
                        connected: true,
                        oauthToken: true,
                        apiCall: false,
                        token: includeFullToken ? accessToken : `${accessToken.substring(0, 8)}...`,
                        tokenType: tokenType,
                        message: 'Successfully obtained OAuth token. Bookings API call skipped. Add skipApiCall=false to test API call.',
                        note: includeFullToken ? 'Full token returned for diagnostics.' : 'Token truncated. Add includeToken=true to return full token (use with caution).'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }

            // Test a simple API call to verify the token works
            context.log.info('Testing API call with token...');
                const now = Math.floor(Date.now() / 1000);
                const midnightToday = Math.floor(new Date(new Date().toISOString().split('T')[0] + 'T23:59:59Z').getTime() / 1000);
                const eightyNineDaysAgoMidnight = midnightToday - (89 * 24 * 60 * 60);
                const createdFromParam = request.query?.createdFrom || request.query?.get?.('createdFrom') || `${eightyNineDaysAgoMidnight}`;
                const createdToParam = request.query?.createdTo || request.query?.get?.('createdTo') || `${midnightToday}`;
                context.log.info(`Using createdFrom=${createdFromParam}, createdTo=${createdToParam} for diagnostic bookings request`);
            let testApiResponse;
            try {
                const fetchFn = await getFetch();
                const diagnosticsUrl = `https://api.navan.com/v1/bookings?createdFrom=${createdFromParam}&createdTo=${createdToParam}&page=0&size=1&includeTransactions=false`;
                const authHeader = `${tokenType} ${accessToken}`;
                testApiResponse = await fetchFn(diagnosticsUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': authHeader,
                        'Accept': 'application/json'
                    }
                });
            } catch (fetchError) {
                context.log.error('Fetch error during API test call:', fetchError);
                return {
                    status: 200,
                    jsonBody: {
                        connected: true,
                        oauthToken: true,
                        apiCall: false,
                        error: 'Network error during API call',
                        detail: fetchError.message,
                        message: 'OAuth token generated but API call failed due to network error.'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            if (!testApiResponse.ok) {
                const errorText = await testApiResponse.text();
                context.log.warn(`API test call failed: ${testApiResponse.status} - ${errorText}`);
                return {
                    status: 200,
                    jsonBody: {
                        connected: true,
                        oauthToken: true,
                        apiCall: false,
                        error: 'OAuth token generated but API call failed',
                        detail: `API call failed with status ${testApiResponse.status}: ${errorText}`,
                        message: 'Connected to Navan OAuth but API call failed. This may be normal if there are no recent bookings.'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            context.log.info('Navan API connection test successful');
            return {
                status: 200,
                jsonBody: {
                    connected: true,
                    oauthToken: true,
                    apiCall: true,
                    message: 'Successfully connected to Navan API'
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
            
            } catch (error) {
                context.log.error('Navan connection test error:', error.message);
                context.log.error('Error stack:', error.stack);
                try {
                    context.log.error('Full error object:', safeStringify(error));
                } catch (stringifyError) {
                    context.log.error('Could not stringify error object:', stringifyError);
                }
                
                // Ensure we always return a valid response, even if there's an error
                try {
                    return {
                        status: 200, // Return 200 so frontend can see the error details
                        jsonBody: {
                            connected: false,
                            error: 'Connection test failed',
                            detail: error?.message || error?.toString() || 'Unknown error occurred',
                            stack: error?.stack || 'No stack trace available',
                            message: 'Failed to test Navan API connection'
                        },
                        headers: { 
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        }
                    };
                } catch (responseError) {
                    // If even creating the response fails, log it and return minimal response
                    context.log.error('Error creating error response:', responseError);
                    try {
                        return {
                            status: 200,
                            jsonBody: {
                                connected: false,
                                error: 'Critical error',
                                detail: 'An unexpected error occurred while processing the request',
                                message: 'Failed to test Navan API connection'
                            },
                            headers: { 
                                'Content-Type': 'application/json',
                                'Access-Control-Allow-Origin': '*'
                            }
                        };
                    } catch (finalError) {
                        // Last resort - return a simple response
                        context.log.error('Final error in error handler:', finalError);
                        return {
                            status: 200,
                            jsonBody: { connected: false, error: 'Critical error', message: 'Failed to test Navan API connection' },
                            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                        };
                    }
                }
            }
        } catch (outerError) {
            // Catch any errors that occur outside the main try-catch (e.g., in errorResponse function)
            try {
                context.log.error('Outer error in navanTest handler:', outerError);
                return {
                    status: 200,
                    jsonBody: {
                        connected: false,
                        error: 'Handler initialization error',
                        detail: outerError?.message || outerError?.toString() || 'Unknown error',
                        message: 'Failed to initialize Navan API connection test'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            } catch (lastError) {
                // Absolute last resort
                context.log.error('Complete failure in navanTest handler:', lastError);
                return {
                    status: 200,
                    jsonBody: { connected: false, error: 'Complete failure', message: 'Failed to test Navan API connection' },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }
        }
    },
});

// Azure Maps Geocoding Proxy
app.http('geocode', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'geocode',
    handler: async (request, context) => {
        try {
            const azureMapsKey = process.env.AZURE_MAPS_KEY || process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
            if (!azureMapsKey) {
                return {
                    status: 500,
                    jsonBody: { error: 'Azure Maps key not configured' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Get query parameters from the original request
            let queryParams = '';
            if (request.url) {
                try {
                    // Extract query string from URL
                    let urlString = request.url;
                    if (!urlString.startsWith('http')) {
                        // Construct full URL if relative
                        const host = request.headers?.['host'] || request.headers?.['x-forwarded-host'] || 'localhost';
                        urlString = `https://${host}${urlString}`;
                    }
                    const url = new URL(urlString);
                    queryParams = url.search; // This includes the leading ?
                } catch (error) {
                    context.log.warn('Error parsing URL for geocode:', error.message);
                    // Fallback: extract query string manually
                    const match = request.url.match(/\?(.+)/);
                    if (match) {
                        queryParams = '?' + match[1];
                    } else {
                        queryParams = '';
                    }
                }
            }
            
            // Build the Azure Maps API URL - pass all query params and add subscription-key
            const apiUrl = `https://atlas.microsoft.com/search/address/json${queryParams ? queryParams + '&' : '?'}subscription-key=${azureMapsKey}`;
            
            try {
                const fetchFn = await getFetch();
                const response = await fetchFn(apiUrl);
                const data = await response.json();
                return {
                    status: 200,
                    jsonBody: data,
                    headers: { 'Content-Type': 'application/json' }
                };
            } catch (error) {
                context.log.error('Azure Maps geocoding error:', error.message);
                return {
                    status: 500,
                    jsonBody: { error: error.message },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
        } catch (error) {
            context.log.error('Geocode endpoint error:', error.message);
            return {
                status: 500,
                jsonBody: { error: error.message },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    }
});

// Azure Maps Route Directions Proxy
app.http('routeDirections', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'route/directions',
    handler: async (request, context) => {
        try {
            const azureMapsKey = process.env.AZURE_MAPS_KEY || process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
            if (!azureMapsKey) {
                return {
                    status: 500,
                    jsonBody: { error: 'Azure Maps key not configured' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Get query parameters from the original request
            let queryParams = '';
            if (request.url) {
                try {
                    // Extract query string from URL
                    let urlString = request.url;
                    if (!urlString.startsWith('http')) {
                        // Construct full URL if relative
                        const host = request.headers?.['host'] || request.headers?.['x-forwarded-host'] || 'localhost';
                        urlString = `https://${host}${urlString}`;
                    }
                    const url = new URL(urlString);
                    queryParams = url.search; // This includes the leading ?
                } catch (error) {
                    context.log.warn('Error parsing URL for route directions:', error.message);
                    // Fallback: extract query string manually
                    const match = request.url.match(/\?(.+)/);
                    if (match) {
                        queryParams = '?' + match[1];
                    } else {
                        queryParams = '';
                    }
                }
            }
            
            // Build the Azure Maps API URL - pass all query params and add subscription-key
            const apiUrl = `https://atlas.microsoft.com/route/directions/json${queryParams ? queryParams + '&' : '?'}subscription-key=${azureMapsKey}`;
            
            try {
                const fetchFn = await getFetch();
                const response = await fetchFn(apiUrl);
                const data = await response.json();
                return {
                    status: 200,
                    jsonBody: data,
                    headers: { 'Content-Type': 'application/json' }
                };
            } catch (error) {
                context.log.error('Azure Maps route directions error:', error.message);
                return {
                    status: 500,
                    jsonBody: { error: error.message },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
        } catch (error) {
            context.log.error('Route directions endpoint error:', error.message);
            return {
                status: 500,
                jsonBody: { error: error.message },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    }
});

const fetchNavanBookingsInRange = async (context, accessToken, { createdFrom, createdTo, pageSize = 100, maxPages = 50 } = {}, tokenType = 'Bearer') => {
    const bookings = [];
    let page = 0;

    while (page < maxPages) {
        try {
            const response = await fetchNavanBookingsPage(accessToken, { createdFrom, createdTo, page, size: pageSize }, tokenType, context);
            if (!response.ok) {
                const errorText = await response.text();
                context.log.error(`Navan bookings range request failed (page ${page}): ${response.status} - ${errorText}`);
                if (response.status === 401) {
                    context.log.error(`Navan 401 Unauthorized - Token may be invalid. Token preview: ${accessToken.substring(0, 20)}..., TokenType: ${tokenType}, Full auth header: ${tokenType ? `${tokenType} ${accessToken.substring(0, 20)}...` : `Bearer ${accessToken.substring(0, 20)}...`}`);
                    // Try to get more details from error response
                    try {
                        const errorJson = JSON.parse(errorText);
                        context.log.error(`Navan 401 error details:`, JSON.stringify(errorJson));
                    } catch (e) {
                        context.log.error(`Navan 401 error text: ${errorText}`);
                    }
                }
                // If it's the first page, throw error. Otherwise, return what we have.
                if (page === 0) {
                    throw new Error(`Failed to fetch bookings page ${page}: ${errorText}`);
                } else {
                    context.log.warn(`Navan bookings fetch stopped at page ${page}. Returning ${bookings.length} bookings fetched so far.`);
                    break;
                }
            }

            const data = await response.json();
            
            // Log full response structure for debugging
            context.log.info(`Navan API Response (page ${page}):`, {
                hasData: !!data?.data,
                dataIsArray: Array.isArray(data?.data),
                dataLength: data?.data?.length || 0,
                hasPage: !!data?.page,
                totalPages: data?.page?.totalPages,
                totalElements: data?.page?.totalElements,
                responseKeys: Object.keys(data || {}),
                firstBookingSample: data?.data?.[0] ? Object.keys(data.data[0]) : null
            });
            
            if (Array.isArray(data?.data) && data.data.length > 0) {
                bookings.push(...data.data);
                context.log.info(`navanImport: Fetched page ${page + 1}, got ${data.data.length} bookings (total so far: ${bookings.length})`);
            } else {
                context.log.warn(`navanImport: Page ${page + 1} returned empty or invalid data. Response structure:`, JSON.stringify(data).substring(0, 500));
            }

            if (!data?.page || data.page.totalPages === undefined || page >= data.page.totalPages - 1) {
                context.log.info(`navanImport: Reached end of pages. Total bookings fetched: ${bookings.length}`);
                break;
            }

            page += 1;
            
            // Small delay between page fetches to avoid overwhelming Navan API
            if (page < maxPages) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (pageError) {
            context.log.error(`Error fetching page ${page}:`, pageError);
            // If we have some bookings, return them. Otherwise, throw.
            if (bookings.length > 0) {
                context.log.warn(`Returning partial results: ${bookings.length} bookings from ${page} pages`);
                break;
            }
            throw pageError;
        }
    }

    return bookings;
};

const fetchNavanBookingById = async (context, accessToken, bookingId, { createdFrom, createdTo, pageSize = 100, maxPages = 20 } = {}, tokenType = 'Bearer') => {
    let page = 0;
    while (page < maxPages) {
        const response = await fetchNavanBookingsPage(accessToken, { createdFrom, createdTo, page, size: pageSize }, tokenType, context);
        if (!response.ok) {
            const errorText = await response.text();
            context.log.error(`Navan bookingId search failed (page ${page}): ${response.status} - ${errorText}`);
            if (response.status === 401) {
                context.log.error(`Navan 401 Unauthorized - Token may be invalid. Token preview: ${accessToken.substring(0, 20)}..., TokenType: ${tokenType}`);
            }
            throw new Error(`Failed to fetch bookings for bookingId search: ${errorText}`);
        }

        const data = await response.json();
        if (Array.isArray(data?.data)) {
            const match = data.data.find(item => item.bookingId === bookingId || item.id === bookingId);
            if (match) {
                return match;
            }
        }

        if (!data?.page || data.page.totalPages === undefined || page >= data.page.totalPages - 1) {
            break;
        }

        page += 1;
    }

    return null;
};

const loadAllCrcs = async (context) => {
    try {
        const crcsContainer = getContainer('crcs');
        const { resources } = await crcsContainer.items.readAll().fetchAll();
        context.log.info(`Loaded ${resources?.length || 0} CRC records for Navan import matching.`);
        return resources || [];
    } catch (error) {
        context.log.error('Failed to load CRC list for Navan import:', error.message);
        context.log.error('CRC load error stack:', error.stack);
        return [];
    }
};

app.http('navanImport', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'navan-import',
    handler: async (request, context) => {
        // Wrap entire handler in try-catch to catch any unhandled errors
        const limitArray = (arr, limit = 50) => (arr.length > limit ? arr.slice(0, limit) : arr);
        
        let summary = {
            importType: 'range',
            totals: {
                fetched: 0,
                processed: 0,
                created: 0,
                updated: 0,
                skipped: 0
            },
            skippedBookings: [],
            errors: []
        };
        
        // For backdoor mode: collect travel records without saving to DB
        const cachedTravelRecords = [];
        let backdoorMode = false;
        
        try {
            // Ensure context logger is available
            if (!context) {
                return {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    jsonBody: {
                        success: false,
                        error: 'Function context not available',
                        summary
                    }
                };
            }
            
            ensureContextLogger(context);

            // Log request details for debugging
            context.log.info(`navanImport: Request received. Method: ${request.method || 'UNKNOWN'}, URL: ${request.url || 'N/A'}`);
            
            if (request.method === 'OPTIONS') {
                return {
                    status: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type'
                    }
                };
            }

            let body = {};
            try {
                // Try to read the request body as JSON
                body = await request.json();
                backdoorMode = body.backdoorMode === true || body.cacheOnly === true;
                context.log.info(`navanImport: Request body parsed. pastDays: ${body.pastDays}, futureDays: ${body.futureDays}, importType: ${body.importType}, backdoorMode: ${backdoorMode}`);
            } catch (parseError) {
                context.log.error('navanImport: Failed to parse request body:', parseError.message);
                context.log.error('navanImport: Parse error stack:', parseError.stack);
                context.log.error('navanImport: Parse error name:', parseError.name);
                // Return error response instead of continuing with empty body
                summary.errors.push({
                    message: `Failed to parse request body: ${parseError.message}`,
                    type: 'Parse error'
                });
                return {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    jsonBody: {
                        success: false,
                        error: 'Invalid request body',
                        detail: `Failed to parse JSON: ${parseError.message}`,
                        errorName: parseError.name,
                        summary
                    }
                };
            }

            const importType = (body.importType || 'range').toLowerCase();
            summary.importType = importType;

            // 1. Authenticate with Navan
            context.log.info('navanImport: Step 1 - Authenticating with Navan');
            let tokenResult;
            try {
                tokenResult = await fetchNavanAccessToken(context);
            } catch (tokenError) {
                context.log.error('navanImport: Error fetching Navan access token:', tokenError);
                summary.errors.push({
                    message: `Failed to fetch Navan access token: ${tokenError.message}`,
                    type: 'Token fetch error'
                });
                summary.skippedBookings = limitArray(summary.skippedBookings);
                summary.errors = limitArray(summary.errors);
                return {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    jsonBody: {
                        success: false,
                        error: 'Navan authentication exception',
                        detail: tokenError.message,
                        summary
                    }
                };
            }
            
            if (!tokenResult.success) {
                summary.errors.push({
                    message: tokenResult.response?.jsonBody?.detail || 'Failed to authenticate with Navan',
                    type: 'Authentication error'
                });
                summary.skippedBookings = limitArray(summary.skippedBookings);
                summary.errors = limitArray(summary.errors);
                return {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    jsonBody: {
                        success: false,
                        error: 'Navan authentication failed',
                        detail: tokenResult.response?.jsonBody?.detail || 'Unknown authentication error',
                        summary
                    }
                };
            }
            const accessToken = tokenResult.accessToken;
            const tokenType = tokenResult.tokenType || 'Bearer';
            
            // Verify token was received
            if (!accessToken) {
                context.log.error('navanImport: Access token is null or undefined after successful token fetch');
                summary.errors.push({
                    message: 'Access token was not returned from token fetch',
                    type: 'Token validation error'
                });
                summary.skippedBookings = limitArray(summary.skippedBookings);
                summary.errors = limitArray(summary.errors);
                return {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    jsonBody: {
                        success: false,
                        error: 'Navan token validation failed',
                        detail: 'Token fetch succeeded but no access token was returned',
                        summary
                    }
                };
            }
            
            context.log.info(`navanImport: Access token received. Token length: ${accessToken.length}, Preview: ${accessToken.substring(0, 10)}..., TokenType: ${tokenType}`);
            context.log.info(`navanImport: Token validation - Token exists: ${!!accessToken}, TokenType: ${tokenType}, Auth header will be: ${tokenType} ${accessToken.substring(0, 20)}...`);

            // 2. Load CRC list for matching
            context.log.info('navanImport: Step 2 - Loading CRCs');
            let crcList;
            try {
                crcList = await loadAllCrcs(context);
                context.log.info(`navanImport: Loaded ${crcList?.length || 0} CRC records`);
            } catch (crcError) {
                context.log.error('navanImport: Error loading CRC list:', crcError);
                summary.errors.push({
                    message: `Failed to load CRC list: ${crcError.message}`,
                    type: 'CRC load error'
                });
                // Continue with empty CRC list - bookings will be skipped
                crcList = [];
            }
            const crcResolver = buildCrcResolver(crcList);

            // 3. Fetch and Process Bookings
            context.log.info(`navanImport: Step 3 - Processing import type: ${importType}`);
            
            try {
                if (importType === 'list') {
                    if (!Array.isArray(body.bookings) || body.bookings.length === 0) {
                        return {
                        status: 400,
                        headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        },
                        jsonBody: {
                            error: 'Invalid request',
                            detail: 'Provide an array of bookings with bookingId and/or bookingUuid.'
                        }
                    };
                }

                const defaultRange = normalizeNavanDateRange(365, 180);
                const processedKeys = new Set();

                for (const entry of body.bookings) {
                    const bookingIdCandidate = entry?.bookingId ? String(entry.bookingId).trim() : null;
                    const bookingUuidCandidate = entry?.bookingUuid ? String(entry.bookingUuid).trim() : null;
                    if (!bookingIdCandidate && !bookingUuidCandidate) {
                        summary.errors.push({ message: 'Booking entry missing bookingId and bookingUuid', entry });
                        continue;
                    }

                    const dedupeKey = bookingUuidCandidate || bookingIdCandidate;
                    if (processedKeys.has(dedupeKey)) {
                        continue;
                    }
                    processedKeys.add(dedupeKey);

                    let bookingRecord = null;
                    try {
                        if (bookingUuidCandidate) {
                            const uuidResponse = await fetchNavanBookingByUuid(accessToken, bookingUuidCandidate, tokenType);
                            if (uuidResponse.ok) {
                                const uuidData = await uuidResponse.json();
                                if (Array.isArray(uuidData?.data) && uuidData.data.length > 0) {
                                    bookingRecord = uuidData.data[0];
                                }
                            } else {
                                const text = await uuidResponse.text();
                                throw new Error(`UUID lookup failed (${uuidResponse.status}): ${text}`);
                            }
                        } else {
                            const createdFrom = entry?.createdFrom ? parseInt(entry.createdFrom, 10) : defaultRange.createdFrom;
                            const createdTo = entry?.createdTo ? parseInt(entry.createdTo, 10) : defaultRange.createdTo;
                            bookingRecord = await fetchNavanBookingById(context, accessToken, bookingIdCandidate, {
                                createdFrom,
                                createdTo
                            }, tokenType);
                        }
                    } catch (lookupError) {
                        summary.errors.push({
                            bookingId: bookingIdCandidate,
                            bookingUuid: bookingUuidCandidate,
                            message: lookupError.message
                        });
                        continue;
                    }

                    if (!bookingRecord) {
                        summary.skippedBookings.push({
                            bookingId: bookingIdCandidate,
                            bookingUuid: bookingUuidCandidate,
                            reason: 'Booking not found in Navan or outside search window'
                        });
                        summary.totals.skipped += 1;
                        continue;
                    }

                    summary.totals.fetched += 1;

                    try {
                        const importResult = await upsertNavanBooking(context, bookingRecord, {
                            bookingId: bookingRecord.bookingId || bookingIdCandidate,
                            bookingUuid: bookingRecord.uuid || bookingUuidCandidate,
                            readOnly: backdoorMode, // Skip DB writes in backdoor mode
                            updateOnly: body.updateOnly === true, // Only update existing records, don't create new ones
                            crcResolver,
                            allowFallbackCrc: false
                        });
                        
                        // In backdoor mode, collect travel records for caching
                        if (backdoorMode && importResult.travelRecord) {
                            cachedTravelRecords.push(importResult.travelRecord);
                        }

                        if (importResult.skipped) {
                            summary.totals.skipped += 1;
                            summary.skippedBookings.push({
                                bookingId: bookingRecord.bookingId || bookingIdCandidate,
                                bookingUuid: bookingRecord.uuid || bookingUuidCandidate,
                                reason: importResult.reason || 'CRC match not found'
                            });
                            continue;
                        }

                        summary.totals.processed += 1;
                        if (importResult.action === 'created') {
                            summary.totals.created += 1;
                        } else if (importResult.action === 'updated') {
                            summary.totals.updated += 1;
                        }
                    } catch (saveError) {
                        const errorMsg = saveError.message;
                        summary.errors.push({
                            bookingId: bookingRecord.bookingId || bookingIdCandidate,
                            bookingUuid: bookingRecord.uuid || bookingUuidCandidate,
                            message: errorMsg
                        });
                        
                        // If database container is missing, abort immediately
                        if (errorMsg.includes('container not found') || errorMsg.includes('DATABASE_ERROR')) {
                            summary.skippedBookings = limitArray(summary.skippedBookings);
                            summary.errors = limitArray(summary.errors);
                            return {
                                status: 500,
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Access-Control-Allow-Origin': '*'
                                },
                                jsonBody: {
                                    success: false,
                                    error: 'Database Configuration Error',
                                    detail: errorMsg,
                                    summary
                                }
                            };
                        }
                    }
                }
                } else {
                    // Default: 30 days past, 60 days future (90 days total)
                    // This range should complete within the 30-second platform timeout
                    const pastDays = Number.isFinite(body.pastDays) ? Math.max(0, Number(body.pastDays)) : 30;
                    const futureDays = Number.isFinite(body.futureDays) ? Math.max(0, Number(body.futureDays)) : 60;

                    // Warn if date range is very large (could cause timeout)
                    if (pastDays > 180) {
                        context.log.warn(`navanImport: Large date range requested: ${pastDays} days back. This may cause timeout. Consider using smaller ranges.`);
                    }

                    let createdFrom = body.createdFrom ? parseInt(body.createdFrom, 10) : null;
                    let createdTo = body.createdTo ? parseInt(body.createdTo, 10) : null;

                    if (!createdFrom || !createdTo || Number.isNaN(createdFrom) || Number.isNaN(createdTo)) {
                        context.log.info(`navanImport: Calculating date range from pastDays=${pastDays}, futureDays=${futureDays}`);
                        const normalized = normalizeNavanDateRange(pastDays, futureDays);
                        createdFrom = normalized.createdFrom;
                        createdTo = normalized.createdTo;
                        context.log.info(`navanImport: Normalized dates - createdFrom=${createdFrom} (${new Date(createdFrom * 1000).toISOString()}), createdTo=${createdTo} (${new Date(createdTo * 1000).toISOString()})`);
                        summary.range = {
                            createdFrom,
                            createdTo,
                            pastDays,
                            futureDays
                        };
                    } else {
                        summary.range = {
                            createdFrom,
                            createdTo,
                            pastDays,
                            futureDays
                        };
                    }

                    summary.range = { createdFrom, createdTo, pastDays, futureDays };
                    const dateRangeDays = Math.ceil((createdTo - createdFrom) / (24 * 60 * 60));
                    context.log.info(`navanImport: Fetching range ${new Date(createdFrom * 1000).toISOString()} to ${new Date(createdTo * 1000).toISOString()} (${dateRangeDays} days)`);
                    
                    // Validate date range
                    if (createdTo <= createdFrom) {
                        context.log.error(`navanImport: Invalid date range - createdTo (${createdTo}) <= createdFrom (${createdFrom})`);
                        summary.errors.push({
                            message: `Invalid date range: end date must be after start date`,
                            type: 'Date range validation error'
                        });
                        summary.skippedBookings = limitArray(summary.skippedBookings);
                        summary.errors = limitArray(summary.errors);
                        return {
                            status: 400,
                            headers: {
                                'Content-Type': 'application/json',
                                'Access-Control-Allow-Origin': '*'
                            },
                            jsonBody: {
                                success: false,
                                error: 'Invalid date range',
                                detail: `End date (${new Date(createdTo * 1000).toISOString()}) must be after start date (${new Date(createdFrom * 1000).toISOString()})`,
                                summary
                            }
                        };
                    }

                    let bookings = [];
                    try {
                        // For very large date ranges (365+ days), warn user and limit pages
                        const dateRangeDays = Math.ceil((createdTo - createdFrom) / (24 * 60 * 60));
                        const isVeryLargeRange = dateRangeDays > 180;
                        const isExtremelyLargeRange = dateRangeDays > 300;
                        
                        if (isExtremelyLargeRange) {
                            context.log.warn(`navanImport: Very large date range detected (${dateRangeDays} days). This may timeout. Consider using smaller ranges.`);
                            summary.errors.push({
                                message: `Large date range (${dateRangeDays} days) may cause timeout. Consider splitting into smaller ranges.`,
                                type: 'Warning'
                            });
                        }
                        
                        // For large date ranges, use smaller page size and fewer pages to prevent timeout
                        const pageSize = isVeryLargeRange ? 25 : 50;  // Smaller page size for large ranges
                        const maxPages = isExtremelyLargeRange ? 30 : (isVeryLargeRange ? 50 : 100);  // Fewer pages for very large ranges
                        
                        context.log.info(`navanImport: Fetching bookings with pageSize=${pageSize}, maxPages=${maxPages} (dateRange=${dateRangeDays} days)`);
                        
                        // Add timeout protection for the fetch operation itself
                        const fetchStartTime = Date.now();
                        const FETCH_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes max for fetching
                        
                        const fetchPromise = fetchNavanBookingsInRange(context, accessToken, { 
                            createdFrom, 
                            createdTo,
                            pageSize: pageSize,
                            maxPages: maxPages
                        }, tokenType);
                        
                        const timeoutPromise = new Promise((_, reject) => {
                            setTimeout(() => reject(new Error(`Navan fetch timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`)), FETCH_TIMEOUT_MS);
                        });
                        
                        bookings = await Promise.race([fetchPromise, timeoutPromise]);
                        const fetchDuration = ((Date.now() - fetchStartTime) / 1000).toFixed(2);
                        context.log.info(`navanImport: Fetched ${bookings?.length || 0} bookings in ${fetchDuration} seconds`);
                        
                        // Log detailed info if no bookings found
                        if (!bookings || bookings.length === 0) {
                            context.log.warn(`navanImport: No bookings found for date range ${new Date(createdFrom * 1000).toISOString()} to ${new Date(createdTo * 1000).toISOString()}`);
                            context.log.warn(`navanImport: Date range details - createdFrom=${createdFrom}, createdTo=${createdTo}, range=${dateRangeDays} days`);
                            context.log.warn(`navanImport: Token was used - TokenType: ${tokenType}, Token length: ${accessToken.length}`);
                        }
                    } catch (fetchError) {
                        context.log.error('navanImport: Fetch error:', fetchError);
                        const errorMessage = fetchError.message || 'Unknown fetch error';
                        summary.errors.push({
                            message: `Failed to fetch bookings from Navan: ${errorMessage}`,
                            type: 'Fetch error'
                        });
                        summary.skippedBookings = limitArray(summary.skippedBookings);
                        summary.errors = limitArray(summary.errors);
                        return {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/json',
                                'Access-Control-Allow-Origin': '*'
                            },
                            jsonBody: {
                                success: false,
                                error: 'Failed to fetch bookings from Navan',
                                detail: errorMessage,
                                summary
                            }
                        };
                    }
                    summary.totals.fetched = bookings?.length || 0;

                    // Process in smaller batches to prevent timeout - use 20 per batch
                    const BATCH_SIZE = 20;
                    const totalBookings = bookings.length;
                    context.log.info(`navanImport: Processing ${totalBookings} bookings in batches of ${BATCH_SIZE}`);
                    
                    // Log start time to track duration
                    const startTime = Date.now();
                    // Azure Functions timeout is typically 5-10 minutes, but we'll set a safety limit
                    // For very large imports, use shorter timeout to ensure we can return results
                    const processingDateRangeDays = Math.ceil((createdTo - createdFrom) / (24 * 60 * 60));
                    const MAX_EXECUTION_TIME_MS = processingDateRangeDays > 300 ? 2 * 60 * 1000 : 4 * 60 * 1000; // 2 minutes for very large, 4 minutes otherwise

                    const processedKeys = new Set();
                    let processedCount = 0;
                    let batchNumber = 0;
                    let offset = 0;
                    
                    // Process bookings in batches
                    while (offset < totalBookings) {
                        // Check if we're running out of time - check more frequently for large imports
                        const elapsed = Date.now() - startTime;
                        const timeRemaining = MAX_EXECUTION_TIME_MS - elapsed;
                        const timeRemainingSeconds = (timeRemaining / 1000).toFixed(0);
                        
                        // Stop early if we're running low on time (leave 30 seconds buffer for response)
                        if (timeRemaining < 30000) {
                            context.log.warn(`navanImport: Approaching timeout limit (${timeRemainingSeconds}s remaining). Processed ${processedCount}/${totalBookings} bookings in ${(elapsed / 1000).toFixed(2)} seconds. Stopping to return partial results.`);
                            summary.errors.push({
                                message: `Processing stopped due to timeout limit. Processed ${processedCount} of ${totalBookings} bookings in ${(elapsed / 1000).toFixed(0)} seconds. Remaining bookings will be processed on next sync.`,
                                type: 'Timeout warning',
                                processed: processedCount,
                                total: totalBookings,
                                elapsedSeconds: (elapsed / 1000).toFixed(0)
                            });
                            break;
                        }
                        
                        // Log time remaining every 10 batches for large imports
                        if (batchNumber % 10 === 0 && processingDateRangeDays > 180) {
                            context.log.info(`navanImport: Progress check - ${processedCount}/${totalBookings} bookings processed, ${timeRemainingSeconds}s remaining`);
                        }
                        
                        batchNumber++;
                        const batchEnd = Math.min(offset + BATCH_SIZE, totalBookings);
                        const batch = bookings.slice(offset, batchEnd);
                        const batchSize = batch.length;
                        
                        context.log.info(`navanImport: Processing batch ${batchNumber} (bookings ${offset + 1}-${batchEnd} of ${totalBookings})`);
                        
                        for (const booking of batch) {
                            const key = booking.uuid || booking.bookingId;
                            if (!key || processedKeys.has(key)) {
                                continue;
                            }
                            processedKeys.add(key);
                            processedCount++;
                            
                            // Log progress every 50 bookings
                            if (processedCount % 50 === 0) {
                                context.log.info(`navanImport: Processed ${processedCount}/${totalBookings} bookings...`);
                            }

                            try {
                                const importResult = await upsertNavanBooking(context, booking, {
                                    bookingId: booking.bookingId,
                                    bookingUuid: booking.uuid,
                                    readOnly: backdoorMode, // Skip DB writes in backdoor mode
                                    updateOnly: body.updateOnly === true, // Only update existing records, don't create new ones
                                    crcResolver,
                                    allowFallbackCrc: false
                                });
                                
                                // In backdoor mode, collect travel records for caching
                                if (backdoorMode && importResult.travelRecord) {
                                    cachedTravelRecords.push(importResult.travelRecord);
                                }

                                if (importResult.skipped) {
                                    summary.totals.skipped += 1;
                                    summary.skippedBookings.push({
                                        bookingId: booking.bookingId,
                                        bookingUuid: booking.uuid,
                                        travelerName: booking?.passengers?.[0]?.person?.name || null,
                                        reason: importResult.reason || 'CRC match not found'
                                    });
                                    continue;
                                }

                                summary.totals.processed += 1;
                                if (importResult.action === 'created') {
                                    summary.totals.created += 1;
                                } else if (importResult.action === 'updated') {
                                    summary.totals.updated += 1;
                                } else if (importResult.action === 'skipped') {
                                    summary.totals.skipped += 1;
                                    summary.skippedBookings.push({
                                        bookingId: booking.bookingId,
                                        bookingUuid: booking.uuid,
                                        travelerName: booking?.passengers?.[0]?.person?.name || null,
                                        reason: importResult.reason || 'Skipped in update-only mode'
                                    });
                                }
                            } catch (saveError) {
                                const errorMsg = saveError.message;
                                summary.errors.push({
                                    bookingId: booking.bookingId,
                                    bookingUuid: booking.uuid,
                                    message: errorMsg
                                });
                                
                                // Critical DB error - abort all processing
                                if (errorMsg.includes('container not found') || errorMsg.includes('DATABASE_ERROR')) {
                                    summary.skippedBookings = limitArray(summary.skippedBookings);
                                    summary.errors = limitArray(summary.errors);
                                    return {
                                        status: 500,
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'Access-Control-Allow-Origin': '*'
                                        },
                                        jsonBody: {
                                            success: false,
                                            error: 'Database Configuration Error',
                                            detail: errorMsg,
                                            summary
                                        }
                                    };
                                }
                                // For non-critical errors, continue processing the batch
                                // Don't let one bad booking stop the entire import
                                context.log.warn(`navanImport: Failed to save booking ${booking.bookingId || booking.uuid}: ${errorMsg}. Continuing...`);
                            }
                        }
                        
                        // Batch completed successfully, move to next batch
                        offset = batchEnd;
                        context.log.info(`navanImport: Batch ${batchNumber} completed. Processed ${processedCount}/${totalBookings} bookings so far.`);
                        
                        // Small delay between batches to avoid overwhelming the system
                        if (offset < totalBookings) {
                            await new Promise(resolve => setTimeout(resolve, 200));
                        }
                        
                        // Log progress every 5 batches to track long-running operations
                        if (batchNumber % 5 === 0) {
                            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                            context.log.info(`navanImport: Progress - ${batchNumber} batches completed, ${processedCount}/${totalBookings} bookings processed in ${elapsed} seconds`);
                        }
                    }
                    
                    const endTime = Date.now();
                    const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
                    context.log.info(`navanImport: All batches completed. Total processed: ${processedCount}/${totalBookings} bookings in ${durationSeconds} seconds.`);
                }
            } catch (importError) {
                context.log.error('navanImport: Import error:', importError);
                context.log.error('navanImport: Import error stack:', importError.stack);
                context.log.error('navanImport: Import error name:', importError.name);
                
                // Build detailed error message
                let errorDetail = importError.message || 'Unknown error';
                if (importError.name) {
                    errorDetail = `${importError.name}: ${errorDetail}`;
                }
                
                // Check for common error patterns
                if (errorDetail.includes('timeout') || errorDetail.includes('ETIMEDOUT')) {
                    errorDetail = 'Request timed out. The Navan API may be slow or the date range is too large. Try a smaller range.';
                } else if (errorDetail.includes('ECONNREFUSED') || errorDetail.includes('ENOTFOUND')) {
                    errorDetail = 'Cannot connect to Navan API. Check network connectivity and API endpoint configuration.';
                } else if (errorDetail.includes('401') || errorDetail.includes('Unauthorized')) {
                    errorDetail = 'Navan API authentication failed. Check API credentials.';
                } else if (errorDetail.includes('Unexpected token') || errorDetail.includes('JSON')) {
                    errorDetail = 'Invalid response from Navan API. The API may have returned unexpected data.';
                }
                
                summary.errors.push({
                    message: errorDetail,
                    type: 'Fatal error',
                    errorName: importError.name,
                    originalMessage: importError.message
                });
                summary.skippedBookings = limitArray(summary.skippedBookings);
                summary.errors = limitArray(summary.errors);
                return {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    jsonBody: {
                        success: summary.totals.processed > 0 || summary.totals.created > 0 || summary.totals.updated > 0,
                        error: 'Navan import encountered an error',
                        detail: errorDetail,
                        errorName: importError.name,
                        errorMessage: importError.message,
                        summary
                    }
                };
            }

            // Clean up summary for response
            summary.skippedBookings = limitArray(summary.skippedBookings);
            summary.errors = limitArray(summary.errors);
            
            // In backdoor mode, include cached travel records in response
            const responseBody = {
                success: true,
                summary,
                backdoorMode: backdoorMode
            };
            
            if (backdoorMode && cachedTravelRecords.length > 0) {
                responseBody.cachedTravelRecords = cachedTravelRecords;
                context.log.info(`navanImport: Backdoor mode - returning ${cachedTravelRecords.length} cached travel records (not saved to DB)`);
            }

            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                jsonBody: responseBody
            };
        } catch (outerError) {
            // Catch-all for unexpected runtime errors
            try {
                ensureContextLogger(context);
                context.log.error('navanImport CRITICAL error:', outerError);
                context.log.error('navanImport CRITICAL error stack:', outerError.stack);
                context.log.error('navanImport CRITICAL error name:', outerError.name);
                if (outerError.cause) {
                    context.log.error('navanImport CRITICAL error cause:', outerError.cause);
                }
            } catch (e) {
                console.error('navanImport CRITICAL error (logging failed):', e);
            }
            
            // Ensure summary exists even if initialization failed
            const safeSummary = summary || {
                importType: 'range',
                totals: { fetched: 0, processed: 0, created: 0, updated: 0, skipped: 0 },
                skippedBookings: [],
                errors: []
            };
            
            // Build detailed error message for user
            let errorDetail = outerError.message || 'Unknown system error';
            if (outerError.name) {
                errorDetail = `${outerError.name}: ${errorDetail}`;
            }
            if (outerError.cause) {
                errorDetail += ` (Cause: ${outerError.cause.message || outerError.cause})`;
            }
            
            // Check for common error patterns
            if (errorDetail.includes('timeout') || errorDetail.includes('ETIMEDOUT')) {
                errorDetail = 'Request timed out. The Navan API may be slow or the date range is too large. Try a smaller range.';
            } else if (errorDetail.includes('ECONNREFUSED') || errorDetail.includes('ENOTFOUND')) {
                errorDetail = 'Cannot connect to Navan API. Check network connectivity and API endpoint configuration.';
            } else if (errorDetail.includes('Unexpected token') || errorDetail.includes('JSON')) {
                errorDetail = 'Invalid response from Navan API. The API may have returned unexpected data.';
            }
            
            if (safeSummary.errors) {
                safeSummary.errors.push({
                    message: errorDetail,
                    type: 'Critical Handler Failure',
                    errorName: outerError.name,
                    errorMessage: outerError.message
                });
            }
            
            safeSummary.skippedBookings = limitArray(safeSummary.skippedBookings);
            safeSummary.errors = limitArray(safeSummary.errors);
            
            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                jsonBody: {
                    success: false,
                    error: 'Navan import encountered a critical error',
                    detail: errorDetail,
                    errorName: outerError.name,
                    errorMessage: outerError.message,
                    summary: safeSummary
                }
            };
        }
    }
});

// =================================================================================
// AUTOMATIC NAVAN IMPORT (Timer Trigger)
// =================================================================================
// This timer automatically syncs Navan bookings on a schedule
// Runs every 6 hours (at :00 minutes past the hour)
// You can adjust the schedule by changing the CRON expression:
// - "0 */6 * * *" = every 6 hours
// - "0 0 * * *" = daily at midnight
// - "0 */12 * * *" = every 12 hours
// - "0 0 */1 * *" = daily at midnight
app.timer('navanAutoImport', {
    // Run daily at 7 AM EST (12:00 UTC)
    // Note: During daylight saving time (EDT), this will run at 8 AM EDT (12:00 UTC)
    // To run at exactly 7 AM EDT, use '0 11 * * *' (11:00 UTC), but that would be 6 AM EST
    schedule: '0 12 * * *', // Daily at 12:00 UTC (7 AM EST / 8 AM EDT)
    handler: async (myTimer, context) => {
        ensureContextLogger(context);
        context.log.info('navanAutoImport: Timer triggered - Starting automatic Navan import (daily at 7 AM EST)');
        
        const limitArray = (arr, limit = 50) => (arr.length > limit ? arr.slice(0, limit) : arr);
        
        let summary = {
            importType: 'range',
            totals: {
                fetched: 0,
                processed: 0,
                created: 0,
                updated: 0,
                skipped: 0
            },
            skippedBookings: [],
            errors: []
        };
        
        try {
            // Use date range: 30 days past, 30 days future (as requested)
            const pastDays = 30;
            const futureDays = 30;
            
            context.log.info(`navanAutoImport: Using default date range - pastDays=${pastDays}, futureDays=${futureDays}`);
            
            // 1. Authenticate with Navan
            context.log.info('navanAutoImport: Step 1 - Authenticating with Navan');
            let tokenResult;
            try {
                tokenResult = await fetchNavanAccessToken(context);
            } catch (tokenError) {
                context.log.error('navanAutoImport: Error fetching Navan access token:', tokenError);
                summary.errors.push({
                    message: `Failed to fetch Navan access token: ${tokenError.message}`,
                    type: 'Token fetch error'
                });
                context.log.error('navanAutoImport: Automatic import failed - authentication error');
                return;
            }
            
            if (!tokenResult.success || !tokenResult.accessToken) {
                context.log.error('navanAutoImport: Authentication failed or no token received');
                summary.errors.push({
                    message: tokenResult.response?.jsonBody?.detail || 'Failed to authenticate with Navan',
                    type: 'Authentication error'
                });
                context.log.error('navanAutoImport: Automatic import failed - authentication failed');
                return;
            }
            
            const accessToken = tokenResult.accessToken;
            const tokenType = tokenResult.tokenType || 'Bearer';
            context.log.info(`navanAutoImport: Access token received. Token length: ${accessToken.length}`);
            
            // 2. Load CRC list for matching
            context.log.info('navanAutoImport: Step 2 - Loading CRCs');
            let crcList;
            try {
                crcList = await loadAllCrcs(context);
                context.log.info(`navanAutoImport: Loaded ${crcList?.length || 0} CRC records`);
            } catch (crcError) {
                context.log.error('navanAutoImport: Error loading CRC list:', crcError);
                summary.errors.push({
                    message: `Failed to load CRC list: ${crcError.message}`,
                    type: 'CRC load error'
                });
                crcList = [];
            }
            const crcResolver = buildCrcResolver(crcList);
            
            // 3. Calculate date range
            const normalized = normalizeNavanDateRange(pastDays, futureDays);
            const createdFrom = normalized.createdFrom;
            const createdTo = normalized.createdTo;
            summary.range = { createdFrom, createdTo, pastDays, futureDays };
            
            const dateRangeDays = Math.ceil((createdTo - createdFrom) / (24 * 60 * 60));
            context.log.info(`navanAutoImport: Fetching range ${new Date(createdFrom * 1000).toISOString()} to ${new Date(createdTo * 1000).toISOString()} (${dateRangeDays} days)`);
            
            // 4. Fetch bookings
            let bookings = [];
            try {
                const pageSize = 50;
                const maxPages = 100;
                
                context.log.info(`navanAutoImport: Fetching bookings with pageSize=${pageSize}, maxPages=${maxPages}`);
                
                bookings = await fetchNavanBookingsInRange(context, accessToken, { 
                    createdFrom, 
                    createdTo,
                    pageSize: pageSize,
                    maxPages: maxPages
                }, tokenType);
                
                context.log.info(`navanAutoImport: Fetched ${bookings?.length || 0} bookings`);
            } catch (fetchError) {
                context.log.error('navanAutoImport: Fetch error:', fetchError);
                summary.errors.push({
                    message: `Failed to fetch bookings from Navan: ${fetchError.message}`,
                    type: 'Fetch error'
                });
                context.log.error('navanAutoImport: Automatic import failed - fetch error');
                return;
            }
            
            summary.totals.fetched = bookings?.length || 0;
            
            // 5. Process bookings in batches
            const BATCH_SIZE = 20;
            const totalBookings = bookings.length;
            context.log.info(`navanAutoImport: Processing ${totalBookings} bookings in batches of ${BATCH_SIZE}`);
            
            const startTime = Date.now();
            const MAX_EXECUTION_TIME_MS = 8 * 60 * 1000; // 8 minutes max for timer (Azure Functions timers can run longer)
            
            const processedKeys = new Set();
            let processedCount = 0;
            let batchNumber = 0;
            let offset = 0;
            
            while (offset < totalBookings) {
                const elapsed = Date.now() - startTime;
                const timeRemaining = MAX_EXECUTION_TIME_MS - elapsed;
                
                // Stop early if we're running low on time
                if (timeRemaining < 30000) {
                    context.log.warn(`navanAutoImport: Approaching timeout limit. Processed ${processedCount}/${totalBookings} bookings. Stopping to return partial results.`);
                    summary.errors.push({
                        message: `Processing stopped due to timeout limit. Processed ${processedCount} of ${totalBookings} bookings. Remaining bookings will be processed on next sync.`,
                        type: 'Timeout warning',
                        processed: processedCount,
                        total: totalBookings
                    });
                    break;
                }
                
                batchNumber++;
                const batchEnd = Math.min(offset + BATCH_SIZE, totalBookings);
                const batch = bookings.slice(offset, batchEnd);
                
                context.log.info(`navanAutoImport: Processing batch ${batchNumber} (bookings ${offset + 1}-${batchEnd} of ${totalBookings})`);
                
                for (const booking of batch) {
                    const key = booking.uuid || booking.bookingId;
                    if (!key || processedKeys.has(key)) {
                        continue;
                    }
                    processedKeys.add(key);
                    processedCount++;
                    
                    if (processedCount % 50 === 0) {
                        context.log.info(`navanAutoImport: Processed ${processedCount}/${totalBookings} bookings...`);
                    }
                    
                    try {
                        const importResult = await upsertNavanBooking(context, booking, {
                            bookingId: booking.bookingId,
                            bookingUuid: booking.uuid,
                            readOnly: false,
                            crcResolver,
                            allowFallbackCrc: false
                        });
                        
                        if (importResult.skipped) {
                            summary.totals.skipped += 1;
                            summary.skippedBookings.push({
                                bookingId: booking.bookingId,
                                bookingUuid: booking.uuid,
                                travelerName: booking?.passengers?.[0]?.person?.name || null,
                                reason: importResult.reason || 'CRC match not found'
                            });
                            continue;
                        }
                        
                        summary.totals.processed += 1;
                        if (importResult.action === 'created') {
                            summary.totals.created += 1;
                        } else if (importResult.action === 'updated') {
                            summary.totals.updated += 1;
                        }
                    } catch (saveError) {
                        const errorMsg = saveError.message;
                        summary.errors.push({
                            bookingId: booking.bookingId,
                            bookingUuid: booking.uuid,
                            message: errorMsg
                        });
                        
                        if (errorMsg.includes('container not found') || errorMsg.includes('DATABASE_ERROR')) {
                            context.log.error('navanAutoImport: Critical database error - aborting');
                            return;
                        }
                        
                        context.log.warn(`navanAutoImport: Failed to save booking ${booking.bookingId || booking.uuid}: ${errorMsg}. Continuing...`);
                    }
                }
                
                offset = batchEnd;
                context.log.info(`navanAutoImport: Batch ${batchNumber} completed. Processed ${processedCount}/${totalBookings} bookings so far.`);
                
                if (offset < totalBookings) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }
            
            const endTime = Date.now();
            const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
            context.log.info(`navanAutoImport: Automatic import completed. Total processed: ${processedCount}/${totalBookings} bookings in ${durationSeconds} seconds.`);
            context.log.info(`navanAutoImport: Summary - Created: ${summary.totals.created}, Updated: ${summary.totals.updated}, Skipped: ${summary.totals.skipped}, Errors: ${summary.errors.length}`);
            
            // Clean up summary
            summary.skippedBookings = limitArray(summary.skippedBookings);
            summary.errors = limitArray(summary.errors);
            
        } catch (error) {
            context.log.error('navanAutoImport: Critical error:', error);
            context.log.error('navanAutoImport: Error stack:', error.stack);
            summary.errors.push({
                message: error.message || 'Unknown error',
                type: 'Critical error',
                errorName: error.name
            });
        }
        
        context.log.info('navanAutoImport: Timer execution completed');
    }
});