const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// NASA / recruitment logins are isolated from CHAOS (`users` container on chaos-scheduler deploy).
const RECRUITMENT_USERS_CONTAINER = 'recruitment-users';

const requireUser = async () => ({ claims: null });

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

    let errorMessage;
    if (error.message.includes('COSMOS_DB_CONFIG_MISSING')) {
        errorMessage = "API Configuration Error: Database secrets not set in Azure Configuration.";
    } else if (error.message.includes('VALIDATION_ERROR')) {
        errorMessage = error.message.replace('VALIDATION_ERROR: ', '');
    } else if (error.message.includes('UNAUTHORIZED')) {
        errorMessage = error.message.replace('UNAUTHORIZED: ', '');
    } else {
        errorMessage = "Internal Server Error during data processing.";
    }

    return {
        status: error.status || 500,
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

const validateStudiesSchema = (data) => {
    const errors = [];

    const isChaosFormat = data.name && data.color && (data.requiredRoles || data.sites);

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
        
        if (data.status && !['active', 'inactive', 'completed', 'suspended'].includes(data.status.toLowerCase())) {
            errors.push('status must be one of: active, inactive, completed, suspended');
        }
        
        if (data.phase && typeof data.phase !== 'string') {
            errors.push('phase must be a string');
        }
        
        if (data.lastUpdated && typeof data.lastUpdated !== 'string') {
            errors.push('lastUpdated must be a string');
        }

        normalizeVisitProfiles(data.visitProfiles);
    } else {
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

const normalizePatientInput = (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const normalized = { ...data };
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

    if (patient.status && !['Candidate', 'Pre-Screening', 'Enrolled', 'Screen Fail', 'Completed'].includes(patient.status)) {
        errors.push('status must be one of: Candidate, Pre-Screening, Enrolled, Screen Fail, Completed');
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

    ['appointments', 'tasks', 'consentRecords', 'communications', 'waitlist', 'auditTrail', 'visitLogs', 'completedVisits'].forEach((field) => {
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
    const denorm = computePatientDenormalized(patient);
    let primaryAppointmentDate = patient.primaryAppointmentDate || null;
    const apptTime = patient.appointment?.time
        || (Array.isArray(patient.appointments) && patient.appointments.find(a => a?.time)?.time);
    if (apptTime) {
        try { primaryAppointmentDate = new Date(apptTime).toISOString().split('T')[0]; } catch { /* ignore */ }
    }
    return { ...patient, ...denorm, primaryAppointmentDate };
};

const scopeFromUserRecord = (user) => ({
    role: user?.role || '',
    allowedSiteIds: Array.isArray(user?.allowedSiteIds) ? user.allowedSiteIds : [],
    allowedStudyIds: Array.isArray(user?.allowedStudyIds) ? user.allowedStudyIds : [],
    userId: user?.id || null,
});

const patientAccessibleToScope = (patient, scope) => {
    if (!scope || scope.role === 'Internal') return true;
    const denorm = computePatientDenormalized(patient);
    const siteId = denorm.currentSiteId;
    const studyId = denorm.currentStudyId;
    const allowedSites = scope.allowedSiteIds || [];
    const allowedStudies = scope.allowedStudyIds || [];

    if (siteId || studyId) {
        if (allowedSites.length && siteId && !allowedSites.includes(siteId)) return false;
        if (allowedStudies.length && studyId && !allowedStudies.includes(studyId)) return false;
        return true;
    }

    const homeSiteId = patient.homeSiteId;
    const claimedBy = patient.claimedByUserId;
    const assignedTo = patient.assignedToUserId;
    if (allowedSites.length && homeSiteId && allowedSites.includes(homeSiteId)) return true;
    if (scope.userId && (claimedBy === scope.userId || assignedTo === scope.userId)) return true;
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

const buildScopeClause = (scope, parameters, paramIndexRef) => {
    if (!scope || scope.role === 'Internal') return { clause: '', parameters };
    const allowedSites = Array.isArray(scope.allowedSiteIds) ? scope.allowedSiteIds.filter(Boolean) : [];
    const allowedStudies = Array.isArray(scope.allowedStudyIds) ? scope.allowedStudyIds.filter(Boolean) : [];
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

    const enrolledClause = enrolledParts.length ? `(${enrolledParts.join(' AND ')})` : '';
    const leadClause = leadParts.length
        ? `((NOT IS_DEFINED(c.currentStudyId) OR c.currentStudyId = null OR c.currentStudyId = "") AND (${leadParts.join(' OR ')}))`
        : '';
    const parts = [enrolledClause, leadClause].filter(Boolean);
    if (!parts.length) return { clause: '', parameters };
    return { clause: `(${parts.join(' OR ')})`, parameters };
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

const validateUsersSchema = (data) => {
    const errors = [];
    if ((!data.displayName || typeof data.displayName !== 'string') && data.username && typeof data.username === 'string') {
        data.displayName = data.username;
    }
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
                        const { resource } = await container.item(id).read();
                        if (!resource) return { status: 404, jsonBody: { error: `${containerName} not found` } };
                        const enriched = enrichPatientDocument(resource);
                        if (!patientAccessibleToScope(enriched, requestContext?.scope)) return scopeForbiddenResponse();
                        return { jsonBody: enriched };
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
                    const { resource } = await container.item(id).read(); 
                    if (!resource) return { status: 404, jsonBody: { error: `${containerName} not found` } };
                    return { jsonBody: resource };
                } else {
                    const { resources } = await container.items.readAll().fetchAll();
                    return { jsonBody: resources };
                }
            
            case 'POST':
                const body = containerName === 'patients'
                    ? normalizePatientInput(await request.json())
                    : await request.json();
                
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
                    }
                } catch (validationError) {
                    console.error(`Validation error for ${containerName}:`, validationError.message);
                    return {
                        status: 400,
                        jsonBody: { error: validationError.message },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                
                let newItem = { ...body, id: body.id || generateId() };
                if (containerName === 'patients') {
                    newItem = enrichPatientDocument(newItem);
                    if (requestContext?.scope && !patientAccessibleToScope(newItem, requestContext.scope)) {
                        return scopeForbiddenResponse();
                    }
                }
                const { resource: createdItem } = await container.items.create(newItem);

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
                
                return { status: 201, jsonBody: createdItem };
            
            case 'PUT':
                const rawRequestBody = await request.json();
                const updateId = id || rawRequestBody.id;

                let before = null;
                try {
                    if (updateId) {
                        const readRes = await container.item(updateId).read();
                        before = readRes && readRes.resource ? readRes.resource : null;
                    }
                } catch {}

                const requestBody = containerName === 'patients'
                    ? normalizePatientInput(before ? { ...before, ...rawRequestBody, id: updateId } : { ...rawRequestBody, id: updateId })
                    : rawRequestBody;

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
                    }
                } catch (validationError) {
                    console.error(`Validation error for ${containerName}:`, validationError.message);
                    return {
                        status: 400,
                        jsonBody: { error: validationError.message },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }

                let updatedItem = { ...requestBody, id: updateId };
                if (containerName === 'patients') {
                    updatedItem = enrichPatientDocument(updatedItem);
                    if (!patientAccessibleToScope(updatedItem, requestContext?.scope)) {
                        return scopeForbiddenResponse();
                    }
                }
                const { resource: result } = await container.items.upsert(updatedItem);

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
                
                return { jsonBody: result };

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
                return { status: 204 };

            case 'OPTIONS':
                return { status: 200 };

            default:
                return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'training-types/{id?}',
    handler: (request, context) => crudHandler(context, request, 'roles'),  // Use roles container for training types
});

app.http('schedules', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'schedules/{id?}',
    handler: (request, context) => crudHandler(context, request, 'patient-schedules'),
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

app.http('users', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/{id?}',
    handler: (request, context) => crudHandler(context, request, RECRUITMENT_USERS_CONTAINER),
});

const validateAccessRequestsSchema = (data) => {
    const errors = [];
    if (!data.requestedLogin || typeof data.requestedLogin !== 'string') {
        errors.push('requestedLogin is required and must be a string');
    }
    if (data.status && !['pending', 'approved', 'denied'].includes(data.status)) {
        errors.push('status must be one of: pending, approved, denied');
    }
    if (errors.length) throw new Error(`VALIDATION_ERROR: Access request validation failed: ${errors.join(', ')}`);
    return true;
};

app.http('accessRequests', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'access-requests/{id?}',
    handler: async (request, context) => {
        const method = request.method;
        if (method === 'POST' || method === 'PUT') {
            const body = method === 'PUT' ? await safeJson(request) : await request.json();
            if (body) validateAccessRequestsSchema(body);
        }
        return crudHandler(context, request, 'access-requests');
    },
});

app.http('patientsQuery', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'patients/query',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const requestContext = await resolveRequestContext(request);
            const body = await safeJson(request) || {};
            const result = await queryPatients({ ...body, scope: requestContext.scope });
            return { jsonBody: result, headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Patient query failed');
        }
    },
});

app.http('patientsToday', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'patients/today',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const requestContext = await resolveRequestContext(request);
            const today = new Date().toISOString().split('T')[0];
            const result = await queryPatients({
                scope: requestContext.scope,
                criteria: {
                    logic: 'AND',
                    conditions: [{ field: 'primaryAppointmentDate', op: 'appointment_on_date', value: today }],
                },
                limit: 500,
                offset: 0,
                includeTotal: true,
            });
            return { jsonBody: result, headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Patients today query failed');
        }
    },
});

