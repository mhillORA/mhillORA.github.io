const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const crypto = require('crypto');

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function generateConsentToken() {
    return crypto.randomBytes(24).toString('hex');
}

// NASA / recruitment logins are isolated from CHAOS (`users` container on chaos-scheduler deploy).
const RECRUITMENT_USERS_CONTAINER = 'recruitment-users';

const requireUser = async () => ({ claims: null });

const corsJsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

const PATIENT_SUBROUTES = new Set(['query', 'today', 'actions', 'reindex']);

const isCosmosNotFound = (error) => {
    if (!error) return false;
    const code = error.code ?? error.statusCode;
    if (code === 404) return true;
    const msg = String(error.message || '').toLowerCase();
    return msg.includes('notfound') || msg.includes('not found') || msg.includes('could not be found');
};

const safeReadAll = async (container) => {
    try {
        const { resources } = await container.items.readAll().fetchAll();
        return resources || [];
    } catch (error) {
        if (isCosmosNotFound(error)) return [];
        throw error;
    }
};

const safeQueryAll = async (container, querySpec) => {
    try {
        const { resources } = await container.items.query(querySpec).fetchAll();
        return resources || [];
    } catch (error) {
        if (isCosmosNotFound(error)) return [];
        throw error;
    }
};

const safeItemRead = async (container, id) => {
    try {
        const { resource } = await container.item(id).read();
        return resource || null;
    } catch (error) {
        if (isCosmosNotFound(error)) return null;
        throw error;
    }
};

const findPatientRecord = async (container, id) => {
    if (!id) return null;
    const direct = await safeItemRead(container, id);
    if (direct) return direct;
    const matches = await safeQueryAll(container, {
        query: 'SELECT * FROM c WHERE c.id = @id OR c.globalId = @id',
        parameters: [{ name: '@id', value: String(id) }],
    });
    return matches[0] || null;
};

const wrapCosmosWrite = async (operation, containerName) => {
    try {
        return await operation();
    } catch (error) {
        if (isCosmosNotFound(error)) {
            const err = new Error(`VALIDATION_ERROR: Cosmos container "${containerName}" does not exist. Create it in Azure Portal with partition key /id.`);
            err.status = 503;
            throw err;
        }
        throw error;
    }
};

const buildActor = (actor) => ({
    upn: actor && (actor.upn || actor.email || actor.username),
    name: actor && (actor.name || actor.displayName || actor.username),
});

const safeJson = async (request) => {
    try { return await request.json(); } catch { return null; }
};

const writeAudit = async ({ action, containerName, method, targetId, actor, before, after }) => {
    try {
        const audits = getContainer('audits');
        const record = {
            id: generateId(),
            ts: new Date().toISOString(),
            action,
            method,
            containerName,
            targetId: targetId || null,
            actor: actor || null,
            before: before || null,
            after: after || null,
        };
        await audits.items.create(record);
    } catch (e) {
        console.warn('Audit write failed:', e && e.message ? e.message : e);
    }
};

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

const getContainer = (containerName) => {
    const { database } = getCosmosClient();
    return database.container(containerName);
};

const handleError = (context, error, message) => {
    context.log.error(`${message}:`, error.message);
    context.log.error(`Stack:`, error.stack);

    const cosmosCode = error.code ?? error.statusCode ?? error.status;
    const msg = String(error.message || '');
    let errorMessage;
    if (msg.includes('COSMOS_DB_CONFIG_MISSING')) {
        errorMessage = "API Configuration Error: Database secrets not set in Azure Configuration.";
    } else if (msg.includes('VALIDATION_ERROR')) {
        errorMessage = msg.replace('VALIDATION_ERROR: ', '');
    } else if (msg.includes('UNAUTHORIZED')) {
        errorMessage = msg.replace('UNAUTHORIZED: ', '');
    } else if (error.status === 503 || msg.includes('does not exist')) {
        errorMessage = msg.replace('VALIDATION_ERROR: ', '');
    } else if (cosmosCode === 400 || msg.toLowerCase().includes('partition')) {
        errorMessage = `Cosmos rejected the write/read (${cosmosCode || 400}): ${msg || 'bad request'}. Confirm container "consent-links" uses partition key /id.`;
    } else {
        errorMessage = "Internal Server Error during data processing.";
    }

    return {
        status: error.status || (typeof cosmosCode === 'number' ? cosmosCode : 500),
        jsonBody: { error: errorMessage },
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    };
};

const getIdFromRequest = (request) => {
    return request.params.id;
};

const STUDY_STATUS_ALLOWED = new Set([
    // NASA / clinical recruitment statuses
    'recruiting', 'enrolling', 'active', 'completed', 'suspended', 'closed', 'archived',
    // Legacy Artemis / chaos scheduler statuses
    'inactive',
]);

const isAllowedStudyStatus = (status) => STUDY_STATUS_ALLOWED.has(String(status || '').trim().toLowerCase());

