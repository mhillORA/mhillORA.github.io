const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { jwtVerify, createRemoteJWKSet } = require('jose');

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID;
const ENTRA_API_AUDIENCE = process.env.ENTRA_API_AUDIENCE; // typically your API app's clientId or Application ID URI
const ENTRA_AUTH_DISABLED = String(process.env.ENTRA_AUTH_DISABLED || '').toLowerCase() === 'true';

// NASA / recruitment logins are isolated from CHAOS (`users` container on chaos-scheduler deploy).
const RECRUITMENT_USERS_CONTAINER = 'recruitment-users';

let jwks = null;
const getJwks = () => {
    if (!ENTRA_TENANT_ID) return null;
    if (!jwks) {
        const jwksUrl = new URL(`https://login.microsoftonline.com/${ENTRA_TENANT_ID}/discovery/v2.0/keys`);
        jwks = createRemoteJWKSet(jwksUrl);
    }
    return jwks;
};

const getBearerToken = (request) => {
    const h = request.headers && (request.headers.get ? request.headers.get('authorization') : request.headers.authorization);
    const auth = h || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return m ? m[1] : null;
};

const requireUser = async (request) => {
    if (ENTRA_AUTH_DISABLED) return { claims: null };
    if (!ENTRA_TENANT_ID || !ENTRA_API_AUDIENCE) {
        return { claims: null };
    }
    const token = getBearerToken(request);
    if (!token) {
        const err = new Error('UNAUTHORIZED: Missing bearer token');
        err.status = 401;
        throw err;
    }
    const issuer = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`;
    const { payload } = await jwtVerify(token, getJwks(), {
        issuer,
        audience: ENTRA_API_AUDIENCE,
    });
    return { claims: payload };
};

const buildActor = (claims) => ({
    oid: claims && claims.oid,
    upn: claims && (claims.preferred_username || claims.upn),
    name: claims && claims.name,
    tid: claims && claims.tid,
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

    if (data.inclusionCriteriaMet !== undefined && typeof data.inclusionCriteriaMet !== 'boolean') {
        errors.push('inclusionCriteriaMet must be a boolean');
    }
    
    if (data.exclusionCriteriaMet !== undefined && typeof data.exclusionCriteriaMet !== 'boolean') {
        errors.push('exclusionCriteriaMet must be a boolean');
    }

    ['appointments', 'tasks', 'consentRecords', 'communications', 'waitlist', 'auditTrail', 'visitLogs', 'completedVisits'].forEach((field) => {
        if (data[field] !== undefined && !Array.isArray(data[field])) {
            errors.push(`${field} must be an array`);
        }
    });

    if (data.pipelineStage !== undefined && typeof data.pipelineStage !== 'string') {
        errors.push('pipelineStage must be a string');
    }
    if (data.eligibilityStatus !== undefined && typeof data.eligibilityStatus !== 'string') {
        errors.push('eligibilityStatus must be a string');
    }
    if (data.doNotContact !== undefined && typeof data.doNotContact !== 'boolean') {
        errors.push('doNotContact must be a boolean');
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
    if (data.entraOid !== undefined && data.entraOid !== null && typeof data.entraOid !== 'string') {
        errors.push('entraOid must be a string');
    }
    if (data.entraId !== undefined && data.entraId !== null && typeof data.entraId !== 'string') {
        errors.push('entraId must be a string');
    }
    if (data.role !== undefined && data.role !== null && typeof data.role !== 'string') {
        errors.push('role must be a string');
    }
    if (data.allowedSiteIds !== undefined && data.allowedSiteIds !== null && !Array.isArray(data.allowedSiteIds)) {
        errors.push('allowedSiteIds must be an array');
    }
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Users validation failed: ${errors.join(', ')}`);
    }
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
        const user = (method === 'OPTIONS') ? { claims: null } : await requireUser(request);
        const actor = buildActor(user.claims);

        switch (method) {
            case 'GET':
                if (id) {
                    const { resource } = await container.item(id).read(); 
                    if (!resource) return { status: 404, jsonBody: { error: `${containerName} not found` } };
                    return { jsonBody: resource };
                } else {
                    const { resources } = await container.items.readAll().fetchAll();
                    return { jsonBody: resources };
                }
            
            case 'POST':
                const body = await request.json();
                
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
                
                if (containerName === RECRUITMENT_USERS_CONTAINER) {
                    if (body.entraId && !body.entraOid) body.entraOid = body.entraId;
                    if (body.entraOid && !body.entraId) body.entraId = body.entraOid;
                }

                const newItem = { ...body, id: body.id || generateId() };
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
                const requestBody = await request.json();
                const updateId = id || requestBody.id;

                let before = null;
                try {
                    if (updateId) {
                        const readRes = await container.item(updateId).read();
                        before = readRes && readRes.resource ? readRes.resource : null;
                    }
                } catch {}
                
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

                if (containerName === RECRUITMENT_USERS_CONTAINER) {
                    if (requestBody.entraId && !requestBody.entraOid) requestBody.entraOid = requestBody.entraId;
                    if (requestBody.entraOid && !requestBody.entraId) requestBody.entraId = requestBody.entraOid;
                }
                
                const updatedItem = { ...requestBody, id: updateId };
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

const findUserByEntraOid = async (container, entraOid) => {
    const { resources } = await container.items.query({
        query: 'SELECT * FROM c WHERE c.entraOid = @oid OR c.entraId = @oid',
        parameters: [{ name: '@oid', value: entraOid }],
    }).fetchAll();
    return resources && resources[0] ? resources[0] : null;
};

const verifyEntraIdToken = async (token) => {
    const spaClientId = process.env.ENTRA_CLIENT_ID || process.env.ENTRA_SPA_CLIENT_ID || '';
    if (!ENTRA_TENANT_ID || (!spaClientId && !ENTRA_API_AUDIENCE)) {
        const err = new Error('UNAUTHORIZED: Entra ID is not configured on the API');
        err.status = 503;
        throw err;
    }
    const issuer = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`;
    const audiences = [spaClientId, ENTRA_API_AUDIENCE].filter(Boolean);
    let lastError = null;
    for (const audience of audiences) {
        try {
            const { payload } = await jwtVerify(token, getJwks(), { issuer, audience });
            return payload;
        } catch (e) {
            lastError = e;
        }
    }
    const err = new Error(`UNAUTHORIZED: ${lastError && lastError.message ? lastError.message : 'Invalid token'}`);
    err.status = 401;
    throw err;
};

app.http('entraConfig', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'entra-config',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') return { status: 200, headers: jsonHeaders };
        const clientId = process.env.ENTRA_CLIENT_ID || process.env.ENTRA_SPA_CLIENT_ID || '';
        const tenantId = ENTRA_TENANT_ID || '';
        const authority = tenantId
            ? `https://login.microsoftonline.com/${tenantId}`
            : 'https://login.microsoftonline.com/common';
        return {
            jsonBody: {
                clientId,
                tenantId,
                authority,
                enabled: !!(clientId && tenantId),
            },
            headers: jsonHeaders,
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

            const payload = await verifyEntraIdToken(token);
            const entraOid = payload.oid || payload.sub;
            const email = payload.email || payload.preferred_username || payload.upn || '';
            const name = payload.name || `${payload.given_name || ''} ${payload.family_name || ''}`.trim();

            if (!entraOid) {
                return { status: 400, jsonBody: { error: 'Invalid token: missing user identifier' }, headers: jsonHeaders };
            }

            const container = getContainer(RECRUITMENT_USERS_CONTAINER);
            let user = await findUserByEntraOid(container, entraOid);

            if (!user) {
                return {
                    status: 403,
                    jsonBody: {
                        error: 'No NASA account is linked to this Microsoft sign-in. Ask a manager to add your Entra Object ID in Manager → Users.',
                        entraOid,
                        email,
                    },
                    headers: jsonHeaders,
                };
            }

            const updates = {};
            if (email && user.email !== email) updates.email = email;
            if (name && user.displayName !== name) updates.displayName = name;
            if (!user.entraOid) updates.entraOid = entraOid;
            if (!user.entraId) updates.entraId = entraOid;

            if (Object.keys(updates).length > 0) {
                const updated = { ...user, ...updates, lastUpdated: new Date().toISOString() };
                const { resource } = await container.items.upsert(updated);
                user = resource;
            }

            if (user.active === false) {
                return { status: 403, jsonBody: { error: 'User account is deactivated.' }, headers: jsonHeaders };
            }

            return { jsonBody: stripUserSecrets(user), headers: jsonHeaders };
        } catch (error) {
            return handleError(context, error, 'Entra ID authentication failed');
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
