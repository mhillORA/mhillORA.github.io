const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

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

// Helper function to handle errors
const handleError = (context, error, message) => {
    context.log.error(`${message}:`, error.message);
    context.log.error(`Stack:`, error.stack);

    let errorMessage;
    let errorDetail = error.message || "Unknown error";
    let errorStack = error.stack || "No stack trace";

    if (error.message.includes('COSMOS_DB_CONFIG_MISSING')) {
        errorMessage = "API Configuration Error: Database secrets not set in Azure Configuration.";
    } else if (error.message.includes('VALIDATION_ERROR')) {
        errorMessage = error.message.replace('VALIDATION_ERROR: ', '');
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

// Ensure context.log has error/info/warn helpers in all environments
const ensureContextLogger = (context) => {
    if (!context) {
        return;
    }
    if (!context.log) {
        context.log = (...args) => console.log(...args);
    }
    if (typeof context.log === 'function') {
        const base = (...args) => {
            try {
                context.log.apply(context, args);
            } catch (err) {
                console.log(...args);
            }
        };
        context.log.info = context.log.info || base;
        context.log.warn = context.log.warn || base;
        context.log.error = context.log.error || base;
        return;
    }
    context.log.info = context.log.info || console.log.bind(console);
    context.log.warn = context.log.warn || console.warn.bind(console);
    context.log.error = context.log.error || console.error.bind(console);
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
    
    // Debug logging
    console.log('Validating study data:', safeStringify(data));
    
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
                            validateSchedulesSchema(requestBody);
                            // Validate site-study relationship
                            await validateSiteStudyRelationship(requestBody.siteId, requestBody.studyId);
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

    let date = null;
    if (booking.startDate) {
        date = booking.startDate;
    } else if (booking.segments && booking.segments.length > 0 && booking.segments[0].startLocalDateTime) {
        const dateTime = new Date(booking.segments[0].startLocalDateTime);
        date = dateTime.toISOString().split('T')[0];
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
        date: date || new Date().toISOString().split('T')[0],
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
            travelRecord.departureTime = new Date(segment.startLocalDateTime).toISOString();
        }
        if (segment?.endLocalDateTime) {
            travelRecord.arrivalTime = new Date(segment.endLocalDateTime).toISOString();
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
            const checkIn = segment?.startLocalDateTime ? new Date(segment.startLocalDateTime) : new Date(booking.startDate);
            travelRecord.hotelCheckIn = checkIn.toISOString();
        }
        if (segment?.endLocalDateTime || booking.endDate) {
            const checkOut = segment?.endLocalDateTime ? new Date(segment.endLocalDateTime) : new Date(booking.endDate);
            travelRecord.hotelCheckOut = checkOut.toISOString();
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
                    // Safe defaults: 30 days past, 60 days future (changed from 365/180 to prevent timeout)
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
    schedule: '0 */6 * * *', // Every 6 hours
    handler: async (myTimer, context) => {
        ensureContextLogger(context);
        context.log.info('navanAutoImport: Timer triggered - Starting automatic Navan import');
        
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
            // Use default date range: 30 days past, 180 days future (6 months)
            const pastDays = 30;
            const futureDays = 180;
            
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