const validateStudiesSchema = (data) => {
    const errors = [];

    // Prefer NASA/clinical validation when clinical fields exist. Many Artemis imports also carry
    // name/color/sites — the old chaos-only status list rejected Archive / Recruiting (400).
    const hasNasaClinicalShape = !!(
        data.title
        || data.protocolNumber
        || Array.isArray(data.siteIds)
        || data.washoutDays != null
        || data.archived === true
        || (data.status && ['recruiting', 'enrolling', 'closed', 'archived'].includes(String(data.status).toLowerCase()))
    );
    const isChaosFormat = !hasNasaClinicalShape
        && data.name
        && data.color
        && (data.requiredRoles || data.sites);

    const isTimeString = (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
    const normalizeVisitProfiles = (visitProfiles) => {
        if (visitProfiles === undefined || visitProfiles === null) return;
        if (!Array.isArray(visitProfiles)) {
            errors.push('visitProfiles must be an array');
            return;
        }
        visitProfiles.forEach((p, idx) => {
            if (!p || typeof p !== 'object' || Array.isArray(p)) {
                errors.push(`visitProfiles[${idx}] must be an object`);
                return;
            }
            if (!p.visitName || typeof p.visitName !== 'string') {
                errors.push(`visitProfiles[${idx}].visitName is required and must be a string`);
            }

            if (p.defaultStartTime === undefined) p.defaultStartTime = '08:00';
            if (p.defaultEndTime === undefined) p.defaultEndTime = '16:00';
            if (p.patientsPerHour === undefined) p.patientsPerHour = 2;

            if (!isTimeString(p.defaultStartTime)) {
                errors.push(`visitProfiles[${idx}].defaultStartTime must be in HH:MM format`);
            }
            if (!isTimeString(p.defaultEndTime)) {
                errors.push(`visitProfiles[${idx}].defaultEndTime must be in HH:MM format`);
            }
            if (typeof p.patientsPerHour !== 'number' || !Number.isFinite(p.patientsPerHour) || p.patientsPerHour <= 0) {
                errors.push(`visitProfiles[${idx}].patientsPerHour must be a positive number`);
            }
        });
    };

    if (data.status && !isAllowedStudyStatus(data.status)) {
        errors.push('status must be one of: Recruiting, Enrolling, Active, Completed, Suspended, Closed, Archived (or legacy active/inactive/completed/suspended)');
    }

    if (isChaosFormat) {
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
        
        if (data.phase && typeof data.phase !== 'string') {
            errors.push('phase must be a string');
        }
        
        if (data.lastUpdated && typeof data.lastUpdated !== 'string') {
            errors.push('lastUpdated must be a string');
        }

        normalizeVisitProfiles(data.visitProfiles);
    } else {
        // Accept Artemis name as title fallback so archive/status updates still validate
        if ((!data.title || typeof data.title !== 'string') && !(data.name && typeof data.name === 'string')) {
            errors.push('title is required and must be a string');
        } else if (data.title && typeof data.title !== 'string') {
            errors.push('title must be a string');
        }
        
        if (data.protocolNumber && typeof data.protocolNumber !== 'string') {
            errors.push('protocolNumber must be a string');
        }
        
        if (data.target !== undefined && (typeof data.target !== 'number' || data.target < 0)) {
            errors.push('target must be a non-negative number');
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

        normalizeVisitProfiles(data.visitProfiles);
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Studies validation failed: ${errors.join(', ')}`);
    }
    return true;
};

const validateSitesSchema = (data) => {
    const errors = [];

    const isTimeString = (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
    const normalizeSchedulingOverrides = (overrides) => {
        if (overrides === undefined || overrides === null) return;
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
            errors.push('schedulingOverrides must be an object');
            return;
        }
        Object.keys(overrides).forEach((visitName) => {
            const o = overrides[visitName];
            if (!o || typeof o !== 'object' || Array.isArray(o)) {
                errors.push(`schedulingOverrides.${visitName} must be an object`);
                return;
            }

            if (o.startTime === undefined && o.defaultStartTime !== undefined) o.startTime = o.defaultStartTime;
            if (o.endTime === undefined && o.defaultEndTime !== undefined) o.endTime = o.defaultEndTime;

            if (o.startTime !== undefined && !isTimeString(o.startTime)) {
                errors.push(`schedulingOverrides.${visitName}.startTime must be in HH:MM format`);
            }
            if (o.endTime !== undefined && !isTimeString(o.endTime)) {
                errors.push(`schedulingOverrides.${visitName}.endTime must be in HH:MM format`);
            }
            if (o.patientsPerHour !== undefined && (typeof o.patientsPerHour !== 'number' || !Number.isFinite(o.patientsPerHour) || o.patientsPerHour <= 0)) {
                errors.push(`schedulingOverrides.${visitName}.patientsPerHour must be a positive number`);
            }
        });
    };
    
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

    normalizeSchedulingOverrides(data.schedulingOverrides);
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Sites validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const isPatientQueryBody = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (body.action !== undefined || body.patientId !== undefined) return false;
    if (body.firstName !== undefined || body.lastName !== undefined) return false;
    return body.criteria !== undefined || body.search !== undefined || body.includeTotal !== undefined;
};

const normalizePatientInput = (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    if (isPatientQueryBody(data)) return data;
    const normalized = { ...data };

    const fullName = normalized.fullName || normalized.name || normalized.patientName || normalized.subjectName;
    let first = normalized.firstName != null ? String(normalized.firstName).trim().replace(/\s+/g, ' ') : '';
    let last = normalized.lastName != null ? String(normalized.lastName).trim().replace(/\s+/g, ' ') : '';
    const full = fullName != null ? String(fullName).trim().replace(/\s+/g, ' ') : '';

    const splitFull = (raw) => {
        const s = String(raw || '').trim().replace(/\s+/g, ' ');
        if (!s) return { firstName: '', lastName: '' };
        if (s.includes(',')) {
            const [ln, rest] = s.split(',').map((p) => p.trim()).filter(Boolean);
            const fn = (rest || '').trim();
            return { firstName: fn || ln, lastName: fn ? ln : '' };
        }
        const parts = s.split(/\s+/).filter(Boolean);
        if (parts.length === 1) return { firstName: parts[0], lastName: '' };
        if (parts.length === 2) return { firstName: parts[0], lastName: parts[1] };
        return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
    };
    const looksFull = (v) => {
        const s = String(v || '').trim();
        return !!(s && (s.includes(',') || s.split(/\s+/).filter(Boolean).length >= 2));
    };

    if (full && looksFull(full)) {
        const same = (v) => v && v.toLowerCase() === full.toLowerCase();
        if (!first || !last || same(first) || same(last) || first.toLowerCase() === last.toLowerCase()) {
            const split = splitFull(full);
            first = split.firstName || first;
            last = split.lastName || last;
        }
    }
    if (looksFull(first) && (!last || first.toLowerCase() === last.toLowerCase())) {
        const split = splitFull(first);
        first = split.firstName;
        last = split.lastName || last;
    }
    if (looksFull(last) && (
        !first
        || first.toLowerCase() === last.toLowerCase()
        || last.toLowerCase().startsWith(`${first.toLowerCase()} `)
    )) {
        const split = splitFull(last);
        first = split.firstName || first;
        last = split.lastName;
    }
    if ((!first || !last) && full) {
        const split = splitFull(full);
        first = first || split.firstName;
        last = last || split.lastName;
    }
    if (!first && last) {
        if (looksFull(last)) {
            const split = splitFull(last);
            first = split.firstName;
            last = split.lastName || 'Unknown';
        } else {
            first = last;
            last = 'Unknown';
        }
    }
    if (!last && first) {
        if (looksFull(first)) {
            const split = splitFull(first);
            first = split.firstName;
            last = split.lastName || 'Unknown';
        } else {
            last = 'Unknown';
        }
    }
    if (!first) first = 'Unknown';
    if (!last) last = 'Unknown';
    normalized.firstName = first;
    normalized.lastName = last;

    const requiredStrings = ['firstName', 'lastName'];
    const optionalStrings = [
        'globalId', 'phoneNumber', 'email', 'dob', 'address', 'city', 'state', 'zipCode',
        'condition', 'source', 'therapeuticArea', 'studyId', 'siteId', 'pipelineStage',
        'eligibilityStatus', 'homeSiteId', 'claimedByUserId', 'primaryAppointmentDate',
        'registryStatus', 'initials', 'screeningNumber', 'group', 'inClinicStatus',
        'visitOutcome', 'nextVisitDate', 'sfReason', 'pcp', 'comments', 'assignedToUserId',
    ];
    requiredStrings.forEach((field) => {
        if (normalized[field] == null) normalized[field] = '';
        else normalized[field] = String(normalized[field]).trim();
    });
    optionalStrings.forEach((field) => {
        if (normalized[field] == null) return;
        normalized[field] = String(normalized[field]).trim();
    });
    return normalized;
};

const validatePatientsSchema = (data) => {
    if (isPatientQueryBody(data)) return true;
    const errors = [];
    const patient = normalizePatientInput(data);

    if (!patient.firstName) {
        errors.push('firstName is required and must be a string');
    } else if (typeof patient.firstName !== 'string') {
        errors.push('firstName is required and must be a string');
    }

    if (!patient.lastName) {
        errors.push('lastName is required and must be a string');
    } else if (typeof patient.lastName !== 'string') {
        errors.push('lastName is required and must be a string');
    }
    
    if (patient.globalId && typeof patient.globalId !== 'string') {
        errors.push('globalId must be a string');
    }

    if (patient.phoneNumber && typeof patient.phoneNumber !== 'string') {
        errors.push('phoneNumber must be a string');
    }

    if (patient.email && typeof patient.email !== 'string') {
        errors.push('email must be a string');
    }

    if (patient.dob && typeof patient.dob !== 'string') {
        errors.push('dob must be a string');
    }

    if (patient.address && typeof patient.address !== 'string') {
        errors.push('address must be a string');
    }

    if (patient.city && typeof patient.city !== 'string') {
        errors.push('city must be a string');
    }

    if (patient.state && typeof patient.state !== 'string') {
        errors.push('state must be a string');
    }

    if (patient.zipCode && typeof patient.zipCode !== 'string') {
        errors.push('zipCode must be a string');
    }

    if (patient.age !== undefined && patient.age !== null && (typeof patient.age !== 'number' || patient.age < 0 || patient.age > 150)) {
        errors.push('age must be a number between 0 and 150');
    }

    if (patient.condition && typeof patient.condition !== 'string') {
        errors.push('condition must be a string');
    }

    if (patient.status && !['Candidate', 'Pre-Screening', 'Enrolled', 'Screen Fail', 'Completed', 'Merged'].includes(patient.status)) {
        errors.push('status must be one of: Candidate, Pre-Screening, Enrolled, Screen Fail, Completed, Merged');
    }

    if (patient.registryStatus && !['Active', 'Inactive', 'Do Not Call'].includes(patient.registryStatus)) {
        errors.push('registryStatus must be one of: Active, Inactive, Do Not Call');
    }

    if (patient.source && typeof patient.source !== 'string') {
        errors.push('source must be a string');
    }

    if (patient.therapeuticArea && typeof patient.therapeuticArea !== 'string') {
        errors.push('therapeuticArea must be a string');
    }

    if (patient.studyId && typeof patient.studyId !== 'string') {
        errors.push('studyId must be a string');
    }

    if (patient.siteId && typeof patient.siteId !== 'string') {
        errors.push('siteId must be a string');
    }

    if (patient.appointment && typeof patient.appointment !== 'object') {
        errors.push('appointment must be an object');
    }

    if (patient.surveyResults && !Array.isArray(patient.surveyResults)) {
        errors.push('surveyResults must be an array');
    }

    if (patient.contactLogs && !Array.isArray(patient.contactLogs)) {
        errors.push('contactLogs must be an array');
    }

    if (patient.studyHistory && !Array.isArray(patient.studyHistory)) {
        errors.push('studyHistory must be an array');
    }

    if (patient.inclusionCriteriaMet !== undefined && typeof patient.inclusionCriteriaMet !== 'boolean') {
        errors.push('inclusionCriteriaMet must be a boolean');
    }

    if (patient.exclusionCriteriaMet !== undefined && typeof patient.exclusionCriteriaMet !== 'boolean') {
        errors.push('exclusionCriteriaMet must be a boolean');
    }

    ['appointments', 'tasks', 'consentRecords', 'communications', 'waitlist', 'auditTrail', 'visitLogs', 'completedVisits', 'surveyDrafts', 'medications', 'tags', 'pendingConsentLinks'].forEach((field) => {
        if (patient[field] !== undefined && !Array.isArray(patient[field])) {
            errors.push(`${field} must be an array`);
        }
    });

    if (patient.pipelineStage !== undefined && typeof patient.pipelineStage !== 'string') {
        errors.push('pipelineStage must be a string');
    }
    if (patient.eligibilityStatus !== undefined && typeof patient.eligibilityStatus !== 'string') {
        errors.push('eligibilityStatus must be a string');
    }
    if (patient.doNotContact !== undefined && typeof patient.doNotContact !== 'boolean') {
        errors.push('doNotContact must be a boolean');
    }

    if (patient.enrollments !== undefined && !Array.isArray(patient.enrollments)) {
        errors.push('enrollments must be an array');
    }
    if (patient.enrolledStudyIds !== undefined && !Array.isArray(patient.enrolledStudyIds)) {
        errors.push('enrolledStudyIds must be an array');
    }
    if (patient.candidateStudyIds !== undefined && !Array.isArray(patient.candidateStudyIds)) {
        errors.push('candidateStudyIds must be an array');
    }
    if (patient.currentStudyId !== undefined && patient.currentStudyId !== null && typeof patient.currentStudyId !== 'string') {
        errors.push('currentStudyId must be a string or null');
    }
    if (patient.currentSiteId !== undefined && patient.currentSiteId !== null && typeof patient.currentSiteId !== 'string') {
        errors.push('currentSiteId must be a string or null');
    }
    if (patient.homeSiteId !== undefined && patient.homeSiteId !== null && typeof patient.homeSiteId !== 'string') {
        errors.push('homeSiteId must be a string or null');
    }
    if (patient.claimedByUserId !== undefined && patient.claimedByUserId !== null && typeof patient.claimedByUserId !== 'string') {
        errors.push('claimedByUserId must be a string or null');
    }
    if (patient.primaryAppointmentDate !== undefined && patient.primaryAppointmentDate !== null && typeof patient.primaryAppointmentDate !== 'string') {
        errors.push('primaryAppointmentDate must be a string or null');
    }

    Object.assign(data, patient);
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Patients validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const PATIENT_QUERY_FIELDS = new Set([
    'registryStatus', 'status', 'therapeuticArea', 'condition', 'source', 'state', 'city', 'zipCode',
    'age', 'eligibilityStatus', 'pipelineStage', 'doNotContact', 'inclusionCriteriaMet', 'exclusionCriteriaMet',
    'currentStudyId', 'currentSiteId', 'assignedToUserId', 'group', 'globalId', 'homeSiteId',
    'claimedByUserId', 'primaryAppointmentDate',
]);

const patientHasRecruitmentStatus = (patient) => String(patient?.status || '').trim().length > 0;

const inferPipelineStageFromPatient = (patient) => {
    if (!patientHasRecruitmentStatus(patient)) return 'lead';
    if (patient.status === 'Screen Fail') return 'screen_fail';
    if (patient.status === 'Enrolled') return 'enrolled';
    if (Array.isArray(patient.consentRecords) && patient.consentRecords.some((c) => c && c.status === 'signed')) return 'consented';
    const apptTime = patient.appointment?.time
        || (Array.isArray(patient.appointments) && patient.appointments.find((a) => a?.time)?.time);
    if (apptTime) {
        const appt = patient.appointment?.time === apptTime ? patient.appointment
            : (patient.appointments || []).find((a) => a?.time === apptTime);
        if (appt?.checkInStatus === 'checked-in') return 'showed';
        if (new Date(apptTime) > new Date()) return 'scheduled';
    }
    if ((Array.isArray(patient.surveyResults) && patient.surveyResults.length) || patient.status === 'Pre-Screening') return 'pre_screened';
    if (Array.isArray(patient.contactLogs) && patient.contactLogs.length) return 'contacted';
    if (patient.registryStatus === 'Inactive') return 'inactive';
    return 'lead';
};

const computePatientDenormalized = (patient) => {
    const enrollments = Array.isArray(patient.enrollments) ? patient.enrollments : [];
    let current = enrollments.find((e) => e && e.status === 'current');
    if (!current && patient.studyId && patient.siteId) {
        current = { studyId: patient.studyId, siteId: patient.siteId, status: 'current' };
    }
    const enrolledStudyIds = [...new Set(
        enrollments
            .filter((e) => e && ['current', 'past'].includes(e.status) && e.studyId)
            .map((e) => e.studyId)
            .concat(patient.studyId ? [patient.studyId] : [])
    )];
    const candidateStudyIds = [...new Set(
        enrollments.filter((e) => e && e.status === 'candidate' && e.studyId).map((e) => e.studyId)
    )];
    return {
        currentStudyId: current?.studyId || patient.studyId || null,
        currentSiteId: current?.siteId || patient.siteId || null,
        enrolledStudyIds,
        candidateStudyIds,
    };
};

const enrichPatientDocument = (patient) => {
    if (!patient || typeof patient !== 'object') return patient;
    const coerced = { ...patient };
    if ((!coerced.firstName || !coerced.lastName) && coerced.name && typeof coerced.name === 'string') {
        const parts = coerced.name.trim().split(/\s+/).filter(Boolean);
        if (!coerced.firstName && parts.length) coerced.firstName = parts[0];
        if (!coerced.lastName && parts.length > 1) coerced.lastName = parts.slice(1).join(' ');
    }
    if (coerced.first_name && !coerced.firstName) coerced.firstName = String(coerced.first_name).trim();
    if (coerced.last_name && !coerced.lastName) coerced.lastName = String(coerced.last_name).trim();
    const denorm = computePatientDenormalized(coerced);
    let primaryAppointmentDate = coerced.primaryAppointmentDate || null;
    const apptTime = coerced.appointment?.time
        || (Array.isArray(coerced.appointments) && coerced.appointments.find(a => a?.time)?.time);
    if (apptTime) {
        try { primaryAppointmentDate = new Date(apptTime).toISOString().split('T')[0]; } catch { /* ignore */ }
    }
    if (!patientHasRecruitmentStatus(coerced)) {
        coerced.pipelineStage = 'lead';
    } else if (!coerced.pipelineStage) {
        coerced.pipelineStage = inferPipelineStageFromPatient(coerced);
    }
    return { ...coerced, ...denorm, primaryAppointmentDate };
};

const userHasFullAccess = (user) => {
    if (!user) return false;
    if (user.role === 'Internal') return true;
    if (user.testModeAccess === true) return true;
    if (
        process.env.NASA_ENTRA_TEST_MODE === 'true'
        && user.userPartition === 'external'
        && user.authType === 'entra'
    ) return true;
    return false;
};

const scopeFromUserRecord = (user) => ({
    role: user?.role || '',
    allowedSiteIds: Array.isArray(user?.allowedSiteIds) ? user.allowedSiteIds : [],
    allowedStudyIds: Array.isArray(user?.allowedStudyIds) ? user.allowedStudyIds : [],
    userId: user?.id || null,
    fullAccess: userHasFullAccess(user),
});

const patientAccessibleToScope = (patient, scope) => {
    if (!scope || scope.fullAccess || scope.role === 'Internal') return true;
    const allowedSites = scope.allowedSiteIds || [];
    const allowedStudies = scope.allowedStudyIds || [];

    if (!patientHasRecruitmentStatus(patient)) {
        const homeSiteId = patient.homeSiteId;
        if (homeSiteId && allowedSites.length && !allowedSites.includes(homeSiteId)) return false;
        if (scope.userId && (patient.claimedByUserId === scope.userId || patient.assignedToUserId === scope.userId)) return true;
        return true;
    }

    const denorm = computePatientDenormalized(patient);
    if (allowedStudies.length && denorm.candidateStudyIds?.some((id) => allowedStudies.includes(id))) return true;

    const siteId = denorm.currentSiteId;
    const studyId = denorm.currentStudyId;

    if (siteId || studyId) {
        if (allowedSites.length && siteId && !allowedSites.includes(siteId)) return false;
        if (allowedStudies.length && studyId && !allowedStudies.includes(studyId)) return false;
        return true;
    }

    const homeSiteId = patient.homeSiteId;
    if (allowedSites.length && homeSiteId && allowedSites.includes(homeSiteId)) return true;
    if (scope.userId && (patient.claimedByUserId === scope.userId || patient.assignedToUserId === scope.userId)) return true;
    if (!homeSiteId) return true;
    return false;
};

const resolveRequestContext = async (request) => {
    const userId = request.headers && (request.headers.get ? request.headers.get('x-nasa-user-id') : request.headers['x-nasa-user-id']);
    if (userId) {
        try {
            const { resource: user } = await getContainer(RECRUITMENT_USERS_CONTAINER).item(String(userId)).read();
            if (user && user.active !== false) {
                const actor = { upn: user.email || user.username, name: user.displayName || user.username };
                return { user, actor, scope: scopeFromUserRecord(user), authenticated: true };
            }
        } catch { /* fall through */ }
    }
    return { user: null, actor: null, scope: null, authenticated: false };
};

const scopeForbiddenResponse = () => ({
    status: 403,
    jsonBody: { error: 'You do not have access to this patient record' },
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});

const NO_CURRENT_STUDY_SQL = '(NOT IS_DEFINED(c.currentStudyId) OR c.currentStudyId = null OR c.currentStudyId = "")';

const buildScopeClause = (scope, parameters, paramIndexRef) => {
    if (!scope || scope.fullAccess || scope.role === 'Internal') return { clause: '', parameters };
    const allowedSites = Array.isArray(scope.allowedSiteIds) ? scope.allowedSiteIds.filter(Boolean) : [];
    const allowedStudies = Array.isArray(scope.allowedStudyIds) ? scope.allowedStudyIds.filter(Boolean) : [];
    const scopeParts = [];

    const enrolledParts = [];
    if (allowedSites.length) {
        const siteKeys = allowedSites.map((siteId) => {
            const key = `@scopeSite${paramIndexRef.i++}`;
            parameters.push({ name: key, value: siteId });
            return key;
        });
        enrolledParts.push(`(IS_DEFINED(c.currentSiteId) AND c.currentSiteId != null AND c.currentSiteId IN (${siteKeys.join(', ')}))`);
    }
    if (allowedStudies.length) {
        const studyKeys = allowedStudies.map((studyId) => {
            const key = `@scopeStudy${paramIndexRef.i++}`;
            parameters.push({ name: key, value: studyId });
            return key;
        });
        enrolledParts.push(`(IS_DEFINED(c.currentStudyId) AND c.currentStudyId != null AND c.currentStudyId IN (${studyKeys.join(', ')}))`);
    }
    if (enrolledParts.length) scopeParts.push(`(${enrolledParts.join(' AND ')})`);

    if (allowedStudies.length) {
        const candidateKeys = allowedStudies.map((studyId) => {
            const key = `@scopeCand${paramIndexRef.i++}`;
            parameters.push({ name: key, value: studyId });
            return `(IS_DEFINED(c.candidateStudyIds) AND ARRAY_CONTAINS(c.candidateStudyIds, ${key}))`;
        });
        scopeParts.push(`(${candidateKeys.join(' OR ')})`);
    }

    const leadParts = [];
    if (allowedSites.length) {
        const homeKeys = allowedSites.map((siteId) => {
            const key = `@scopeHome${paramIndexRef.i++}`;
            parameters.push({ name: key, value: siteId });
            return key;
        });
        leadParts.push(`(IS_DEFINED(c.homeSiteId) AND c.homeSiteId IN (${homeKeys.join(', ')}))`);
    }
    if (scope.userId) {
        const uidKey = `@scopeUser${paramIndexRef.i++}`;
        parameters.push({ name: uidKey, value: scope.userId });
        leadParts.push(`(c.claimedByUserId = ${uidKey} OR c.assignedToUserId = ${uidKey})`);
    }
    // Unattributed recruitment leads (no current enrollment, no home site) belong in the shared pipeline pool.
    leadParts.push('(NOT IS_DEFINED(c.homeSiteId) OR c.homeSiteId = null OR c.homeSiteId = "")');
    scopeParts.push(`(${NO_CURRENT_STUDY_SQL} AND (${leadParts.join(' OR ')}))`);

    if (!scopeParts.length) return { clause: '', parameters };
    return { clause: `(${scopeParts.join(' OR ')})`, parameters };
};

const buildCriteriaClause = (criteria, parameters, paramIndexRef) => {
    const conditions = criteria && Array.isArray(criteria.conditions) ? criteria.conditions : [];
    const logic = (criteria && criteria.logic === 'OR') ? 'OR' : 'AND';
    const parts = [];

    conditions.forEach((cond) => {
        if (!cond || !cond.field || !cond.op) return;
        const field = String(cond.field);
        const op = String(cond.op);
        const value = cond.value;

        if (op === 'not_enrolled_in') {
            const studyKey = `@p${paramIndexRef.i++}`;
            parameters.push({ name: studyKey, value: String(value || '') });
            parts.push(`((NOT IS_DEFINED(c.enrolledStudyIds) OR NOT ARRAY_CONTAINS(c.enrolledStudyIds, ${studyKey})) AND (NOT IS_DEFINED(c.currentStudyId) OR c.currentStudyId = null OR c.currentStudyId != ${studyKey}) AND (NOT IS_DEFINED(c.candidateStudyIds) OR NOT ARRAY_CONTAINS(c.candidateStudyIds, ${studyKey})))`);
            return;
        }
        if (op === 'has_current_enrollment') {
            parts.push('(IS_DEFINED(c.currentStudyId) AND c.currentStudyId != null AND c.currentStudyId != "")');
            return;
        }
        if (op === 'no_current_enrollment') {
            parts.push('(NOT IS_DEFINED(c.currentStudyId) OR c.currentStudyId = null OR c.currentStudyId = "")');
            return;
        }
        if (op === 'appointment_on_date') {
            const dateKey = `@p${paramIndexRef.i++}`;
            parameters.push({ name: dateKey, value: String(value || '') });
            parts.push(`(IS_DEFINED(c.primaryAppointmentDate) AND c.primaryAppointmentDate = ${dateKey})`);
            return;
        }
        if (op === 'has_appointment') {
            parts.push('(IS_DEFINED(c.primaryAppointmentDate) AND c.primaryAppointmentDate != null AND c.primaryAppointmentDate != "")');
            return;
        }
        if (!PATIENT_QUERY_FIELDS.has(field) && field !== 'search') return;

        if (op === 'between' && Array.isArray(value) && value.length === 2) {
            const minKey = `@p${paramIndexRef.i++}`;
            const maxKey = `@p${paramIndexRef.i++}`;
            parameters.push({ name: minKey, value: value[0] });
            parameters.push({ name: maxKey, value: value[1] });
            parts.push(`(IS_DEFINED(c.${field}) AND c.${field} >= ${minKey} AND c.${field} <= ${maxKey})`);
            return;
        }
        if (op === 'in' && Array.isArray(value) && value.length) {
            const keys = value.map((v) => {
                const key = `@p${paramIndexRef.i++}`;
                parameters.push({ name: key, value: v });
                return key;
            });
            parts.push(`(IS_DEFINED(c.${field}) AND c.${field} IN (${keys.join(', ')}))`);
            return;
        }
        if (op === 'contains') {
            const key = `@p${paramIndexRef.i++}`;
            parameters.push({ name: key, value: String(value || '').toLowerCase() });
            parts.push(`(IS_DEFINED(c.${field}) AND CONTAINS(LOWER(c.${field}), ${key}))`);
            return;
        }
        if (op === 'equals' || op === 'not_equals') {
            const key = `@p${paramIndexRef.i++}`;
            parameters.push({ name: key, value });
            const comparator = op === 'equals' ? '=' : '!=';
            if (value === null) {
                parts.push(op === 'equals'
                    ? `(NOT IS_DEFINED(c.${field}) OR c.${field} = null)`
                    : `(IS_DEFINED(c.${field}) AND c.${field} != null)`);
            } else {
                parts.push(`(IS_DEFINED(c.${field}) AND c.${field} ${comparator} ${key})`);
            }
            return;
        }
        if (op === 'is_true') {
            parts.push(`(c.${field} = true)`);
            return;
        }
        if (op === 'is_false') {
            parts.push(`(NOT IS_DEFINED(c.${field}) OR c.${field} = false)`);
            return;
        }
    });

    if (!parts.length) return { clause: '', parameters };
    return { clause: `(${parts.join(` ${logic} `)})`, parameters };
};

const buildPatientSearchClause = (searchTerm, parameters, paramIndexRef) => {
    const term = String(searchTerm || '').trim().toLowerCase();
    if (!term) return { clause: '', parameters };
    const key = `@p${paramIndexRef.i++}`;
    parameters.push({ name: key, value: term });
    return {
        clause: `(CONTAINS(LOWER(c.firstName), ${key}) OR CONTAINS(LOWER(c.lastName), ${key}) OR CONTAINS(LOWER(c.email), ${key}) OR CONTAINS(LOWER(c.globalId), ${key}) OR CONTAINS(LOWER(c.phoneNumber), ${key}))`,
        parameters,
    };
};

const buildPatientQuery = (body = {}) => {
    const parameters = [];
    const paramIndexRef = { i: 0 };
    const whereParts = ['1=1'];

    const scopePart = buildScopeClause(body.scope, parameters, paramIndexRef);
    if (scopePart.clause) whereParts.push(scopePart.clause);

    const criteriaPart = buildCriteriaClause(body.criteria, parameters, paramIndexRef);
    if (criteriaPart.clause) whereParts.push(criteriaPart.clause);

    if (body.search) {
        const searchPart = buildPatientSearchClause(body.search, parameters, paramIndexRef);
        if (searchPart.clause) whereParts.push(searchPart.clause);
    }

    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 50, 1), 3000);
    const query = `SELECT * FROM c WHERE ${whereParts.join(' AND ')} ORDER BY c._ts DESC OFFSET ${parseInt(body.offset, 10) || 0} LIMIT ${limit}`;
    const countQuery = `SELECT VALUE COUNT(1) FROM c WHERE ${whereParts.join(' AND ')}`;
    return { query, countQuery, parameters, limit };
};

const queryPatients = async (body = {}) => {
    const container = getContainer('patients');
    const { query, countQuery, parameters, limit } = buildPatientQuery(body);
    const { resources } = await container.items.query({ query, parameters }).fetchAll();
    let total = null;
    if (body.includeTotal !== false) {
        const countIterator = container.items.query({ query: countQuery, parameters });
        const countResult = await countIterator.fetchNext();
        total = countResult.resources && countResult.resources[0] != null ? countResult.resources[0] : 0;
    }
    return {
        items: (resources || []).map(enrichPatientDocument),
        total,
        limit,
        offset: parseInt(body.offset, 10) || 0,
    };
};

const shouldSkipCohortAssign = (patient, assignBody) => {
    if (!patient) return 'not_found';
    if (patient.doNotContact) return 'do_not_contact';
    if (patient.registryStatus === 'Inactive') return 'inactive';
    const studyId = assignBody.studyId;
    const siteId = assignBody.siteId;
    const enrollments = Array.isArray(patient.enrollments) ? patient.enrollments : [];
    const denorm = computePatientDenormalized(patient);
    if (denorm.enrolledStudyIds.includes(studyId)) return 'already_enrolled';
    if (denorm.candidateStudyIds.includes(studyId)) return 'already_candidate';
    const hasCurrent = enrollments.some((e) => e && e.status === 'current');
    if (assignBody.assignmentType === 'current' && hasCurrent) {
        const current = enrollments.find((e) => e.status === 'current');
        if (current && current.studyId === studyId && current.siteId === siteId) return 'already_current';
    }
    return null;
};

const applyCohortAssignmentToPatient = (patient, assignBody, actor) => {
    const studyId = assignBody.studyId;
    const siteId = assignBody.siteId;
    const assignmentType = assignBody.assignmentType === 'current' ? 'current' : 'candidate';
    const enrollments = Array.isArray(patient.enrollments) ? [...patient.enrollments] : [];
    const now = new Date().toISOString();
    const actorLabel = actor?.upn || actor?.name || 'system';

    if (assignmentType === 'current') {
        enrollments.forEach((e) => {
            if (e && e.status === 'current') {
                e.status = 'past';
                e.exitedDate = now;
            }
        });
        enrollments.push({
            studyId,
            siteId,
            status: 'current',
            enrolledDate: now,
            exitedDate: null,
            assignmentSource: assignBody.ruleId || assignBody.cohortId || 'cohort_assign',
        });
    } else {
        enrollments.push({
            studyId,
            siteId,
            status: 'candidate',
            assignedAt: now,
            assignedBy: actorLabel,
            assignmentSource: assignBody.ruleId || assignBody.cohortId || 'cohort_assign',
        });
    }

    const auditEntry = {
        id: generateId(),
        at: now,
        action: 'cohort_assign',
        details: `${assignmentType} → ${studyId} @ ${siteId}`,
        user: actorLabel,
    };
    const auditTrail = [...(Array.isArray(patient.auditTrail) ? patient.auditTrail : []), auditEntry];
    const updates = enrichPatientDocument({
        ...patient,
        enrollments,
        auditTrail,
        studyId: assignmentType === 'current' ? studyId : patient.studyId,
        siteId: assignmentType === 'current' ? siteId : patient.siteId,
        lastUpdated: now,
    });
    if (assignBody.pipelineStage) updates.pipelineStage = assignBody.pipelineStage;
    if (assignBody.assignedToUserId) updates.assignedToUserId = assignBody.assignedToUserId;
    return updates;
};

const collectMatchingPatientIds = async (criteria, scope, maxIds = 50000) => {
    const container = getContainer('patients');
    const ids = [];
    let offset = 0;
    const pageSize = 500;
    while (ids.length < maxIds) {
        const { query, parameters } = buildPatientQuery({
            criteria,
            scope,
            limit: pageSize,
            offset,
            includeTotal: false,
        });
        const idQuery = query.replace('SELECT * FROM c', 'SELECT c.id FROM c');
        const { resources } = await container.items.query({ query: idQuery, parameters }).fetchAll();
        if (!resources || !resources.length) break;
        resources.forEach((row) => { if (row.id) ids.push(row.id); });
        if (resources.length < pageSize) break;
        offset += pageSize;
    }
    return ids;
};

const processBulkAssignBatch = async (job, context) => {
    const patientsContainer = getContainer('patients');
    const membershipsContainer = getContainer('cohort-memberships');
    const jobsContainer = getContainer('bulk-jobs');
    const batchSize = 50;
    const assignBody = job.assign || {};
    const criteria = job.criteria || { logic: 'AND', conditions: [] };
    const scope = job.scope || null;
    let processed = job.processed || 0;
    let succeeded = job.succeeded || 0;
    let skipped = job.skipped || 0;
    let failed = job.failed || 0;
    const errors = Array.isArray(job.errors) ? [...job.errors] : [];

    if (!Array.isArray(job.patientIds)) {
        job.patientIds = await collectMatchingPatientIds(criteria, scope);
        job.total = job.patientIds.length;
        await jobsContainer.items.upsert(job);
    }

    const slice = job.patientIds.slice(processed, processed + batchSize);
    if (!slice.length) {
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        await jobsContainer.items.upsert(job);
        return job;
    }

    for (const patientId of slice) {
        processed += 1;
        job.processed = processed;
        let patient = null;
        try {
            const readRes = await patientsContainer.item(patientId).read();
            patient = readRes.resource;
        } catch {
            failed += 1;
            if (errors.length < 200) errors.push({ patientId, reason: 'not_found' });
            continue;
        }
        try {
            const skipReason = shouldSkipCohortAssign(patient, assignBody);
            if (skipReason) {
                skipped += 1;
                if (errors.length < 200) errors.push({ patientId: patient.id, reason: skipReason });
                continue;
            }
            const updated = applyCohortAssignmentToPatient(patient, assignBody, job.actor || null);
            await patientsContainer.items.upsert(updated);
            const membership = {
                id: generateId(),
                patientId: patient.id,
                studyId: assignBody.studyId,
                siteId: assignBody.siteId,
                status: assignBody.assignmentType === 'current' ? 'current' : 'candidate',
                cohortId: job.cohortId || job.ruleId || job.id,
                jobId: job.id,
                assignedAt: new Date().toISOString(),
            };
            await membershipsContainer.items.create(membership);
            succeeded += 1;
        } catch (e) {
            failed += 1;
            if (errors.length < 200) errors.push({ patientId: patient.id, reason: e.message || 'error' });
            context.log.warn('Bulk assign patient failed:', patient.id, e.message);
        }
    }

    job.succeeded = succeeded;
    job.skipped = skipped;
    job.failed = failed;
    job.errors = errors;
    job.status = processed >= (job.patientIds || []).length ? 'completed' : 'running';
    if (job.status === 'completed') job.completedAt = new Date().toISOString();
    await jobsContainer.items.upsert(job);
    return job;
};

const appendPatientAudit = (patient, action, details, actorLabel) => ({
    id: generateId(),
    at: new Date().toISOString(),
    action,
    details,
    user: actorLabel || 'system',
});

const promoteCandidateEnrollment = (patient, studyId, siteId, actorLabel) => {
    const enrollments = Array.isArray(patient.enrollments) ? [...patient.enrollments] : [];
    const now = new Date().toISOString();
    const candidateIdx = enrollments.findIndex(e => e && e.status === 'candidate' && e.studyId === studyId);
    if (candidateIdx < 0) throw new Error('No candidate enrollment found for this study');
    enrollments.forEach((e) => {
        if (e && e.status === 'current') {
            e.status = 'past';
            e.exitedDate = now;
        }
    });
    const candidate = enrollments[candidateIdx];
    enrollments[candidateIdx] = {
        ...candidate,
        status: 'current',
        siteId: siteId || candidate.siteId,
        enrolledDate: now,
        promotedAt: now,
        promotedBy: actorLabel,
    };
    const auditTrail = [...(patient.auditTrail || []), appendPatientAudit(patient, 'promote_candidate', `${studyId} @ ${siteId || candidate.siteId}`, actorLabel)];
    return enrichPatientDocument({
        ...patient,
        enrollments,
        auditTrail,
        studyId,
        siteId: siteId || candidate.siteId,
        pipelineStage: patient.pipelineStage === 'lead' ? 'contacted' : patient.pipelineStage,
        lastUpdated: now,
    });
};

const claimPatientLead = (patient, userId, homeSiteId, actorLabel) => {
    const now = new Date().toISOString();
    const auditTrail = [...(patient.auditTrail || []), appendPatientAudit(patient, 'claim_lead', `claimed by ${userId}`, actorLabel)];
    return enrichPatientDocument({
        ...patient,
        claimedByUserId: userId,
        claimedAt: now,
        homeSiteId: homeSiteId || patient.homeSiteId || null,
        assignedToUserId: patient.assignedToUserId || userId,
        auditTrail,
        lastUpdated: now,
    });
};

const withdrawCandidateEnrollment = (patient, studyId, actorLabel) => {
    const enrollments = (patient.enrollments || []).filter(e => !(e && e.status === 'candidate' && e.studyId === studyId));
    const auditTrail = [...(patient.auditTrail || []), appendPatientAudit(patient, 'withdraw_candidate', studyId, actorLabel)];
    return enrichPatientDocument({ ...patient, enrollments, auditTrail, lastUpdated: new Date().toISOString() });
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

const normalizeRecruitmentUserInput = (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const normalized = { ...data };
    if (normalized.username != null) normalized.username = String(normalized.username).trim();
    if (normalized.email != null) normalized.email = String(normalized.email).trim();
    if (normalized.displayName != null) normalized.displayName = String(normalized.displayName).trim();
    if (!normalized.displayName) {
        normalized.displayName = normalized.username
            || normalized.email
            || (normalized.entraId ? String(normalized.entraId) : '')
            || 'User';
    }
    if (!normalized.username) {
        normalized.username = normalized.email
            || normalized.displayName
            || (normalized.entraId ? String(normalized.entraId) : '')
            || `user_${generateId()}`;
    }
    if (!normalized.email && normalized.username.includes('@')) {
        normalized.email = normalized.username.toLowerCase();
    }
    return normalized;
};

const validateUsersSchema = (data) => {
    const errors = [];
    const normalized = normalizeRecruitmentUserInput(data);
    Object.assign(data, normalized);
    if (!data.displayName || typeof data.displayName !== 'string') {
        errors.push('displayName is required and must be a string');
    }
    if (data.email !== undefined && data.email !== null && typeof data.email !== 'string') {
        errors.push('email must be a string');
    }
    if (data.username !== undefined && data.username !== null && typeof data.username !== 'string') {
        errors.push('username must be a string');
    }
    if (data.password !== undefined && data.password !== null && typeof data.password !== 'string') {
        errors.push('password must be a string');
    }
    if (data.role !== undefined && data.role !== null && typeof data.role !== 'string') {
        errors.push('role must be a string');
    }
    if (data.allowedSiteIds !== undefined && data.allowedSiteIds !== null && !Array.isArray(data.allowedSiteIds)) {
        errors.push('allowedSiteIds must be an array');
    }
    if (data.allowedStudyIds !== undefined && data.allowedStudyIds !== null && !Array.isArray(data.allowedStudyIds)) {
        errors.push('allowedStudyIds must be an array');
    }
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Users validation failed: ${errors.join(', ')}`);
    }
    return true;
};

const validateCohortRulesSchema = (data) => {
    const errors = [];
    if (!data.name || typeof data.name !== 'string') errors.push('name is required and must be a string');
    if (!data.studyId || typeof data.studyId !== 'string') errors.push('studyId is required and must be a string');
    if (!data.defaultSiteId || typeof data.defaultSiteId !== 'string') errors.push('defaultSiteId is required and must be a string');
    if (data.criteria !== undefined && typeof data.criteria !== 'object') errors.push('criteria must be an object');
    if (errors.length) throw new Error(`VALIDATION_ERROR: Cohort rule validation failed: ${errors.join(', ')}`);
    return true;
};

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
        const { resources } = await studiesContainer.items
            .query({
                query: "SELECT * FROM c WHERE c.id = @id",
                parameters: [{ name: "@id", value: studyId }]
            })
            .fetchAll();
        const study = resources && resources[0];
        
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

async function crudHandler(context, request, containerName) {
    const container = getContainer(containerName);
    const { method } = request;
    const id = getIdFromRequest(request);

    try {
        let requestContext = null;
        if (containerName === 'patients' && method !== 'OPTIONS') {
            requestContext = await resolveRequestContext(request);
        }
        if (method !== 'OPTIONS') await requireUser();
        const actor = requestContext?.actor || null;

        switch (method) {
            case 'GET':
                if (containerName === 'patients') {
                    if (id) {
                        const resource = await findPatientRecord(container, id);
                        if (!resource) return { status: 404, jsonBody: { error: 'Patient not found' }, headers: corsJsonHeaders };
                        const enriched = enrichPatientDocument(resource);
                        if (!patientAccessibleToScope(enriched, requestContext?.scope)) return scopeForbiddenResponse();
                        return { jsonBody: enriched, headers: corsJsonHeaders };
                    }
                    const scope = requestContext?.scope || null;
                    const maxPatients = Math.min(parseInt(request.query.get('limit'), 10) || 10000, 10000);
                    const pageSize = 500;
                    const allItems = [];
                    let offset = 0;
                    while (allItems.length < maxPatients) {
                        const batch = await queryPatients({
                            scope,
                            limit: pageSize,
                            offset,
                            includeTotal: false,
                        });
                        allItems.push(...(batch.items || []));
                        if (!batch.items || batch.items.length < pageSize) break;
                        offset += pageSize;
                    }
                    return { jsonBody: allItems };
                }
                if (id) {
                    const resource = await safeItemRead(container, id);
                    if (!resource) {
                        // First-run seed for NASA reference lists — avoid noisy 404s on boot
                        if (containerName === 'recruitment-settings' && id === 'nasa-reference-data') {
                            return {
                                jsonBody: {
                                    id: 'nasa-reference-data',
                                    medications: [],
                                    tags: [],
                                    nqReasons: [],
                                    niReasons: [],
                                    updatedAt: new Date().toISOString(),
                                    _missing: true,
                                },
                                headers: corsJsonHeaders,
                            };
                        }
                        return { status: 404, jsonBody: { error: `${containerName} not found` }, headers: corsJsonHeaders };
                    }
                    return { jsonBody: resource, headers: corsJsonHeaders };
                }
                const resources = await safeReadAll(container);
                return { jsonBody: resources, headers: corsJsonHeaders };
            
            case 'POST': {
                const bodyRaw = await request.json();
                if (containerName === 'patients' && (isPatientQueryBody(bodyRaw) || id === 'query')) {
                    const result = await queryPatients({ ...bodyRaw, scope: requestContext?.scope || null });
                    return { jsonBody: result, headers: corsJsonHeaders };
                }
                const body = containerName === 'patients'
                    ? normalizePatientInput(bodyRaw)
                    : bodyRaw;
                
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
                        case 'schedules':
                        case 'patient-schedules':
                            validateSchedulesSchema(body);
                            await validateSiteStudyRelationship(body.siteId, body.studyId);
                            break;
                        case 'surveys':
                            validateSurveysSchema(body);
                            break;
                        case 'recruitment-users':
                            validateUsersSchema(body);
                            break;
                        case 'access-requests':
                            validateAccessRequestsSchema(body);
                            break;
                        case 'cohort-rules':
                            validateCohortRulesSchema(body);
                            break;
                    }
                } catch (validationError) {
                    console.error(`Validation error for ${containerName}:`, validationError.message);
                    return {
                        status: 400,
                        jsonBody: { error: validationError.message },
                        headers: corsJsonHeaders
                    };
                }
                
                let newItem = containerName === 'access-requests'
                    ? { ...normalizeAccessRequestInput(body), id: body.id || generateId() }
                    : { ...body, id: body.id || generateId() };
                if (containerName === 'patients') {
                    newItem = enrichPatientDocument(newItem);
                    if (requestContext?.scope && !patientAccessibleToScope(newItem, requestContext.scope)) {
                        return scopeForbiddenResponse();
                    }
                }
                const { resource: createdItem } = await wrapCosmosWrite(
                    () => container.items.create(newItem),
                    containerName
                );

                await writeAudit({
                    action: `${containerName}.create`,
                    containerName,
                    method,
                    targetId: createdItem && createdItem.id,
                    actor,
                    before: null,
                    after: createdItem,
                });
                
                if (containerName === 'studies') {
                    const enrollment = await calculateStudyEnrollment(createdItem.id);
                    createdItem.enrolled = enrollment;
                }
                
                return { status: 201, jsonBody: createdItem, headers: corsJsonHeaders };
            }
            
            case 'PUT': {
                const rawRequestBody = await request.json();
                const updateId = id || rawRequestBody.id;

                const before = updateId ? await (containerName === 'patients'
                    ? findPatientRecord(container, updateId)
                    : safeItemRead(container, updateId)) : null;

                if (containerName === 'patients' && updateId && !before) {
                    return { status: 404, jsonBody: { error: 'Patient not found' }, headers: corsJsonHeaders };
                }

                let requestBody = rawRequestBody;
                if (containerName === 'patients') {
                    requestBody = normalizePatientInput(before ? { ...before, ...rawRequestBody, id: updateId } : { ...rawRequestBody, id: updateId });
                } else if (containerName === 'access-requests') {
                    requestBody = normalizeAccessRequestInput(before ? { ...before, ...rawRequestBody, id: updateId } : { ...rawRequestBody, id: updateId });
                } else if (before) {
                    requestBody = { ...before, ...rawRequestBody, id: updateId };
                }

                if (containerName === 'patients') {
                    if (before && !patientAccessibleToScope(enrichPatientDocument(before), requestContext?.scope)) {
                        return scopeForbiddenResponse();
                    }
                }
                
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
                        case 'schedules':
                        case 'patient-schedules':
                            validateSchedulesSchema(requestBody);
                            await validateSiteStudyRelationship(requestBody.siteId, requestBody.studyId);
                            break;
                        case 'surveys':
                            validateSurveysSchema(requestBody);
                            break;
                        case 'recruitment-users':
                            validateUsersSchema(requestBody);
                            break;
                        case 'access-requests':
                            validateAccessRequestsSchema(requestBody);
                            break;
                        case 'cohort-rules':
                            validateCohortRulesSchema(requestBody);
                            break;
                    }
                } catch (validationError) {
                    console.error(`Validation error for ${containerName}:`, validationError.message);
                    return {
                        status: 400,
                        jsonBody: { error: validationError.message },
                        headers: corsJsonHeaders
                    };
                }

                let updatedItem = { ...requestBody, id: updateId };
                if (containerName === 'patients') {
                    updatedItem = enrichPatientDocument(updatedItem);
                    if (!patientAccessibleToScope(updatedItem, requestContext?.scope)) {
                        return scopeForbiddenResponse();
                    }
                }
                const { resource: result } = await wrapCosmosWrite(
                    () => container.items.upsert(updatedItem),
                    containerName
                );

                await writeAudit({
                    action: `${containerName}.update`,
                    containerName,
                    method,
                    targetId: result && result.id,
                    actor,
                    before,
                    after: result,
                });
                
                if (containerName === 'studies') {
                    const enrollment = await calculateStudyEnrollment(result.id);
                    result.enrolled = enrollment;
                }
                
                return { jsonBody: result, headers: corsJsonHeaders };
            }

            case 'DELETE':
                let beforeDelete = null;
                try {
                    if (id) {
                        const readRes = await container.item(id).read();
                        beforeDelete = readRes && readRes.resource ? readRes.resource : null;
                    }
                } catch {}

                if (containerName === 'patients' && beforeDelete
                    && !patientAccessibleToScope(enrichPatientDocument(beforeDelete), requestContext?.scope)) {
                    return scopeForbiddenResponse();
                }

                await container.item(id).delete();

                await writeAudit({
                    action: `${containerName}.delete`,
                    containerName,
                    method,
                    targetId: id,
                    actor,
                    before: beforeDelete,
                    after: null,
                });
                return { status: 204, headers: corsJsonHeaders };

            case 'OPTIONS':
                return { status: 200, headers: corsJsonHeaders };

            default:
                return { status: 405, jsonBody: { error: 'Method Not Allowed' }, headers: corsJsonHeaders };
        }
    } catch (error) {
        return handleError(context, error, `Database operation failed on ${containerName}`);
    }
}

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

