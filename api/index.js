const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

// Node.js 18+ has fetch built-in, no polyfill needed

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

// Cosmos often returns 404 / Owner resource does not exist when a container was never created
const isLikelyMissingCosmosContainer = (error) => {
    const code = error.code || error.statusCode;
    const msg = String(error.message || '');
    return (
        code === 404 ||
        /Owner resource does not exist/i.test(msg) ||
        (/not found/i.test(msg) && /container/i.test(msg))
    );
};

// Helper function to handle errors
const handleError = (context, error, message) => {
    context.log.error(`${message}:`, error.message);
    context.log.error(`Stack:`, error.stack);

    let errorMessage;
    let status = 500;
    if (error.message.includes('COSMOS_DB_CONFIG_MISSING')) {
        errorMessage = "API Configuration Error: Database secrets not set in Azure Configuration.";
    } else if (error.message.includes('VALIDATION_ERROR')) {
        errorMessage = error.message.replace('VALIDATION_ERROR: ', '');
        status = 400;
    } else if (isLikelyMissingCosmosContainer(error)) {
        // e.g. GET /api/site-staff returns [] but POST fails until container exists
        const hint = message.includes('site-staff')
            ? " Create a Cosmos container named `site-staff` with partition key `/id` (same `DATABASE_ID` as other Artemis data). PI and Coordinator share this container; use field `role`: `pi` or `coordinator`."
            : ' Ensure the Cosmos container for this API route exists with partition key `/id`.';
        errorMessage = `Database container missing or not accessible: ${error.message || 'Cosmos error'}.${hint}`;
        status = 503;
    } else {
        errorMessage = "Internal Server Error during data processing.";
    }

    return {
        status,
        jsonBody: { error: errorMessage },
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

// =================================================================================
// SCHEMA VALIDATION FUNCTIONS
// =================================================================================

const validateStudiesSchema = (data) => {
    const errors = [];
    
    // Debug logging
    console.log('Validating study data:', JSON.stringify(data, null, 2));
    
    // Check if this is CHAOS format (has name, color, requiredRoles, sites)
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
        
        if (data.status && !['active', 'inactive', 'completed', 'suspended'].includes(data.status.toLowerCase())) {
            errors.push('status must be one of: active, inactive, completed, suspended');
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

    const mailingFields = ['mailingAddress1', 'mailingAddress2', 'mailingCity', 'mailingState', 'mailingZipCode', 'mailingCountry'];
    mailingFields.forEach((field) => {
        if (data[field] !== undefined && data[field] !== null && typeof data[field] !== 'string') {
            errors.push(`${field} must be a string`);
        }
    });
    
    // PI fields are optional (legacy string fields)
    if (data.pi !== undefined && data.pi !== null && typeof data.pi !== 'string') {
        errors.push('pi must be a string');
    }
    
    if (data.piEmail !== undefined && data.piEmail !== null && typeof data.piEmail !== 'string') {
        errors.push('piEmail must be a string');
    }

    const optionalPiFields = ['pi2Name', 'pi2Email', 'pi3Name', 'pi3Email'];
    optionalPiFields.forEach((field) => {
        if (data[field] !== undefined && data[field] !== null && typeof data[field] !== 'string') {
            errors.push(`${field} must be a string`);
        }
    });
    
    // Coordinator fields are optional (legacy string fields)
    if (data.siteCoordinator !== undefined && data.siteCoordinator !== null && typeof data.siteCoordinator !== 'string') {
        errors.push('siteCoordinator must be a string');
    }
    
    if (data.siteCoordinatorEmail !== undefined && data.siteCoordinatorEmail !== null && typeof data.siteCoordinatorEmail !== 'string') {
        errors.push('siteCoordinatorEmail must be a string');
    }

    const optionalCoordFields = [
        'siteCoordinator2Name',
        'siteCoordinator2Email',
        'siteCoordinator3Name',
        'siteCoordinator3Email',
    ];
    optionalCoordFields.forEach((field) => {
        if (data[field] !== undefined && data[field] !== null && typeof data[field] !== 'string') {
            errors.push(`${field} must be a string`);
        }
    });
    
    // New relational staff references (optional)
    if (data.piStaffId !== undefined && data.piStaffId !== null && typeof data.piStaffId !== 'string') {
        errors.push('piStaffId must be a string');
    }
    if (data.coordinatorStaffId !== undefined && data.coordinatorStaffId !== null && typeof data.coordinatorStaffId !== 'string') {
        errors.push('coordinatorStaffId must be a string');
    }

    if (data.indication && !Array.isArray(data.indication)) {
        errors.push('indication must be an array');
    }
    
    if (data.status && !['Active', 'Inactive', 'Suspended'].includes(data.status)) {
        errors.push('status must be one of: Active, Inactive, Suspended');
    }
    
    // Latitude and longitude are optional - only validate if provided and not null
    if (data.latitude !== undefined && data.latitude !== null && (typeof data.latitude !== 'number' || data.latitude < -90 || data.latitude > 90)) {
        errors.push('latitude must be a number between -90 and 90');
    }
    
    if (data.longitude !== undefined && data.longitude !== null && (typeof data.longitude !== 'number' || data.longitude < -180 || data.longitude > 180)) {
        errors.push('longitude must be a number between -180 and 180');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Sites validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateSiteStaffSchema = (data) => {
    const errors = [];
    if (!data.siteId || typeof data.siteId !== 'string') errors.push('siteId is required and must be a string');
    if (!data.role || typeof data.role !== 'string') errors.push('role is required and must be a string');
    const role = String(data.role || '').toLowerCase();
    if (role && !['pi', 'coordinator'].includes(role)) errors.push('role must be one of: pi, coordinator');
    if (data.name !== undefined && data.name !== null && typeof data.name !== 'string') errors.push('name must be a string');
    if (data.email !== undefined && data.email !== null && typeof data.email !== 'string') errors.push('email must be a string');
    if (data.entraId !== undefined && data.entraId !== null && typeof data.entraId !== 'string') errors.push('entraId must be a string');
    if (data.studyIds !== undefined && !Array.isArray(data.studyIds)) errors.push('studyIds must be an array');
    if (errors.length > 0) throw new Error(`VALIDATION_ERROR: SiteStaff validation failed: ${errors.join(', ')}`);
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

// ARTEMIS Site/Staff Surveys (PI/Coordinator) - Definitions, Assignments (unique links), Responses
const normalizeSurveyAudience = (audience) => {
    const out = [];
    const seen = new Set();
    for (const raw of (Array.isArray(audience) ? audience : [])) {
        const key = String(raw || '').trim().toLowerCase();
        let label = null;
        if (key === 'pi' || key === 'principal investigator' || key === 'investigator') label = 'PI';
        else if (key === 'coordinator' || key === 'crc' || key === 'study coordinator') label = 'Coordinator';
        else if (String(raw || '').trim()) label = String(raw).trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push(label);
    }
    return out.length ? out : ['PI', 'Coordinator'];
};

const validateSurveyDefinitionsSchema = (data) => {
    const errors = [];
    if (!data.title || typeof data.title !== 'string') errors.push('title is required and must be a string');
    if (!data.audience || !Array.isArray(data.audience) || data.audience.length === 0) errors.push('audience is required and must be a non-empty array');
    if (!data.questions || !Array.isArray(data.questions) || data.questions.length === 0) errors.push('questions is required and must be a non-empty array');
    if (data.status && !['draft', 'active', 'archived'].includes(String(data.status).toLowerCase())) errors.push('status must be one of: draft, active, archived');
    if (data.defaultValues && typeof data.defaultValues !== 'object') errors.push('defaultValues must be an object');
    if (data.passThreshold != null) {
        const n = Number(data.passThreshold);
        if (!Number.isFinite(n) || n < 0 || n > 100) errors.push('passThreshold must be a number 0–100');
        else data.passThreshold = n;
    }
    if (data.borderlineThreshold != null) {
        const n = Number(data.borderlineThreshold);
        if (!Number.isFinite(n) || n < 0 || n > 100) errors.push('borderlineThreshold must be a number 0–100');
        else data.borderlineThreshold = n;
    }
    if (data.scoring && typeof data.scoring === 'object') {
        if (data.passThreshold == null && data.scoring.passThreshold != null) {
            const n = Number(data.scoring.passThreshold);
            if (Number.isFinite(n)) data.passThreshold = n;
        }
        if (data.borderlineThreshold == null && data.scoring.borderlineThreshold != null) {
            const n = Number(data.scoring.borderlineThreshold);
            if (Number.isFinite(n)) data.borderlineThreshold = n;
        }
    }
    if (errors.length > 0) throw new Error(`VALIDATION_ERROR: SurveyDefinitions validation failed: ${errors.join(', ')}`);
    data.audience = normalizeSurveyAudience(data.audience);
    if (data.isPredefined != null) data.isPredefined = Boolean(data.isPredefined);
    return true;
};

const validateSurveyAssignmentsSchema = (data) => {
    const errors = [];
    if (!data.surveyId || typeof data.surveyId !== 'string') errors.push('surveyId is required and must be a string');
    if (!data.siteId || typeof data.siteId !== 'string') errors.push('siteId is required and must be a string');
    if (!data.targetRole || typeof data.targetRole !== 'string') errors.push('targetRole is required and must be a string');
    if (data.targetEmail && typeof data.targetEmail !== 'string') errors.push('targetEmail must be a string');
    if (data.status && !['sent', 'opened', 'submitted', 'closed', 'revoked'].includes(String(data.status).toLowerCase())) {
        errors.push('status must be one of: sent, opened, submitted, closed, revoked');
    }
    if (errors.length > 0) throw new Error(`VALIDATION_ERROR: SurveyAssignments validation failed: ${errors.join(', ')}`);
    return true;
};

const validateSurveyResponsesSchema = (data) => {
    const errors = [];
    if (!data.assignmentId || typeof data.assignmentId !== 'string') errors.push('assignmentId is required and must be a string');
    if (!data.surveyId || typeof data.surveyId !== 'string') errors.push('surveyId is required and must be a string');
    if (!data.siteId || typeof data.siteId !== 'string') errors.push('siteId is required and must be a string');
    if (!data.targetRole || typeof data.targetRole !== 'string') errors.push('targetRole is required and must be a string');
    if (!data.answers || !Array.isArray(data.answers)) errors.push('answers is required and must be an array');
    if (data.entraId && typeof data.entraId !== 'string') errors.push('entraId must be a string');
    if (data.email && typeof data.email !== 'string') errors.push('email must be a string');
    if (data.displayName && typeof data.displayName !== 'string') errors.push('displayName must be a string');
    if (errors.length > 0) throw new Error(`VALIDATION_ERROR: SurveyResponses validation failed: ${errors.join(', ')}`);
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
    
    if (data.status && !['pending', 'approved', 'rejected'].includes(data.status)) {
        errors.push('status must be one of: pending, approved, rejected');
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
                        return { jsonBody: resources };
                    } catch (error) {
                        // If container doesn't exist yet, return empty array
                        // Cosmos DB errors can have different formats:
                        // - error.code === 404
                        // - error.statusCode === 404
                        // - error.message includes 'NotFound', 'Container', or 'not found'
                        const errorCode = error.code || error.statusCode;
                        const errorMessage = (error.message || '').toLowerCase();
                        
                        // For travel container specifically, always return empty array on any error
                        // This prevents launch failures
                        if (containerName === 'travel') {
                            context.log.warn(`Travel container does not exist yet or error occurred, returning empty array. Error: ${error.message}`);
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
                        case 'patient-schedules':
                            validateSchedulesSchema(body);
                            // Validate site-study relationship
                            await validateSiteStudyRelationship(body.siteId, body.studyId);
                            break;
                        case 'surveys':
                            validateSurveysSchema(body);
                            break;
                        case 'site-staff':
                            validateSiteStaffSchema(body);
                            break;
                        case 'site-survey-definitions':
                            validateSurveyDefinitionsSchema(body);
                            break;
                        case 'site-survey-assignments':
                            validateSurveyAssignmentsSchema(body);
                            break;
                        case 'site-survey-responses':
                            validateSurveyResponsesSchema(body);
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
                const { resource: createdItem } = await container.items.create(newItem);
                
                // Calculate enrollment for studies
                if (containerName === 'studies') {
                    const enrollment = await calculateStudyEnrollment(createdItem.id);
                    createdItem.enrolled = enrollment;
                }
                
                return { status: 201, jsonBody: createdItem };
            
            case 'PUT':
                const requestBody = await request.json();
                const updateId = id || requestBody.id;
                
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
                            validateUsersSchema(requestBody);
                            // Hash password if provided
                            if (requestBody.password) {
                                requestBody.password = hashPassword(requestBody.password);
                            }
                            break;
                        case 'schedules':
                        case 'patient-schedules':
                            validateSchedulesSchema(requestBody);
                            // Validate site-study relationship
                            await validateSiteStudyRelationship(requestBody.siteId, requestBody.studyId);
                            break;
                        case 'surveys':
                            validateSurveysSchema(requestBody);
                            break;
                        case 'site-staff':
                            validateSiteStaffSchema(requestBody);
                            break;
                        case 'site-survey-definitions':
                            validateSurveyDefinitionsSchema(requestBody);
                            break;
                        case 'site-survey-assignments':
                            validateSurveyAssignmentsSchema(requestBody);
                            break;
                        case 'site-survey-responses':
                            validateSurveyResponsesSchema(requestBody);
                            break;
                        case 'time-off-requests':
                            validateTimeOffRequestsSchema(requestBody);
                            break;
                        case 'travel':
                            validateTravelSchema(requestBody);
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
                
                const updatedItem = { ...requestBody, id: updateId };
                const { resource: result } = await container.items.upsert(updatedItem);
                
                // Calculate enrollment for studies
                if (containerName === 'studies') {
                    const enrollment = await calculateStudyEnrollment(result.id);
                    result.enrolled = enrollment;
                }
                
                return { jsonBody: result };

            case 'DELETE':
                if (!id) return { status: 400, jsonBody: { error: 'id is required' } };
                try {
                    // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                    const { resource } = await container.item(id, id).read();
                    if (!resource) {
                        // Treat missing as already deleted
                        return { status: 204 };
                    }
                } catch (e) {
                    // If read fails (e.g., not found), return 204 for idempotency
                    return { status: 204 };
                }
                // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                await container.item(id, id).delete();
                return { status: 204 };

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
    // Back-compat route: keep /schedules, store in patient-schedules
    handler: (request, context) => crudHandler(context, request, 'patient-schedules'),
});

app.http('patientSchedules', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'patient-schedules/{id?}',
    handler: (request, context) => crudHandler(context, request, 'patient-schedules'),
});

app.http('surveys', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'surveys/{id?}',
    handler: (request, context) => crudHandler(context, request, 'surveys'),
});

app.http('siteStaff', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'site-staff/{id?}',
    handler: (request, context) => crudHandler(context, request, 'site-staff'),
});

app.http('surveyDefinitions', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'site-survey-definitions/{id?}',
    handler: (request, context) => crudHandler(context, request, 'site-survey-definitions'),
});

const {
    redactAssignment,
    attachInviteToken,
    buildInviteUrl,
    registerSurveySecureRoutes,
} = require('./survey-secure-routes');
const { writeSurveyResponse: writeSiteSurveyResponse } = require('./lib/survey-response-service');

function jsonHeaders() {
    const allowed = (process.env.SURVEY_CORS_ORIGINS || process.env.STATIC_WEB_APP_URL || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const origin = allowed.length === 1 ? allowed[0] : '*';
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Artemis-Operator',
        'Cache-Control': 'no-store',
    };
}

function sortByIsoDesc(rows, keys) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    const fields = Array.isArray(keys) ? keys : [keys];
    list.sort((a, b) => {
        const av = fields.map((k) => a?.[k]).find(Boolean) || '';
        const bv = fields.map((k) => b?.[k]).find(Boolean) || '';
        return String(bv).localeCompare(String(av));
    });
    return list;
}

function readQueryParam(request, name) {
    if (request.query && typeof request.query.get === 'function') return request.query.get(name);
    if (request.query) return request.query[name];
    return null;
}

app.http('surveyAssignments', {
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'site-survey-assignments/{id?}',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return { status: 204, headers: jsonHeaders() };
        }

        // Filtered reads: /site-survey-assignments?siteId=...&surveyId=...&status=...
        if (request.method === 'GET') {
            const id = getIdFromRequest(request);
            if (!id) {
                const siteId = readQueryParam(request, 'siteId');
                const surveyId = readQueryParam(request, 'surveyId');
                const status = readQueryParam(request, 'status');

                if (siteId || surveyId || status) {
                    try {
                        const container = getContainer('site-survey-assignments');
                        const where = [];
                        const parameters = [];
                        if (siteId) { where.push('c.siteId = @siteId'); parameters.push({ name: '@siteId', value: String(siteId) }); }
                        if (surveyId) { where.push('c.surveyId = @surveyId'); parameters.push({ name: '@surveyId', value: String(surveyId) }); }
                        if (status) { where.push('LOWER(c.status) = @status'); parameters.push({ name: '@status', value: String(status).toLowerCase() }); }

                        const query = {
                            query: `SELECT * FROM c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
                                .replace(/\s+/g, ' ')
                                .trim(),
                            parameters
                        };

                        const { resources } = await container.items
                            .query(query, { enableCrossPartitionQuery: true })
                            .fetchAll();
                        return {
                            jsonBody: sortByIsoDesc(resources || [], ['createdAt', '_ts']).map(redactAssignment),
                            headers: jsonHeaders(),
                        };
                    } catch (error) {
                        return handleError(context, error, 'Query site-survey-assignments');
                    }
                }
            } else {
                // Single assignment — never expose tokenHash
                try {
                    const container = getContainer('site-survey-assignments');
                    const read = await container.item(id, id).read();
                    if (!read.resource) {
                        return { status: 404, jsonBody: { error: 'Assignment not found' }, headers: jsonHeaders() };
                    }
                    return { jsonBody: redactAssignment(read.resource), headers: jsonHeaders() };
                } catch (error) {
                    if (error.code === 404 || error.statusCode === 404) {
                        return { status: 404, jsonBody: { error: 'Assignment not found' }, headers: jsonHeaders() };
                    }
                    return handleError(context, error, 'Get site-survey-assignments');
                }
            }
        }

        if (request.method === 'POST') {
            try {
                const body = await request.json();
                if (!body.status) body.status = 'sent';
                if (!body.createdAt) body.createdAt = new Date().toISOString();
                body.updatedAt = new Date().toISOString();
                body.allowResubmit = body.allowResubmit !== false;
                if (!body.id) body.id = generateId();

                // Mint opaque invite token (raw returned once; hash stored)
                const baseUrl = body.baseUrl ? String(body.baseUrl).replace(/\/$/, '') : '';
                const { raw, inviteUrl } = attachInviteToken(body, {
                    expiresInDays: body.expiresInDays,
                    baseUrl: baseUrl || undefined,
                });
                delete body.baseUrl;
                delete body.expiresInDays;
                delete body.tokenRaw;
                delete body.inviteToken;

                validateSurveyAssignmentsSchema(body);
                const container = getContainer('site-survey-assignments');
                const { resource } = await container.items.create(body);
                const safe = redactAssignment(resource);
                return {
                    status: 201,
                    jsonBody: {
                        ...safe,
                        inviteUrl: inviteUrl || (baseUrl ? buildInviteUrl(baseUrl, raw) : null),
                        inviteToken: raw,
                    },
                    headers: jsonHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'Create site-survey-assignments');
            }
        }

        // Merge PUT/PATCH so status updates (opened/submitted) cannot wipe required fields
        if (request.method === 'PUT' || request.method === 'PATCH') {
            const id = getIdFromRequest(request);
            if (id) {
                try {
                    const container = getContainer('site-survey-assignments');
                    let existing = null;
                    try {
                        const read = await container.item(id, id).read();
                        existing = read.resource;
                    } catch (_) {
                        existing = null;
                    }
                    if (!existing) {
                        return { status: 404, jsonBody: { error: 'Assignment not found' }, headers: jsonHeaders() };
                    }
                    const body = await request.json();
                    // Public clients must not rotate or clear invite secrets via PATCH
                    delete body.tokenHash;
                    delete body.tokenPrefix;
                    delete body.tokenRaw;
                    delete body.inviteToken;
                    delete body.inviteUrl;
                    const merged = {
                        ...existing,
                        ...body,
                        id: existing.id,
                        surveyId: existing.surveyId,
                        siteId: existing.siteId,
                        targetRole: body.targetRole || existing.targetRole,
                        tokenHash: existing.tokenHash,
                        tokenPrefix: existing.tokenPrefix,
                        expiresAt: existing.expiresAt || body.expiresAt,
                        updatedAt: new Date().toISOString(),
                    };
                    // Never reopen a submitted assignment via an "opened" ping
                    if (String(existing.status || '').toLowerCase() === 'submitted') {
                        merged.status = 'submitted';
                        merged.submittedAt = existing.submittedAt || merged.submittedAt;
                    }
                    validateSurveyAssignmentsSchema(merged);
                    const { resource } = await container.items.upsert(merged);
                    return { jsonBody: redactAssignment(resource), headers: jsonHeaders() };
                } catch (error) {
                    return handleError(context, error, 'Update site-survey-assignments');
                }
            }
        }

        const result = await crudHandler(context, request, 'site-survey-assignments');
        if (result?.jsonBody) {
            if (Array.isArray(result.jsonBody)) {
                result.jsonBody = result.jsonBody.map(redactAssignment);
            } else if (result.jsonBody.id) {
                result.jsonBody = redactAssignment(result.jsonBody);
            }
        }
        return result;
    },
});

app.http('surveyResponses', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'site-survey-responses/{id?}',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return { status: 204, headers: jsonHeaders() };
        }

        // Filtered reads: /site-survey-responses?siteId=...&assignmentId=...&surveyId=...
        if (request.method === 'GET') {
            const id = getIdFromRequest(request);
            if (!id) {
                const siteId = readQueryParam(request, 'siteId');
                const assignmentId = readQueryParam(request, 'assignmentId');
                const surveyId = readQueryParam(request, 'surveyId');
                const targetRole = readQueryParam(request, 'targetRole');

                if (siteId || assignmentId || surveyId || targetRole) {
                    try {
                        const container = getContainer('site-survey-responses');
                        const where = [];
                        const parameters = [];
                        if (siteId) { where.push('c.siteId = @siteId'); parameters.push({ name: '@siteId', value: String(siteId) }); }
                        if (assignmentId) { where.push('c.assignmentId = @assignmentId'); parameters.push({ name: '@assignmentId', value: String(assignmentId) }); }
                        if (surveyId) { where.push('c.surveyId = @surveyId'); parameters.push({ name: '@surveyId', value: String(surveyId) }); }
                        if (targetRole) { where.push('LOWER(c.targetRole) = @targetRole'); parameters.push({ name: '@targetRole', value: String(targetRole).toLowerCase() }); }

                        const query = {
                            query: `SELECT * FROM c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
                                .replace(/\s+/g, ' ')
                                .trim(),
                            parameters
                        };

                        const { resources } = await container.items
                            .query(query, { enableCrossPartitionQuery: true })
                            .fetchAll();
                        return {
                            jsonBody: sortByIsoDesc(resources || [], ['submittedAt', 'createdAt']),
                            headers: jsonHeaders(),
                        };
                    } catch (error) {
                        return handleError(context, error, 'Query site-survey-responses');
                    }
                }
            }
        }

        if (request.method === 'POST') {
            try {
                const body = await request.json();
                if (!body.assignmentId) {
                    return { status: 400, jsonBody: { error: 'assignmentId is required' }, headers: jsonHeaders() };
                }

                let assignment = null;
                try {
                    const asgC = getContainer('site-survey-assignments');
                    const read = await asgC.item(body.assignmentId, body.assignmentId).read();
                    assignment = read.resource;
                } catch (_) {
                    assignment = null;
                }
                if (!assignment) {
                    return { status: 400, jsonBody: { error: 'Assignment not found' }, headers: jsonHeaders() };
                }

                const result = await writeSiteSurveyResponse(
                    { getContainer, generateId, validateSurveyResponsesSchema },
                    {
                        assignment,
                        answers: Array.isArray(body.answers) ? body.answers : [],
                        email: body.email,
                        displayName: body.displayName,
                        isDraft: false,
                    }
                );

                return {
                    status: result.created ? 201 : 200,
                    jsonBody: { ...result.resource, resubmitted: result.resubmitted },
                    headers: jsonHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'Create site-survey-responses');
            }
        }

        return crudHandler(context, request, 'site-survey-responses');
    },
});