app.http('patientsActions', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'patients/actions',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const requestContext = await resolveRequestContext(request);
            const body = await safeJson(request) || {};
            const { action, patientId, studyId, siteId } = body;
            if (!action || !patientId) {
                return { status: 400, jsonBody: { error: 'action and patientId are required' }, headers: jsonHeaders };
            }
            const container = getContainer('patients');
            const { resource: patient } = await container.item(patientId).read();
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
        } catch (error) {
            return handleError(context, error, 'Patient action failed');
        }
    },
});

app.http('patientsReindex', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'patients/reindex',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            const requestContext = await resolveRequestContext(request);
            if (requestContext.scope && requestContext.scope.role !== 'Internal') {
                return { status: 403, jsonBody: { error: 'Internal role required' }, headers: jsonHeaders };
            }
            const body = await safeJson(request) || {};
            const limit = Math.min(parseInt(body.limit, 10) || 100, 500);
            const offset = parseInt(body.offset, 10) || 0;
            const container = getContainer('patients');
            const { resources } = await container.items.query({
                query: `SELECT * FROM c ORDER BY c._ts DESC OFFSET ${offset} LIMIT ${limit}`,
            }).fetchAll();
            let updated = 0;
            for (const p of resources || []) {
                await container.items.upsert(enrichPatientDocument(p));
                updated += 1;
            }
            return { jsonBody: { updated, offset, limit, hasMore: (resources || []).length === limit }, headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Patient reindex failed');
        }
    },
});

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
                    const { resource } = await jobsContainer.item(id).read();
                    if (!resource) return { status: 404, jsonBody: { error: 'Job not found' }, headers: jsonHeaders };
                    return { jsonBody: resource, headers: jsonHeaders };
                }
                const { resources } = await jobsContainer.items.query({
                    query: 'SELECT TOP 50 * FROM c ORDER BY c.startedAt DESC',
                }).fetchAll();
                return { jsonBody: resources || [], headers: jsonHeaders };
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
            const { resource: job } = await jobsContainer.item(id).read();
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
    handler: async (request, context) => {
        const method = request.method;
        if (method === 'POST' || method === 'PUT') {
            const body = method === 'PUT' ? await safeJson(request) : await request.json();
            if (body) validateCohortRulesSchema(body);
        }
        return crudHandler(context, request, 'cohort-rules');
    },
});

app.http('cohortMemberships', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'cohort-memberships',
    handler: async (request, context) => {
        try {
            if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
            await requireUser(request);
            const studyId = request.query.get('studyId');
            const container = getContainer('cohort-memberships');
            let resources = [];
            if (studyId) {
                const result = await container.items.query({
                    query: 'SELECT TOP 500 * FROM c WHERE c.studyId = @studyId ORDER BY c.assignedAt DESC',
                    parameters: [{ name: '@studyId', value: studyId }],
                }).fetchAll();
                resources = result.resources || [];
            } else {
                const result = await container.items.readAll().fetchAll();
                resources = (result.resources || []).slice(0, 500);
            }
            return { jsonBody: resources, headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Cohort memberships failed');
        }
    },
});