// Sub-routes under /patients/* must not be handled as patient IDs by patients/{id?}.

const runPatientsQuery = async (request, context) => {
    const requestContext = await resolveRequestContext(request);
    const body = await safeJson(request) || {};
    const result = await queryPatients({ ...body, scope: requestContext.scope });
    return { jsonBody: result, headers: jsonHeaders };
};

const runPatientsToday = async (request, context) => {
    const requestContext = await resolveRequestContext(request);
    const rawDate = String(request.query?.get?.('date') || '').trim();
    const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
        ? rawDate
        : new Date().toISOString().split('T')[0];
    const result = await queryPatients({
        scope: requestContext.scope,
        criteria: {
            logic: 'AND',
            conditions: [{ field: 'primaryAppointmentDate', op: 'appointment_on_date', value: dayKey }],
        },
        limit: 500,
        offset: 0,
        includeTotal: true,
    });
    return { jsonBody: { ...result, date: dayKey }, headers: jsonHeaders };
};

const runPatientsActions = async (request, context) => {
    const requestContext = await resolveRequestContext(request);
    const body = await safeJson(request) || {};
    const { action, patientId, studyId, siteId } = body;
    if (!action || !patientId) {
        return { status: 400, jsonBody: { error: 'action and patientId are required' }, headers: jsonHeaders };
    }
    const container = getContainer('patients');
    const patient = await findPatientRecord(container, patientId);
    if (!patient) return { status: 404, jsonBody: { error: 'Patient not found' }, headers: jsonHeaders };
    if (!patientAccessibleToScope(enrichPatientDocument(patient), requestContext.scope)) {
        return scopeForbiddenResponse();
    }
    const actorLabel = requestContext.actor?.upn || requestContext.actor?.name || requestContext.scope?.userId || 'system';
    let updated;
    if (action === 'promote_candidate') {
        if (!studyId) return { status: 400, jsonBody: { error: 'studyId is required' }, headers: jsonHeaders };
        updated = promoteCandidateEnrollment(patient, studyId, siteId, actorLabel);
    } else if (action === 'claim_lead') {
        const userId = requestContext.scope?.userId || body.userId;
        if (!userId) return { status: 400, jsonBody: { error: 'Authenticated user required to claim' }, headers: jsonHeaders };
        updated = claimPatientLead(patient, userId, body.homeSiteId, actorLabel);
    } else if (action === 'withdraw_candidate') {
        if (!studyId) return { status: 400, jsonBody: { error: 'studyId is required' }, headers: jsonHeaders };
        updated = withdrawCandidateEnrollment(patient, studyId, actorLabel);
    } else if (action === 'release_claim') {
        updated = enrichPatientDocument({
            ...patient,
            claimedByUserId: null,
            claimedAt: null,
            auditTrail: [...(patient.auditTrail || []), appendPatientAudit(patient, 'release_claim', '', actorLabel)],
            lastUpdated: new Date().toISOString(),
        });
    } else {
        return { status: 400, jsonBody: { error: `Unknown action: ${action}` }, headers: jsonHeaders };
    }
    const { resource: result } = await container.items.upsert(updated);
    return { jsonBody: enrichPatientDocument(result), headers: jsonHeaders };
};