app.http('travel', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'travel/{id?}',
    handler: (request, context) => crudHandler(context, request, 'travel'),
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
                    
                    validateTimeOffRequestsSchema(body);
                    
                    // Set default status to pending if not provided
                    const newRequest = { 
                        ...body,
                        date: body.date || body.startDate, // Ensure date is set
                        startDate: body.startDate || body.date, // Also include startDate for compatibility
                        endDate: body.endDate || body.date, // Use endDate if provided, otherwise use date
                        id: generateId(),
                        status: body.status || 'pending',
                        createdAt: new Date().toISOString(),
                        requestedBy: body.requestedBy || null,
                        approvedBy: null,
                        approvedAt: null
                    };
                    const { resource: createdRequest } = await container.items.create(newRequest);
                    return { status: 201, jsonBody: createdRequest };
                
                case 'PUT':
                    const requestBody = await request.json();
                    const updateId = id || requestBody.id;
                    validateTimeOffRequestsSchema(requestBody);
                    
                    // If status is being changed to approved, set approvedBy and approvedAt
                    if (requestBody.status === 'approved' && !requestBody.approvedBy) {
                        requestBody.approvedAt = new Date().toISOString();
                    }
                    
                    const updatedRequest = { ...requestBody, id: updateId };
                    const { resource: result } = await container.items.upsert(updatedRequest);
                    return { jsonBody: result };

                case 'DELETE':
                    if (!id) return { status: 400, jsonBody: { error: 'id is required' } };
                    try {
                        // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                        const { resource } = await container.item(id, id).read();
                        if (!resource) {
                            return { status: 204 };
                        }
                    } catch (e) {
                        return { status: 204 };
                    }
                    // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                    await container.item(id, id).delete();
                    return { status: 204 };

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

const headerGet = (request, name) => {
    try {
        if (request.headers && typeof request.headers.get === 'function') {
            return request.headers.get(name) || request.headers.get(name.toLowerCase()) || '';
        }
    } catch (_) { /* ignore */ }
    return '';
};

const claimMapFromPrincipal = (raw) => {
    const map = {};
    const claims = Array.isArray(raw?.claims) ? raw.claims : [];
    for (const c of claims) {
        if (!c || c.typ == null) continue;
        map[c.typ] = c.val;
        const short = String(c.typ).split('/').pop();
        if (short && map[short] == null) map[short] = c.val;
    }
    return map;
};

/** Prefer SWA Easy Auth header; never trust a client-supplied JWT as the gate. */
const signedInUserFromRequest = (request) => {
    const encoded = headerGet(request, 'x-ms-client-principal');
    if (encoded) {
        try {
            const raw = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
            const claims = claimMapFromPrincipal(raw);
            const email =
                raw.userDetails ||
                claims.preferred_username ||
                claims.email ||
                claims.emails ||
                headerGet(request, 'x-ms-client-principal-name') ||
                null;
            const displayName =
                claims.name ||
                claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] ||
                null;
            const entraId =
                raw.userId ||
                claims.oid ||
                claims.sub ||
                headerGet(request, 'x-ms-client-principal-id') ||
                null;
            return {
                entraId: entraId ? String(entraId) : null,
                email: email ? String(email) : null,
                name: (displayName || email || 'User').toString(),
                identityProvider: raw.identityProvider || headerGet(request, 'x-ms-client-principal-idp') || 'aad',
                source: 'swa_principal'
            };
        } catch (_) {
            /* fall through */
        }
    }

    const headerName = headerGet(request, 'x-ms-client-principal-name');
    if (headerName) {
        return {
            entraId: headerGet(request, 'x-ms-client-principal-id') || null,
            email: headerName.includes('@') ? headerName : null,
            name: headerName,
            identityProvider: headerGet(request, 'x-ms-client-principal-idp') || 'aad',
            source: 'swa_headers'
        };
    }

    return null;
};