const runPatientsReindex = async (request, context) => {
    const requestContext = await resolveRequestContext(request);
    if (requestContext.scope && !requestContext.scope.fullAccess && requestContext.scope.role !== 'Internal') {
        return { status: 403, jsonBody: { error: 'Internal role required' }, headers: jsonHeaders };
    }
    const body = await safeJson(request) || {};
    const limit = Math.min(parseInt(body.limit, 10) || 100, 500);
    const offset = parseInt(body.offset, 10) || 0;
    const container = getContainer('patients');
    const resources = await safeQueryAll(container, {
        query: `SELECT * FROM c ORDER BY c._ts DESC OFFSET ${offset} LIMIT ${limit}`,
    });
    let updated = 0;
    for (const p of resources) {
        await container.items.upsert(enrichPatientDocument(p));
        updated += 1;
    }
    return { jsonBody: { updated, offset, limit, hasMore: resources.length === limit }, headers: jsonHeaders };
};

const handlePatientsSubRoute = async (context, request) => {
    const subPath = request.params.id;
    if (!subPath || !PATIENT_SUBROUTES.has(subPath)) return null;
    const method = request.method;
    if (method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
    try {
        if (subPath === 'query' && method === 'POST') return await runPatientsQuery(request, context);
        if (subPath === 'today' && method === 'GET') return await runPatientsToday(request, context);
        if (subPath === 'actions' && method === 'POST') return await runPatientsActions(request, context);
        if (subPath === 'reindex' && method === 'POST') return await runPatientsReindex(request, context);
        return { status: 405, jsonBody: { error: 'Method Not Allowed' }, headers: jsonHeaders };
    } catch (error) {
        return handleError(context, error, `Patient ${subPath} failed`);
    }
};

app.http('patients', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'patients/{id?}',
    handler: async (request, context) => {
        const delegated = await handlePatientsSubRoute(context, request);
        if (delegated) return delegated;
        return crudHandler(context, request, 'patients');
    },
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

app.http('patientSchedules', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'patient-schedules/{id?}',
    handler: (request, context) => crudHandler(context, request, 'patient-schedules'),
});

const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

const stripUserSecrets = (user) => {
    if (!user) return user;
    const { password, ...safe } = user;
    return safe;
};

const decodeJwtPayload = (token) => {
    const tokenParts = String(token || '').split('.');
    if (tokenParts.length !== 3) throw new Error('Invalid token format');
    let base64 = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return JSON.parse(Buffer.from(base64, 'base64').toString());
};

const validateEntraTokenClaims = (payload) => {
    const clientId = process.env.ENTRA_CLIENT_ID || '';
    const tenantId = process.env.ENTRA_TENANT_ID || '';
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && Number(payload.exp) < now - 60) {
        throw new Error('Token expired');
    }
    if (clientId) {
        const aud = payload.aud;
        const audOk = aud === clientId
            || (Array.isArray(aud) && aud.includes(clientId))
            || aud === `api://${clientId}`;
        if (!audOk) throw new Error('Token audience mismatch');
    }
    if (tenantId) {
        const tid = payload.tid || '';
        const iss = String(payload.iss || '');
        if (tid && tid !== tenantId) throw new Error('Token tenant mismatch');
        if (iss && !iss.includes(tenantId) && tenantId !== 'common' && tenantId !== 'organizations') {
            throw new Error('Token issuer mismatch');
        }
    }
};

const getEntraAuthority = () => {
    if (process.env.ENTRA_AUTHORITY) return process.env.ENTRA_AUTHORITY;
    const tenantId = process.env.ENTRA_TENANT_ID || 'common';
    return `https://login.microsoftonline.com/${tenantId}`;
};

const getNasaAppUrl = () => {
    const configured = String(process.env.NASA_APP_URL || '').trim().replace(/\/$/, '');
    return configured || 'https://recruitment.oraclinical.com';
};

const getInternalEmailDomains = () => {
    const raw = process.env.NASA_ENTRA_INTERNAL_EMAIL_DOMAINS || 'oraclinical.com';
    return raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
};

const isInternalTenantEmail = (email) => {
    const normalized = String(email || '').trim().toLowerCase();
    const domain = normalized.split('@')[1];
    if (!domain) return false;
    return getInternalEmailDomains().includes(domain);
};

const isGraphInviteConfigured = () => {
    const tenantId = process.env.ENTRA_TENANT_ID;
    const clientId = process.env.NASA_GRAPH_CLIENT_ID || process.env.ENTRA_CLIENT_ID;
    const clientSecret = process.env.NASA_GRAPH_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET;
    return !!(tenantId && clientId && clientSecret);
};

let graphTokenCache = { token: null, expiresAt: 0 };

const getGraphAccessToken = async () => {
    if (graphTokenCache.token && Date.now() < graphTokenCache.expiresAt - 60000) {
        return graphTokenCache.token;
    }
    const tenantId = process.env.ENTRA_TENANT_ID;
    const clientId = process.env.NASA_GRAPH_CLIENT_ID || process.env.ENTRA_CLIENT_ID;
    const clientSecret = process.env.NASA_GRAPH_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET;
    if (!tenantId || !clientId || !clientSecret) {
        throw new Error('Microsoft Graph is not configured. Set ENTRA_TENANT_ID, NASA_GRAPH_CLIENT_ID, and NASA_GRAPH_CLIENT_SECRET on the API.');
    }
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
    });
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error_description || data.error || 'Failed to obtain Graph access token');
    }
    graphTokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    return graphTokenCache.token;
};

const lookupEntraUserIdByEmail = async (email) => {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    const token = await getGraphAccessToken();
    const escaped = normalized.replace(/'/g, "''");
    const filters = [
        `mail eq '${escaped}'`,
        `otherMails/any(m:m eq '${escaped}')`,
        `proxyAddresses/any(p:p eq 'SMTP:${escaped}')`,
        `proxyAddresses/any(p:p eq 'smtp:${escaped}')`,
    ];
    for (const filter of filters) {
        const url = `https://graph.microsoft.com/v1.0/users?$filter=${encodeURIComponent(filter)}&$select=id,mail,userPrincipalName,userType`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) continue;
        const payload = await res.json().catch(() => ({}));
        const match = (payload.value || []).find((u) => u && u.id);
        if (match) return { entraId: match.id, status: 'AlreadyExists' };
    }
    return null;
};