const stripUserPassword = (user) => {
    if (!user || typeof user !== 'object') return user;
    const { password: _pw, ...rest } = user;
    return rest;
};

async function findOrCreateUserFromPrincipal(principal, context) {
    const container = getContainer('users');
    const entraId = principal.entraId;
    const email = principal.email ? String(principal.email).trim() : '';
    const name = principal.name || email || 'User';

    let user = null;

    if (entraId) {
        const { resources } = await container.items
            .query({
                query: 'SELECT * FROM c WHERE c.entraId = @entraId',
                parameters: [{ name: '@entraId', value: entraId }]
            })
            .fetchAll();
        if (resources && resources.length) user = resources[0];
    }

    if (!user && email) {
        const { resources } = await container.items
            .query({
                query: 'SELECT * FROM c WHERE LOWER(c.email) = @email OR LOWER(c.username) = @email',
                parameters: [{ name: '@email', value: email.toLowerCase() }]
            })
            .fetchAll();
        if (resources && resources.length) user = resources[0];
    }

    if (user) {
        const updates = {};
        if (entraId && user.entraId !== entraId) updates.entraId = entraId;
        if (email && user.email !== email) updates.email = email;
        if (name && user.name !== name) updates.name = name;
        if (email && !user.username) updates.username = email;
        if (Object.keys(updates).length) {
            const { resource } = await container.items.upsert({ ...user, ...updates });
            user = resource;
            context.log(`Synced Entra fields for user ${user.id}`);
        }
        return stripUserPassword(user);
    }

    const newUser = {
        id: generateId(),
        entraId: entraId || '',
        username: email || entraId || generateId(),
        email: email || '',
        name,
        permissionLevel: 'CRC',
        createdAt: new Date().toISOString(),
        authSource: 'entra_swa'
    };
    const { resource: createdUser } = await container.items.create(newUser);
    context.log(`Created Cosmos user from Entra principal: ${createdUser.id}`);
    return stripUserPassword(createdUser);
}