const sendEntraB2BInvitation = async ({ email, displayName }) => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const name = String(displayName || normalizedEmail.split('@')[0] || 'External User').trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
        throw new Error('A valid email address is required to send a Microsoft invitation.');
    }
    const token = await getGraphAccessToken();
    const redirectUrl = getNasaAppUrl();
    const inviteBody = {
        invitedUserEmailAddress: normalizedEmail,
        invitedUserDisplayName: name,
        inviteRedirectUrl: redirectUrl,
        sendInvitationMessage: true,
    };
    const customMessage = String(process.env.NASA_ENTRA_INVITE_MESSAGE || '').trim();
    if (customMessage) {
        inviteBody.invitedUserMessageInfo = {
            customizedMessageBody: customMessage.replace(/\{appUrl\}/g, redirectUrl),
        };
    }
    const res = await fetch('https://graph.microsoft.com/v1.0/invitations', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(inviteBody),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = payload?.error?.message || res.statusText || 'Invitation failed';
        if (/already exists|duplicate|already been invited|already a member/i.test(msg)) {
            const existing = await lookupEntraUserIdByEmail(normalizedEmail);
            if (existing?.entraId) {
                return {
                    entraId: existing.entraId,
                    status: existing.status || 'AlreadyExists',
                    inviteRedeemUrl: '',
                    alreadyExists: true,
                };
            }
        }
        throw new Error(msg);
    }
    return {
        entraId: payload?.invitedUser?.id || '',
        status: payload?.status || 'PendingAcceptance',
        inviteRedeemUrl: payload?.inviteRedeemUrl || '',
        alreadyExists: false,
    };
};

const shouldSendEntraInviteOnApproval = (accessRequest, user) => {
    const email = String(accessRequest.email || accessRequest.requestedLogin || '').trim().toLowerCase();
    if (!email || isInternalTenantEmail(email)) return false;
    if (user?.entraId || accessRequest.entraId) return false;
    return user?.userPartition === 'external'
        || user?.role === 'External'
        || accessRequest.userPartition === 'external';
};

const provisionEntraGuestInvitation = async (accessRequest, user) => {
    if (!shouldSendEntraInviteOnApproval(accessRequest, user)) {
        return { skipped: true, reason: 'not-external-or-already-linked' };
    }
    if (!isGraphInviteConfigured()) {
        return {
            skipped: true,
            reason: 'graph-not-configured',
            error: 'Microsoft Graph credentials are not configured on the API.',
        };
    }
    const email = String(accessRequest.email || accessRequest.requestedLogin || '').trim().toLowerCase();
    const displayName = String(accessRequest.displayName || user.displayName || email.split('@')[0] || 'External User').trim();
    const invitation = await sendEntraB2BInvitation({ email, displayName });
    return { skipped: false, ...invitation };
};

const findRecruitmentUserForEntra = async (container, { entraId, email }) => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    let users = await safeQueryAll(container, {
        query: 'SELECT * FROM c WHERE c.entraId = @entraId',
        parameters: [{ name: '@entraId', value: entraId }],
    });
    if (!users.length && normalizedEmail) {
        users = await safeQueryAll(container, {
            query: 'SELECT * FROM c WHERE LOWER(c.email) = @email',
            parameters: [{ name: '@email', value: normalizedEmail }],
        });
    }
    return users[0] || null;
};

const findAccessRequestForIdentity = async (container, { entraId, email }, status) => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (entraId) {
        const parameters = [{ name: '@entraId', value: entraId }];
        let query = 'SELECT * FROM c WHERE c.entraId = @entraId';
        if (status) {
            query += ' AND c.status = @status';
            parameters.push({ name: '@status', value: status });
        }
        const byEntra = await safeQueryAll(container, { query, parameters });
        if (byEntra.length) return byEntra[0];
    }
    if (normalizedEmail) {
        const parameters = [{ name: '@email', value: normalizedEmail }];
        let query = 'SELECT * FROM c WHERE (LOWER(c.requestedLogin) = @email OR LOWER(c.email) = @email)';
        if (status) {
            query += ' AND c.status = @status';
            parameters.push({ name: '@status', value: status });
        }
        const byEmail = await safeQueryAll(container, { query, parameters });
        if (byEmail.length) return byEmail[0];
    }
    return null;
};

const createUserFromAccessRequest = async (usersContainer, request, approval, approverUserId) => {
    const normalizedEmail = String(request.email || request.requestedLogin || '').trim().toLowerCase();
    const entraId = request.entraId || '';
    const existing = await findRecruitmentUserForEntra(usersContainer, { entraId, email: normalizedEmail });
    const allowedSiteIds = Array.isArray(approval.allowedSiteIds) && approval.allowedSiteIds.length
        ? approval.allowedSiteIds
        : (request.siteId ? [request.siteId] : []);
    const allowedStudyIds = Array.isArray(approval.allowedStudyIds) ? approval.allowedStudyIds : [];
    const externalPartner = request.userPartition === 'external'
        || (!isInternalTenantEmail(normalizedEmail) && request.userPartition !== 'internal');
    const role = approval.role || (externalPartner || entraId ? 'External' : 'coordinator');
    const partition = role === 'Internal' ? 'internal' : (externalPartner || entraId ? 'external' : 'internal');
    const usesEntraSignIn = externalPartner || !!entraId || request.authType === 'entra';
    const base = normalizeRecruitmentUserInput({
        entraId: entraId || existing?.entraId || '',
        authType: usesEntraSignIn ? 'entra' : (existing?.authType || 'local'),
        userPartition: partition,
        username: existing?.username || request.displayName || normalizedEmail.split('@')[0] || normalizedEmail || '',
        email: normalizedEmail || existing?.email || '',
        displayName: request.displayName || existing?.displayName || normalizedEmail || request.requestedLogin || '',
        role,
        allowedSiteIds,
        allowedStudyIds,
        active: true,
        testModeAccess: process.env.NASA_ENTRA_TEST_MODE === 'true' && externalPartner && !entraId,
        accessRequestId: request.id,
        approvedByUserId: approverUserId || null,
        lastUpdated: new Date().toISOString(),
    });
    if (existing) {
        const updated = normalizeRecruitmentUserInput({ ...existing, ...base, id: existing.id });
        validateUsersSchema(updated);
        const { resource } = await usersContainer.items.upsert(updated);
        return resource;
    }
    const created = normalizeRecruitmentUserInput({
        ...base,
        id: generateId(),
        password: usesEntraSignIn ? '' : randomPassword(),
        createdAt: new Date().toISOString(),
    });
    validateUsersSchema(created);
    const { resource } = await usersContainer.items.create(created);
    return resource;
};

const randomPassword = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*?';
    let out = '';
    for (let i = 0; i < 14; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
};

const isEntraGuestIdentity = (payload, email) => {
    const upn = String(payload?.preferred_username || payload?.upn || email || '').toLowerCase();
    if (upn.includes('#ext#')) return true;
    if (String(payload?.acct || '').toLowerCase() === '1') return true;
    return false;
};

const classifyEntraIdentity = (payload, email) => {
    if (isEntraGuestIdentity(payload, email)) {
        return { partition: 'external', role: 'External' };
    }
    if (isInternalTenantEmail(email)) {
        return { partition: 'internal', role: 'Internal' };
    }
    const tenantId = process.env.ENTRA_TENANT_ID || '';
    if (
        tenantId
        && payload?.tid === tenantId
        && process.env.NASA_ENTRA_AUTO_INTERNAL_MEMBERS === 'true'
    ) {
        return { partition: 'internal', role: 'Internal' };
    }
    return { partition: 'external', role: 'External' };
};

const applyEntraProfileUpdates = (user, { entraId, email, name }, classification) => {
    const updates = {};
    if (!user.entraId && entraId) updates.entraId = entraId;
    if (!user.authType) updates.authType = 'entra';
    if (!user.userPartition) {
        updates.userPartition = user.role === 'Internal'
            ? 'internal'
            : (classification?.partition || 'external');
    }
    if (email && user.email !== email) updates.email = email;
    if (name && (user.displayName || user.username) !== name) updates.displayName = name;
    if (
        classification?.partition === 'internal'
        && user.role !== 'Internal'
        && process.env.NASA_ENTRA_PROMOTE_INTERNAL_DOMAIN_USERS === 'true'
    ) {
        updates.role = 'Internal';
        updates.userPartition = 'internal';
    }
    return updates;
};

const provisionEntraUser = async (container, { entraId, email, name }, classification) => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const partition = classification?.partition || 'external';
    const role = classification?.role || (partition === 'internal' ? 'Internal' : 'External');
    const testMode = process.env.NASA_ENTRA_TEST_MODE === 'true';
    const newUser = normalizeRecruitmentUserInput({
        id: generateId(),
        entraId,
        authType: 'entra',
        userPartition: partition,
        username: normalizedEmail || entraId,
        email: normalizedEmail || '',
        displayName: name || normalizedEmail || (partition === 'internal' ? 'Internal User' : 'External User'),
        role,
        allowedSiteIds: [],
        allowedStudyIds: [],
        testModeAccess: partition === 'external' && testMode,
        active: true,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
    });
    const { resource } = await container.items.create(newUser);
    return resource;
};

const ensureBootstrapAdminUser = async (container) => {
    const email = String(process.env.NASA_BOOTSTRAP_ADMIN_EMAIL || 'mhill@oraclinical.com').trim().toLowerCase();
    const password = String(process.env.NASA_BOOTSTRAP_ADMIN_PASSWORD || 'Password1!');
    if (!email || !password) return null;
    let existing = await findRecruitmentUserForEntra(container, { entraId: '', email });
    if (existing) {
        const needsPassword = String(existing.password || '') !== password;
        const needsRole = existing.role !== 'Internal';
        if (needsPassword || needsRole || !existing.displayName) {
            const updated = normalizeRecruitmentUserInput({
                ...existing,
                password: needsPassword ? password : existing.password,
                role: 'Internal',
                userPartition: 'internal',
                authType: existing.authType || 'local',
                active: true,
            });
            const { resource } = await container.items.upsert(updated);
            return resource;
        }
        return existing;
    }
    const created = normalizeRecruitmentUserInput({
        id: generateId(),
        email,
        username: email,
        displayName: 'Bootstrap Admin',
        password,
        role: 'Internal',
        userPartition: 'internal',
        authType: 'local',
        allowedSiteIds: [],
        allowedStudyIds: [],
        active: true,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
    });
    validateUsersSchema(created);
    const { resource } = await container.items.create(created);
    return resource;
};

app.http('health', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'health',
    handler: async (request) => {
        if (request.method === 'OPTIONS') return { status: 200, headers: corsJsonHeaders };
        try {
            const container = getContainer(RECRUITMENT_USERS_CONTAINER);
            await ensureBootstrapAdminUser(container);
        } catch { /* non-fatal */ }
        return {
            jsonBody: {
                ok: true,
                app: 'NASA',
                entraConfigured: !!process.env.ENTRA_CLIENT_ID,
                graphInviteConfigured: isGraphInviteConfigured(),
                appUrl: getNasaAppUrl(),
                timestamp: new Date().toISOString(),
            },
            headers: corsJsonHeaders,
        };
    },
});

app.http('entraConfig', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'entra-config',
    handler: async (request) => {
        if (request.method === 'OPTIONS') return { status: 200, headers: corsJsonHeaders };
        const clientId = process.env.ENTRA_CLIENT_ID || '';
        return {
            jsonBody: {
                clientId,
                authority: getEntraAuthority(),
                redirectUri: getNasaAppUrl(),
                enabled: !!clientId,
                testMode: process.env.NASA_ENTRA_TEST_MODE === 'true',
                internalEmailDomains: getInternalEmailDomains(),
                partition: 'external',
            },
            headers: corsJsonHeaders,
        };
    },
});

app.http('usersAuthenticateEntra', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/authenticate-entra',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const body = await safeJson(request);
            const token = body && body.token;
            if (!token) {
                return { status: 400, jsonBody: { error: 'Token is required' }, headers: jsonHeaders };
            }
            if (!process.env.ENTRA_CLIENT_ID) {
                return { status: 503, jsonBody: { error: 'Entra ID is not configured on the server.' }, headers: jsonHeaders };
            }

            let payload;
            try {
                payload = decodeJwtPayload(token);
                validateEntraTokenClaims(payload);
            } catch (decodeError) {
                context.log('Entra token validation failed:', decodeError.message);
                return { status: 401, jsonBody: { error: 'Invalid or expired sign-in token' }, headers: jsonHeaders };
            }

            const entraId = payload.oid || payload.sub;
            const email = payload.email || payload.preferred_username || payload.upn || '';
            const name = payload.name || `${payload.given_name || ''} ${payload.family_name || ''}`.trim();
            if (!entraId) {
                return { status: 400, jsonBody: { error: 'Invalid token: missing user identifier' }, headers: jsonHeaders };
            }

            const classification = classifyEntraIdentity(payload, email);
            const container = getContainer(RECRUITMENT_USERS_CONTAINER);
            let user = await findRecruitmentUserForEntra(container, { entraId, email });
            if (user) {
                const updates = applyEntraProfileUpdates(user, { entraId, email, name }, classification);
                if (Object.keys(updates).length) {
                    const { resource } = await container.items.upsert({ ...user, ...updates, lastUpdated: new Date().toISOString() });
                    user = resource;
                }
            } else if (classification.partition === 'internal') {
                user = await provisionEntraUser(container, { entraId, email, name }, classification);
            } else {
                const requestsContainer = getContainer('access-requests');
                const pending = await findAccessRequestForIdentity(requestsContainer, { entraId, email }, 'pending');
                if (pending) {
                    return {
                        status: 403,
                        jsonBody: {
                            error: 'Access request pending manager approval.',
                            code: 'ACCESS_PENDING',
                        },
                        headers: jsonHeaders,
                    };
                }
                const denied = await findAccessRequestForIdentity(requestsContainer, { entraId, email }, 'denied');
                if (denied) {
                    return {
                        status: 403,
                        jsonBody: {
                            error: 'Access request was denied.',
                            code: 'ACCESS_DENIED',
                        },
                        headers: jsonHeaders,
                    };
                }
                if (process.env.NASA_ENTRA_TEST_MODE === 'true') {
                    user = await provisionEntraUser(container, { entraId, email, name }, classification);
                } else {
                    return {
                        status: 403,
                        jsonBody: {
                            error: 'No NASA account found. Submit an access request for manager approval.',
                            code: 'ACCESS_REQUIRED',
                            entraProfile: { entraId, email, name, partition: classification.partition },
                        },
                        headers: jsonHeaders,
                    };
                }
            }
            if (user.active === false) {
                return { status: 403, jsonBody: { error: 'User account is deactivated.' }, headers: jsonHeaders };
            }
            return { jsonBody: stripUserSecrets(user), headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Entra authentication failed');
        }
    },
});

app.http('usersAuthenticate', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/authenticate',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const body = await safeJson(request);
            const identifier = String((body && body.username) || '').trim().toLowerCase();
            const password = String((body && body.password) || '');
            if (!identifier || !password) {
                return { status: 400, jsonBody: { error: 'Username and password are required' }, headers: jsonHeaders };
            }

            const container = getContainer(RECRUITMENT_USERS_CONTAINER);
            const bootstrapEmail = String(process.env.NASA_BOOTSTRAP_ADMIN_EMAIL || 'mhill@oraclinical.com').trim().toLowerCase();
            const bootstrapPassword = String(process.env.NASA_BOOTSTRAP_ADMIN_PASSWORD || 'Password1!');
            if (identifier === bootstrapEmail && password === bootstrapPassword) {
                const bootstrapUser = await ensureBootstrapAdminUser(container);
                if (bootstrapUser) {
                    if (bootstrapUser.active === false) {
                        return { status: 403, jsonBody: { error: 'User account is deactivated.' }, headers: jsonHeaders };
                    }
                    return { jsonBody: stripUserSecrets(bootstrapUser), headers: jsonHeaders };
                }
            }

            const { resources } = await container.items.query({
                query: 'SELECT * FROM c WHERE LOWER(c.email) = @id OR LOWER(c.username) = @id',
                parameters: [{ name: '@id', value: identifier }],
            }).fetchAll();

            const user = (resources || []).find((u) => String(u.password || '') === password);
            if (!user) {
                return { status: 401, jsonBody: { error: 'Invalid username/email or password' }, headers: jsonHeaders };
            }
            if (user.active === false) {
                return { status: 403, jsonBody: { error: 'User account is deactivated.' }, headers: jsonHeaders };
            }

            return { jsonBody: stripUserSecrets(user), headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'User authentication failed');
        }
    },
});

app.http('surveys', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'surveys/{id?}',
    handler: (request, context) => crudHandler(context, request, 'surveys'),
});

app.http('recruitmentSettings', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'recruitment-settings/{id?}',
    handler: (request, context) => crudHandler(context, request, 'recruitment-settings'),
});

app.http('users', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/{id?}',
    handler: (request, context) => crudHandler(context, request, RECRUITMENT_USERS_CONTAINER),
});

const normalizeAccessRequestInput = (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const normalized = { ...data };
    if (normalized.requestedLogin != null) normalized.requestedLogin = String(normalized.requestedLogin).trim();
    if (normalized.email != null) normalized.email = String(normalized.email).trim();
    if (normalized.displayName != null) normalized.displayName = String(normalized.displayName).trim();
    if (normalized.entraId != null) normalized.entraId = String(normalized.entraId).trim();
    if (normalized.authType != null) normalized.authType = String(normalized.authType).trim();
    if (normalized.userPartition != null) normalized.userPartition = String(normalized.userPartition).trim();
    if (normalized.notes != null) normalized.notes = String(normalized.notes).trim();
    if (normalized.siteName != null) normalized.siteName = String(normalized.siteName).trim();
    if (normalized.siteId != null) normalized.siteId = String(normalized.siteId).trim();
    if (!normalized.displayName) {
        const login = normalized.requestedLogin || normalized.email || '';
        normalized.displayName = login.includes('@') ? login.split('@')[0] : login;
    }
    if (!normalized.email && normalized.requestedLogin && normalized.requestedLogin.includes('@')) {
        normalized.email = normalized.requestedLogin;
    }
    return normalized;
};

const validateAccessRequestsSchema = (data) => {
    const errors = [];
    const request = normalizeAccessRequestInput(data);
    if (!request.requestedLogin) {
        errors.push('requestedLogin is required and must be a string');
    } else if (typeof request.requestedLogin !== 'string') {
        errors.push('requestedLogin is required and must be a string');
    }
    if (!request.email || !String(request.email).includes('@')) {
        errors.push('email is required and must be a valid email address');
    }
    if (!request.displayName) {
        errors.push('displayName is required');
    }
    if (!request.siteId) {
        errors.push('siteId is required');
    }
    if (request.status && !['pending', 'approved', 'denied'].includes(request.status)) {
        errors.push('status must be one of: pending, approved, denied');
    }
    if (errors.length) throw new Error(`VALIDATION_ERROR: Access request validation failed: ${errors.join(', ')}`);
    Object.assign(data, request);
    return true;
};

app.http('accessRequestsApprove', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'access-requests/{id}/approve',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const requestContext = await resolveRequestContext(request);
            if (!requestContext.user || !userHasFullAccess(requestContext.user)) {
                return { status: 403, jsonBody: { error: 'Manager access required' }, headers: jsonHeaders };
            }
            const id = request.params && request.params.id;
            if (!id) return { status: 400, jsonBody: { error: 'Request id is required' }, headers: jsonHeaders };

            const requestsContainer = getContainer('access-requests');
            const accessRequest = await safeItemRead(requestsContainer, id);
            if (!accessRequest) return { status: 404, jsonBody: { error: 'Access request not found' }, headers: jsonHeaders };
            if ((accessRequest.status || 'pending') !== 'pending') {
                return { status: 409, jsonBody: { error: 'Access request is not pending' }, headers: jsonHeaders };
            }

            const body = await safeJson(request) || {};
            const usersContainer = getContainer(RECRUITMENT_USERS_CONTAINER);
            let user = await createUserFromAccessRequest(usersContainer, accessRequest, body, requestContext.user.id);

            let invitation = null;
            try {
                invitation = await provisionEntraGuestInvitation(accessRequest, user);
                if (invitation?.entraId && !user.entraId) {
                    const linked = normalizeRecruitmentUserInput({
                        ...user,
                        entraId: invitation.entraId,
                        authType: 'entra',
                        userPartition: user.userPartition || 'external',
                        lastUpdated: new Date().toISOString(),
                    });
                    validateUsersSchema(linked);
                    const { resource } = await usersContainer.items.upsert(linked);
                    user = resource;
                }
            } catch (inviteError) {
                invitation = {
                    skipped: false,
                    error: inviteError.message || 'Microsoft invitation failed',
                };
            }

            const updatedRequest = {
                ...accessRequest,
                status: 'approved',
                approvedAt: new Date().toISOString(),
                approvedByUserId: requestContext.user.id,
                provisionedUserId: user.id,
                role: body.role || user.role,
                allowedSiteIds: user.allowedSiteIds || [],
                allowedStudyIds: user.allowedStudyIds || [],
                entraId: user.entraId || accessRequest.entraId || invitation?.entraId || '',
                inviteStatus: invitation?.status || (invitation?.skipped ? invitation.reason : ''),
                inviteRedeemUrl: invitation?.inviteRedeemUrl || '',
                inviteError: invitation?.error || '',
            };
            const { resource: savedRequest } = await requestsContainer.items.upsert(updatedRequest);
            return {
                jsonBody: {
                    request: savedRequest,
                    user: stripUserSecrets(user),
                    invitation: invitation ? {
                        sent: !invitation.skipped && !invitation.error && !!(invitation.entraId || invitation.status),
                        skipped: !!invitation.skipped,
                        status: invitation.status || '',
                        entraId: user.entraId || invitation.entraId || '',
                        inviteRedeemUrl: invitation.inviteRedeemUrl || '',
                        error: invitation.error || '',
                        reason: invitation.reason || '',
                    } : null,
                },
                headers: jsonHeaders,
            };
        } catch (error) {
            return handleError(context, error, 'Approve access request failed');
        }
    },
});

app.http('accessRequestsDeny', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'access-requests/{id}/deny',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const requestContext = await resolveRequestContext(request);
            if (!requestContext.user || !userHasFullAccess(requestContext.user)) {
                return { status: 403, jsonBody: { error: 'Manager access required' }, headers: jsonHeaders };
            }
            const id = request.params && request.params.id;
            if (!id) return { status: 400, jsonBody: { error: 'Request id is required' }, headers: jsonHeaders };
            const requestsContainer = getContainer('access-requests');
            const accessRequest = await safeItemRead(requestsContainer, id);
            if (!accessRequest) return { status: 404, jsonBody: { error: 'Access request not found' }, headers: jsonHeaders };
            const updatedRequest = {
                ...accessRequest,
                status: 'denied',
                deniedAt: new Date().toISOString(),
                deniedByUserId: requestContext.user.id,
            };
            const { resource } = await requestsContainer.items.upsert(updatedRequest);
            return { jsonBody: { request: resource }, headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Deny access request failed');
        }
    },
});

app.http('accessRequests', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'access-requests/{id?}',
    handler: (request, context) => crudHandler(context, request, 'access-requests'),
});

// Aliases avoid Azure SWA routing POST /patients/query into patients/{id?} CRUD create.
app.http('cohortsPreview', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'cohorts/preview',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const requestContext = await resolveRequestContext(request);
            const body = await safeJson(request) || {};
            const sampleLimit = Math.min(Math.max(parseInt(body.sampleLimit, 10) || 25, 1), 100);
            const result = await queryPatients({
                ...body,
                scope: requestContext.scope,
                limit: sampleLimit,
                offset: 0,
                includeTotal: true,
            });
            return {
                jsonBody: {
                    total: result.total,
                    sample: result.items,
                    limit: sampleLimit,
                },
                headers: jsonHeaders,
            };
        } catch (error) {
            return handleError(context, error, 'Cohort preview failed');
        }
    },
});

app.http('cohortsAssign', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'cohorts/assign',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const requestContext = await resolveRequestContext(request);
            const actor = requestContext.actor;
            const body = await safeJson(request) || {};
            if (!body.studyId || !body.siteId) {
                return { status: 400, jsonBody: { error: 'studyId and siteId are required' }, headers: jsonHeaders };
            }
            const jobsContainer = getContainer('bulk-jobs');
            const job = {
                id: body.jobId || generateId(),
                type: 'cohort_assign',
                status: 'running',
                ruleId: body.ruleId || null,
                cohortId: body.cohortId || null,
                criteria: body.criteria || { logic: 'AND', conditions: [] },
                scope: requestContext.scope,
                assign: {
                    studyId: body.studyId,
                    siteId: body.siteId,
                    assignmentType: body.assignmentType === 'current' ? 'current' : 'candidate',
                    pipelineStage: body.pipelineStage || null,
                    assignedToUserId: body.assignedToUserId || null,
                    ruleId: body.ruleId || null,
                    cohortId: body.cohortId || null,
                },
                patientIds: null,
                total: 0,
                processed: 0,
                succeeded: 0,
                skipped: 0,
                failed: 0,
                errors: [],
                actor,
                startedAt: new Date().toISOString(),
                completedAt: null,
            };
            await jobsContainer.items.create(job);
            const updatedJob = await processBulkAssignBatch(job, context);
            return { status: 201, jsonBody: updatedJob, headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Cohort assign failed');
        }
    },
});