// SWA Easy Auth rolesSource — assignment required in Entra still gates who can sign in
app.http('GetRoles', {
    methods: ['POST', 'GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'GetRoles',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'content-type'
                }
            };
        }
        try {
            if (request.method === 'POST') {
                await request.json().catch(() => ({}));
            }
        } catch (_) {
            /* ignore body parse errors */
        }
        context.log('GetRoles: returning reader');
        return {
            status: 200,
            jsonBody: { roles: ['reader'] },
            headers: { 'Content-Type': 'application/json' }
        };
    }
});

// Map SWA principal → Cosmos users row (permissionLevel lives in Cosmos)
app.http('usersMe', {
    methods: ['GET', 'POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/me',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'content-type'
                }
            };
        }
        try {
            const principal = signedInUserFromRequest(request);
            if (!principal || (!principal.entraId && !principal.email)) {
                return {
                    status: 401,
                    jsonBody: { error: 'Not signed in via Entra / SWA Easy Auth' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            const user = await findOrCreateUserFromPrincipal(principal, context);
            return {
                status: 200,
                jsonBody: user,
                headers: { 'Content-Type': 'application/json' }
            };
        } catch (error) {
            context.log.error('users/me error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to resolve signed-in user' },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    }
});

// Register authenticate endpoint BEFORE users endpoint to ensure specific route matches first
// Register authenticate route BEFORE users route to ensure proper matching
// Legacy JWT decode path (not the primary SWA Easy Auth gate)
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
                        createdAt: new Date().toISOString()
                    };
                    
                    const { resource: createdUser } = await container.items.create(newUser);
                    user = createdUser;
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
                return {
                    status: 401,
                    jsonBody: { error: 'Invalid username or password' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            const user = users[0];
            
            if (!verifyPassword(password, user.password)) {
                return {
                    status: 401,
                    jsonBody: { error: 'Invalid username or password' },
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
                    createdAt: new Date().toISOString()
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
                    const { resource } = await container.item(id, id).read(); 
                    if (!resource) return { status: 404, jsonBody: { error: 'User not found' } };
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
                password: hashPassword('Password1!'),
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

// Flight lookup proxy endpoint
// This endpoint calls AviationStack API directly - it does NOT search the database
// Flight data is only saved to the database when the user saves a travel record via /api/travel
// All travel records (including flight data) are stored in the "travel" container, not a separate "flight-lookup" container
app.http('flightLookup', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'flight-lookup',
    handler: async (request, context) => {
        let flightNumber = null;
        
        // Wrap everything in try-catch to ensure we always return 200 instead of 500
        try {
            // Get query parameters - try multiple methods for compatibility
            if (request.query && request.query.flightNumber) {
                flightNumber = request.query.flightNumber;
            } else if (request.query && typeof request.query.get === 'function') {
                flightNumber = request.query.get('flightNumber');
            } else if (request.url) {
                try {
                    // Try to parse as full URL
                    let urlString = request.url;
                    if (!urlString.startsWith('http')) {
                        // If relative, construct full URL
                        urlString = `https://${request.headers?.['host'] || 'localhost'}${urlString}`;
                    }
                    const url = new URL(urlString);
                    flightNumber = url.searchParams.get('flightNumber');
                } catch (error) {
                    context.log.warn('Error parsing URL:', error.message);
                    // Try simple query string parsing
                    const match = request.url.match(/[?&]flightNumber=([^&]+)/);
                    if (match) {
                        flightNumber = decodeURIComponent(match[1]);
                    }
                }
            }
            
            if (!flightNumber) {
                context.log.error('Flight lookup: flightNumber parameter missing. URL:', request.url);
                return {
                    status: 400,
                    jsonBody: { error: 'flightNumber parameter is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            context.log.info(`Flight lookup request for: ${flightNumber}`);
            context.log.info('Calling AviationStack API directly - NOT searching database');
            
            // Try AviationStack API (available via Microsoft Connectors)
            // Use environment variable if set, otherwise use provided key
            const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_API_KEY || 'f4d364ba3a06f3498403ff1958d6d608';
            context.log.info(`AviationStack API check: Key exists=${!!AVIATIONSTACK_KEY}`);
            
            // If no API key, return basic info immediately
            if (!AVIATIONSTACK_KEY) {
                context.log.info('AviationStack API key not configured, returning basic info');
                return {
                    status: 200,
                    jsonBody: {
                        flightNumber: flightNumber,
                        airline: null,
                        origin: null,
                        destination: null,
                        departureTime: null,
                        arrivalTime: null,
                        status: 'scheduled',
                        delay: null,
                        gate: null,
                        terminal: null,
                        message: 'Flight API key not configured. Please configure AVIATIONSTACK_API_KEY in Azure environment variables for full flight information.'
                    },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            if (AVIATIONSTACK_KEY) {
                try {
                    context.log.info(`Calling AviationStack API for flight: ${flightNumber}`);
                    
                    // Try multiple API parameter formats based on AviationStack documentation
                    // Format 1: flight_iata (full IATA code like DAL1478)
                    let apiUrl = `https://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&flight_iata=${encodeURIComponent(flightNumber.toUpperCase())}&limit=100`;
                    let response;
                    let apiData = null;
                    
                    try {
                        response = await fetch(apiUrl, {
                            method: 'GET'
                        });
                        context.log.info(`AviationStack API response status (flight_iata): ${response.status}`);
                        
                        // Get response text first to check for errors
                        const responseText = await response.text();
                        context.log.info(`AviationStack API raw response (first 500 chars): ${responseText.substring(0, 500)}`);
                        
                        try {
                            apiData = JSON.parse(responseText);
                            
                            // Check for error in response (even if status is 200)
                            // AviationStack returns errors in format: {error: {code: "...", message: "..."}}
                            if (apiData.error) {
                                const errorCode = apiData.error.code || 'unknown';
                                const errorMessage = apiData.error.message || 'Unknown error';
                                context.log.error(`AviationStack API error [${errorCode}]: ${errorMessage}`);
                                
                                // Handle specific error codes
                                if (errorCode === 401) {
                                    context.log.error('Invalid or missing API access key');
                                } else if (errorCode === 403) {
                                    context.log.error('Access restricted - check subscription plan limits');
                                } else if (errorCode === 404) {
                                    context.log.error('Invalid API endpoint or resource not found');
                                } else if (errorCode === 429) {
                                    context.log.error('Rate limit exceeded - too many requests');
                                }
                                
                                apiData = null;
                            } else if (apiData.data) {
                                context.log.info(`AviationStack API response: ${apiData.data?.length || 0} flights found`);
                                // AviationStack also includes pagination info
                                if (apiData.pagination) {
                                    context.log.info(`AviationStack pagination: limit=${apiData.pagination.limit}, offset=${apiData.pagination.offset}, count=${apiData.pagination.count}, total=${apiData.pagination.total}`);
                                }
                            } else {
                                context.log.warn('AviationStack API response missing data field:', responseText.substring(0, 200));
                                apiData = null;
                            }
                        } catch (jsonError) {
                            context.log.error('AviationStack API JSON parse error:', jsonError.message);
                            context.log.error('Response text:', responseText.substring(0, 500));
                            // Fall through to try alternative method
                            apiData = null;
                        }
                    } catch (fetchError) {
                        context.log.error('AviationStack API fetch error:', fetchError.message);
                        context.log.error('Stack:', fetchError.stack);
                        // Fall through to return basic info
                        response = null;
                    }
                    
                    if (apiData && apiData.data && apiData.data.length > 0) {
                        const exactMatch = apiData.data.find(f => 
                            f.flight?.iata?.toUpperCase() === flightNumber.toUpperCase() ||
                            f.flight?.number?.toString() === flightNumber.replace(/^[A-Z]{2,3}/i, '')
                        );
                        
                        if (exactMatch) {
                            const flight = exactMatch;
                            context.log.info(`Flight found: ${flight.flight?.iata || flight.flight?.number}, Origin: ${flight.departure?.iata || flight.departure?.airport}, Dest: ${flight.arrival?.iata || flight.arrival?.airport}`);
                            
                            return {
                                status: 200,
                                jsonBody: {
                                    flightNumber: flight.flight?.iata || flight.flight?.number || flightNumber,
                                    airline: flight.airline?.name || flight.airline?.iata || null,
                                    origin: flight.departure?.iata || flight.departure?.airport || flight.departure?.airport_name || null,
                                    destination: flight.arrival?.iata || flight.arrival?.airport || flight.arrival?.airport_name || null,
                                    departureTime: flight.departure?.scheduled || flight.departure?.estimated || null,
                                    arrivalTime: flight.arrival?.scheduled || flight.arrival?.estimated || null,
                                    status: flight.flight_status || 'scheduled',
                                    delay: flight.departure?.delay ? `${flight.departure.delay} minutes` : (flight.arrival?.delay ? `${flight.arrival.delay} minutes` : null),
                                    gate: flight.departure?.gate || flight.arrival?.gate || null,
                                    terminal: flight.departure?.terminal || flight.arrival?.terminal || null
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                    } else if (response && !response.ok) {
                        try {
                            const errorText = await response.text();
                            context.log.error(`AviationStack API HTTP error: ${response.status} - ${errorText.substring(0, 500)}`);
                        } catch (error) {
                            context.log.error(`AviationStack API HTTP error: ${response.status} - Could not read error response`);
                        }
                    }
                    
                    // If not found with flight_iata, try splitting into airline_iata + flight_number
                    if (!apiData || !apiData.data || apiData.data.length === 0) {
                        context.log.info('Trying airline_iata + flight_number parameter format');
                        const flightMatch = flightNumber.match(/^([A-Z]{2,3})(\d+)$/i);
                        if (flightMatch) {
                            const [, airlineCode, flightNum] = flightMatch;
                            apiUrl = `https://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&airline_iata=${airlineCode.toUpperCase()}&flight_number=${flightNum}&limit=100`;
                            
                            try {
                                response = await fetch(apiUrl, {
                                    method: 'GET'
                                });
                                context.log.info(`AviationStack API response status (airline_iata+flight_number): ${response.status}`);
                                
                                // Get response text first to check for errors
                                const responseText = await response.text();
                                context.log.info(`AviationStack API raw response (alternative, first 500 chars): ${responseText.substring(0, 500)}`);
                                
                                try {
                                    apiData = JSON.parse(responseText);
                                    
                                    // Check for error in response (even if status is 200)
                                    // AviationStack returns errors in format: {error: {code: "...", message: "..."}}
                                    if (apiData.error) {
                                        const errorCode = apiData.error.code || 'unknown';
                                        const errorMessage = apiData.error.message || 'Unknown error';
                                        context.log.error(`AviationStack API error (alternative) [${errorCode}]: ${errorMessage}`);
                                        
                                        // Handle specific error codes
                                        if (errorCode === 401) {
                                            context.log.error('Invalid or missing API access key');
                                        } else if (errorCode === 403) {
                                            context.log.error('Access restricted - check subscription plan limits');
                                        } else if (errorCode === 404) {
                                            context.log.error('Invalid API endpoint or resource not found');
                                        } else if (errorCode === 429) {
                                            context.log.error('Rate limit exceeded - too many requests');
                                        }
                                        
                                        apiData = null;
                                    } else if (apiData.data) {
                                        context.log.info(`AviationStack API response (alternative): ${apiData.data?.length || 0} flights found`);
                                        // AviationStack also includes pagination info
                                        if (apiData.pagination) {
                                            context.log.info(`AviationStack pagination (alternative): limit=${apiData.pagination.limit}, offset=${apiData.pagination.offset}, count=${apiData.pagination.count}, total=${apiData.pagination.total}`);
                                        }
                                    } else {
                                        context.log.warn('AviationStack API response missing data field (alternative):', responseText.substring(0, 200));
                                        apiData = null;
                                    }
                                } catch (jsonError) {
                                    context.log.error('AviationStack API JSON parse error (alternative):', jsonError.message);
                                    context.log.error('Response text:', responseText.substring(0, 500));
                                    apiData = null;
                                }
                            } catch (fetchError) {
                                context.log.error('AviationStack API fetch error (alternative):', fetchError.message);
                                context.log.error('Stack:', fetchError.stack);
                                response = null;
                            }
                            
                            if (apiData && apiData.data && apiData.data.length > 0) {
                                // Find the best match
                                const bestMatch = apiData.data.find(f => 
                                    f.flight?.iata?.toUpperCase() === flightNumber.toUpperCase() ||
                                    (f.airline?.iata?.toUpperCase() === airlineCode.toUpperCase() && 
                                     f.flight?.number?.toString() === flightNum)
                                ) || apiData.data[0];
                                
                                const flight = bestMatch;
                                context.log.info(`Flight found: ${flight.flight?.iata || flight.flight?.number}, Origin: ${flight.departure?.iata || flight.departure?.airport}, Dest: ${flight.arrival?.iata || flight.arrival?.airport}`);
                                
                                return {
                                    status: 200,
                                    jsonBody: {
                                        flightNumber: flight.flight?.iata || flight.flight?.number || flightNumber,
                                        airline: flight.airline?.name || flight.airline?.iata || null,
                                        origin: flight.departure?.iata || flight.departure?.airport || flight.departure?.airport_name || null,
                                        destination: flight.arrival?.iata || flight.arrival?.airport || flight.arrival?.airport_name || null,
                                        departureTime: flight.departure?.scheduled || flight.departure?.estimated || null,
                                        arrivalTime: flight.arrival?.scheduled || flight.arrival?.estimated || null,
                                        status: flight.flight_status || 'scheduled',
                                        delay: flight.departure?.delay ? `${flight.departure.delay} minutes` : (flight.arrival?.delay ? `${flight.arrival.delay} minutes` : null),
                                        gate: flight.departure?.gate || flight.arrival?.gate || null,
                                        terminal: flight.departure?.terminal || flight.arrival?.terminal || null
                                    },
                                    headers: { 'Content-Type': 'application/json' }
                                };
                            } else if (response && !response.ok) {
                                try {
                                    const errorText = await response.text();
                                    context.log.error(`AviationStack API HTTP error (alternative): ${response.status} - ${errorText.substring(0, 500)}`);
                                } catch (error) {
                                    context.log.error(`AviationStack API HTTP error (alternative): ${response.status} - Could not read error response`);
                                }
                            }
                        }
                    }
                } catch (error) {
                    context.log.error('AviationStack API exception:', error.message);
                    context.log.error('Stack:', error.stack);
                    // Don't throw, fall through to return basic info
                }
            } else {
                context.log.info('AviationStack API key not configured');
            }
            
            // Try OAG Flight Info API via Azure Marketplace (if configured, as fallback)
            const OAG_API_KEY = process.env.OAG_API_KEY || process.env.OAG_FLIGHT_INFO_API_KEY;
            const OAG_API_URL = process.env.OAG_API_URL || 'https://api.oag.com/flightinfo/v1';
            if (OAG_API_KEY && !AVIATIONSTACK_KEY) {
                try {
                    // OAG API format - adjust based on their actual API documentation
                    const response = await fetch(`${OAG_API_URL}/flights?flightNumber=${flightNumber}`, {
                        headers: {
                            'Authorization': `Bearer ${OAG_API_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    if (response.ok) {
                        const apiData = await response.json();
                        // Adjust response parsing based on OAG API structure
                        if (apiData.data && apiData.data.length > 0) {
                            const flight = apiData.data[0];
                            return {
                                status: 200,
                                jsonBody: {
                                    flightNumber: flight.flightNumber || flightNumber,
                                    airline: flight.airline?.name || null,
                                    origin: flight.origin?.airport || flight.origin?.iata || null,
                                    destination: flight.destination?.airport || flight.destination?.iata || null,
                                    departureTime: flight.departure?.scheduled || null,
                                    arrivalTime: flight.arrival?.scheduled || null,
                                    status: flight.status || 'scheduled',
                                    delay: flight.departure?.delay ? `${flight.departure.delay} minutes` : null,
                                    gate: flight.departure?.gate || null,
                                    terminal: flight.departure?.terminal || null
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                    }
                } catch (error) {
                    context.log.warn('OAG API failed:', error.message);
                }
            }
            
            // If no API key configured or API call failed, return basic info with 200 status
            // This allows the frontend to handle it gracefully
            return {
                status: 200,
                jsonBody: {
                    flightNumber: flightNumber,
                    airline: null,
                    origin: null,
                    destination: null,
                    departureTime: null,
                    arrivalTime: null,
                    status: 'scheduled',
                    delay: null,
                    gate: null,
                    terminal: null,
                    message: AVIATIONSTACK_KEY 
                        ? 'Flight information not available. The flight may not be in the system or the API returned no data.'
                        : 'Flight API key not configured. Please configure AVIATIONSTACK_API_KEY in Azure environment variables for full flight information.'
                },
                headers: { 'Content-Type': 'application/json' }
            };
            
        } catch (error) {
            context.log.error('Flight lookup error:', error.message, error.stack);
            // Return 200 with error info instead of 500 so frontend can handle it
            return {
                status: 200,
                jsonBody: { 
                    flightNumber: flightNumber || 'unknown',
                    airline: null,
                    origin: null,
                    destination: null,
                    departureTime: null,
                    arrivalTime: null,
                    status: 'scheduled',
                    delay: null,
                    gate: null,
                    terminal: null,
                    message: `Flight lookup failed: ${error.message}. Please enter flight details manually.`
                },
                headers: { 'Content-Type': 'application/json' }
            };
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
                const response = await fetch(apiUrl);
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
                const response = await fetch(apiUrl);
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

// =================================================================================
// LEGACY STUDIES (ARTEMIS only) - new Cosmos containers; does not touch live studies/sites/patients
// =================================================================================
const { registerLegacyRoutes } = require('./legacy-routes');
registerLegacyRoutes(app, {
    getContainer,
    getCosmosClient,
    handleError,
    generateId,
});

const { registerPromoteLegacyRoutes } = require('./promote-legacy-routes');
registerPromoteLegacyRoutes(app, {
    getContainer,
    handleError,
    generateId,
});

// =================================================================================
// PRIVACY / GDPR ops (ARTEMIS only) — survey export, erase, retention; no Chaos/NASA
// =================================================================================
const { registerPrivacyRoutes } = require('./privacy-routes');
registerPrivacyRoutes(app, {
    getContainer,
    getCosmosClient,
    handleError,
    generateId,
});

// =================================================================================
// Secure site surveys (opaque tokens, public form, bulk send, notifications)
// =================================================================================
registerSurveySecureRoutes(app, {
    getContainer,
    getCosmosClient,
    handleError,
    generateId,
    validateSurveyResponsesSchema,
    validateSurveyAssignmentsSchema,
});