app.http('bulkJobs', {
    methods: ['GET', 'POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'bulk-jobs/{id?}',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            await requireUser(request);
            const id = request.params.id;
            const jobsContainer = getContainer('bulk-jobs');
            if (request.method === 'GET') {
                if (id) {
                    const resource = await safeItemRead(jobsContainer, id);
                    if (!resource) return { status: 404, jsonBody: { error: 'Job not found' }, headers: jsonHeaders };
                    return { jsonBody: resource, headers: jsonHeaders };
                }
                const resources = await safeQueryAll(jobsContainer, {
                    query: 'SELECT TOP 50 * FROM c ORDER BY c.startedAt DESC',
                });
                return { jsonBody: resources, headers: jsonHeaders };
            }
            return { status: 405, jsonBody: { error: 'Method Not Allowed' }, headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Bulk jobs failed');
        }
    },
});

app.http('bulkJobsContinue', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'bulk-jobs/{id}/continue',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            await requireUser(request);
            const id = request.params.id;
            const jobsContainer = getContainer('bulk-jobs');
            const job = await safeItemRead(jobsContainer, id);
            if (!job) return { status: 404, jsonBody: { error: 'Job not found' }, headers: jsonHeaders };
            if (job.status === 'completed') return { jsonBody: job, headers: jsonHeaders };
            const updatedJob = await processBulkAssignBatch(job, context);
            return { jsonBody: updatedJob, headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Bulk job continue failed');
        }
    },
});

app.http('cohortRules', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'cohort-rules/{id?}',
    handler: (request, context) => crudHandler(context, request, 'cohort-rules'),
});

const CONSENT_LINKS_CONTAINER = 'consent-links';

const publicConsentPayload = (link) => ({
    token: link.id,
    status: link.status,
    version: link.version,
    icfTitle: link.icfTitle,
    icfText: link.icfText || '',
    icfPdfUrl: link.icfPdfUrl || '',
    patientDisplayName: link.patientDisplayName || 'Participant',
    studyTitle: link.studyTitle || '',
    expiresAt: link.expiresAt || null,
    signedAt: link.signedAt || null,
});

const resolveConsentLinkStatus = (link) => {
    if (!link) return 'missing';
    if (link.status === 'signed') return 'signed';
    if (link.status === 'void') return 'void';
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) return 'expired';
    return link.status || 'pending';
};

/** Point-read with /id partition key, then cross-partition query fallback. */
const findConsentLink = async (token) => {
    if (!token) return null;
    const container = getContainer(CONSENT_LINKS_CONTAINER);
    try {
        const { resource } = await container.item(token, token).read();
        if (resource) return resource;
    } catch (error) {
        if (!isCosmosNotFound(error)) {
            // Fall through to query for partition-key mismatches; rethrow hard failures later if needed
            if (!(error.code === 400 || error.statusCode === 400)) throw error;
        }
    }
    try {
        const { resource } = await container.item(token).read();
        if (resource) return resource;
    } catch (error) {
        if (!isCosmosNotFound(error) && error.code !== 400 && error.statusCode !== 400) throw error;
    }
    const matches = await safeQueryAll(container, {
        query: 'SELECT * FROM c WHERE c.id = @id OR c.token = @id',
        parameters: [{ name: '@id', value: String(token) }],
    });
    return matches[0] || null;
};

const upsertConsentLink = async (link) => {
    const container = getContainer(CONSENT_LINKS_CONTAINER);
    const id = String(link.id);
    try {
        return await container.items.upsert(link, { partitionKey: id });
    } catch (error) {
        if (error.code === 400 || error.statusCode === 400) {
            return await container.items.upsert(link);
        }
        throw error;
    }
};

const createConsentLinkDoc = async (link) => {
    const container = getContainer(CONSENT_LINKS_CONTAINER);
    const id = String(link.id);
    try {
        return await container.items.create(link, { partitionKey: id });
    } catch (error) {
        // Older SDK / PK path variants
        if (error.code === 400 || error.statusCode === 400) {
            return await container.items.create(link);
        }
        throw error;
    }
};

const handleEconsentCreate = async (request, context) => {
    try {
        if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
        const body = await safeJson(request);
        if (!body || !body.patientId) {
            return { status: 400, jsonBody: { error: 'patientId is required' }, headers: jsonHeaders };
        }
        const version = body.version != null ? String(body.version).trim() : '';
        if (!version) {
            return { status: 400, jsonBody: { error: 'version is required' }, headers: jsonHeaders };
        }
        const hasText = !!(body.icfText && String(body.icfText).trim());
        const hasPdf = !!(body.icfPdfUrl && String(body.icfPdfUrl).trim());
        if (!hasText && !hasPdf) {
            return {
                status: 400,
                jsonBody: { error: 'Paste ICF text and/or provide an ICF PDF URL before generating a link.' },
                headers: jsonHeaders,
            };
        }

        const patients = getContainer('patients');
        const patient = await findPatientRecord(patients, String(body.patientId));
        if (!patient) {
            return { status: 404, jsonBody: { error: 'Patient not found' }, headers: jsonHeaders };
        }

        let studyTitle = '';
        if (body.studyId) {
            const study = await safeItemRead(getContainer('studies'), String(body.studyId));
            studyTitle = study?.title || study?.name || '';
        }

        const requestContext = await resolveRequestContext(request);
        const actor = requestContext?.actor;
        const first = String(patient.firstName || '').trim() || 'Participant';
        const lastInitial = String(patient.lastName || '').trim().charAt(0);
        const patientDisplayName = lastInitial ? `${first} ${lastInitial}.` : first;

        const expiresDays = Math.min(Math.max(parseInt(body.expiresInDays, 10) || 14, 1), 90);
        const token = generateConsentToken();
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString();
        const link = {
            id: token,
            token,
            patientId: patient.id,
            studyId: body.studyId || patient.currentStudyId || patient.studyId || null,
            version,
            icfTitle: String(body.icfTitle || `Informed Consent Form ${version}`).trim(),
            icfText: hasText ? String(body.icfText) : '',
            icfPdfUrl: hasPdf ? String(body.icfPdfUrl).trim() : '',
            patientDisplayName,
            studyTitle,
            status: 'pending',
            createdAt: now,
            createdBy: (actor && (actor.name || actor.upn)) || body.createdBy || 'staff',
            expiresAt,
            channel: body.channel || 'unique_link',
        };

        await wrapCosmosWrite(() => createConsentLinkDoc(link), CONSENT_LINKS_CONTAINER);

        // Verify the link is readable before handing the URL to staff
        const verify = await findConsentLink(token);
        if (!verify) {
            return {
                status: 500,
                jsonBody: {
                    error: 'Link was written but could not be re-read. Check that Cosmos container "consent-links" partition key is /id (not /patientId or /token).',
                },
                headers: jsonHeaders,
            };
        }

        const appUrl = getNasaAppUrl();
        const url = `${appUrl}/?econsent=${encodeURIComponent(token)}`;

        try {
            const auditTrail = [...(Array.isArray(patient.auditTrail) ? patient.auditTrail : []), {
                id: generateId(),
                at: now,
                action: 'econsent_link_created',
                details: `version ${link.version}; expires ${expiresAt}`,
                user: link.createdBy,
            }];
            const pendingLinks = [...(Array.isArray(patient.pendingConsentLinks) ? patient.pendingConsentLinks : []), {
                token,
                version: link.version,
                url,
                createdAt: now,
                expiresAt,
                status: 'pending',
            }].slice(-20);
            await patients.items.upsert({
                ...patient,
                auditTrail,
                pendingConsentLinks: pendingLinks,
                lastUpdated: now,
            });
        } catch (auditErr) {
            context.log.warn('eConsent patient audit failed:', auditErr.message || auditErr);
        }

        return {
            jsonBody: { ...publicConsentPayload(link), url, patientId: patient.id, createdAt: now, expiresAt },
            headers: jsonHeaders,
        };
    } catch (error) {
        return handleError(context, error, 'eConsent link create failed');
    }
};

/** Staff: create a unique patient eConsent link (ICF + signature capture). */
app.http('econsentCreateLink', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'econsent/create-link',
    handler: handleEconsentCreate,
});

/** Back-compat alias for older UI builds. */
/** Public: load ICF for a unique consent token (minimal PHI). */
app.http('econsentGetByToken', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'econsent/{token}',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const token = String(request.params.token || '').trim();
            if (!token || token.length < 16) {
                return { status: 400, jsonBody: { error: 'Invalid token' }, headers: jsonHeaders };
            }
            const link = await findConsentLink(token);
            if (!link) {
                return { status: 404, jsonBody: { error: 'Consent link not found' }, headers: jsonHeaders };
            }
            const status = resolveConsentLinkStatus(link);
            if (status === 'expired' && link.status === 'pending') {
                try {
                    await upsertConsentLink({ ...link, status: 'expired' });
                } catch { /* ignore */ }
            }
            return {
                jsonBody: { ...publicConsentPayload({ ...link, status }), status },
                headers: jsonHeaders,
            };
        } catch (error) {
            return handleError(context, error, 'eConsent get failed');
        }
    },
});

/** Public: patient signs ICF; signature + record land on the patient profile. */
app.http('econsentSignByToken', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'econsent/{token}/sign',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const token = String(request.params.token || '').trim();
            const body = await safeJson(request);
            if (!token) {
                return { status: 400, jsonBody: { error: 'Invalid token' }, headers: jsonHeaders };
            }
            if (!body || !body.signedBy || !String(body.signedBy).trim()) {
                return { status: 400, jsonBody: { error: 'signedBy (printed name) is required' }, headers: jsonHeaders };
            }
            if (!body.signatureDataUrl || typeof body.signatureDataUrl !== 'string' || !body.signatureDataUrl.startsWith('data:image')) {
                return { status: 400, jsonBody: { error: 'signatureDataUrl is required (draw signature on the pad)' }, headers: jsonHeaders };
            }
            if (body.signatureDataUrl.length > 900000) {
                return { status: 400, jsonBody: { error: 'Signature image is too large' }, headers: jsonHeaders };
            }
            if (body.acknowledged !== true) {
                return { status: 400, jsonBody: { error: 'Patient must acknowledge they read the ICF' }, headers: jsonHeaders };
            }

            const link = await findConsentLink(token);
            if (!link) {
                return { status: 404, jsonBody: { error: 'Consent link not found' }, headers: jsonHeaders };
            }
            const status = resolveConsentLinkStatus(link);
            if (status === 'signed') {
                return { status: 409, jsonBody: { error: 'This consent link was already signed' }, headers: jsonHeaders };
            }
            if (status === 'expired' || status === 'void') {
                return { status: 410, jsonBody: { error: `This consent link is ${status}` }, headers: jsonHeaders };
            }

            const patients = getContainer('patients');
            const patient = await findPatientRecord(patients, link.patientId);
            if (!patient) {
                return { status: 404, jsonBody: { error: 'Patient record not found for this link' }, headers: jsonHeaders };
            }

            const now = new Date().toISOString();
            const consentId = generateId();
            const record = {
                id: consentId,
                version: link.version,
                icfTitle: link.icfTitle,
                studyId: link.studyId || null,
                studyTitle: link.studyTitle || '',
                signedAt: now,
                signedBy: String(body.signedBy).trim(),
                obtainedBy: 'Patient (unique link)',
                status: 'signed',
                method: 'econsent_unique_link',
                channel: 'unique_link',
                linkToken: token,
                signatureDataUrl: body.signatureDataUrl,
                icfPdfUrl: link.icfPdfUrl || '',
                notes: body.notes ? String(body.notes).slice(0, 2000) : '',
            };

            const consentRecords = [...(Array.isArray(patient.consentRecords) ? patient.consentRecords : []), record];
            const auditTrail = [...(Array.isArray(patient.auditTrail) ? patient.auditTrail : []), {
                id: generateId(),
                at: now,
                action: 'econsent_signed',
                details: `version ${link.version}; method unique_link`,
                user: record.signedBy,
            }];
            const pendingConsentLinks = (Array.isArray(patient.pendingConsentLinks) ? patient.pendingConsentLinks : [])
                .map((p) => (p.token === token ? { ...p, status: 'signed', signedAt: now } : p));

            const enriched = enrichPatientDocument({
                ...patient,
                consentRecords,
                auditTrail,
                pendingConsentLinks,
                pipelineStage: 'consented',
                lastUpdated: now,
            });

            await wrapCosmosWrite(() => patients.items.upsert(enriched), 'patients');
            await wrapCosmosWrite(
                () => upsertConsentLink({
                    ...link,
                    status: 'signed',
                    signedAt: now,
                    signedBy: record.signedBy,
                    consentRecordId: consentId,
                    signatureStored: true,
                }),
                CONSENT_LINKS_CONTAINER
            );

            return {
                jsonBody: {
                    ok: true,
                    signedAt: now,
                    version: link.version,
                    message: 'Thank you. Your consent has been recorded.',
                },
                headers: jsonHeaders,
            };
        } catch (error) {
            return handleError(context, error, 'eConsent sign failed');
        }
    },
});
