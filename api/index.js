const { CosmosClient } = require('@azure/cosmos');

// Cosmos DB configuration - using environment variables
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://ora-clinical-recruiting.documents.azure.com:443/';
const COSMOS_KEY = process.env.COSMOS_KEY || 'rl7a83apOq35OqfKpNt7hTRyeeQVftD8SHitw2QW0w7Kd1S39YJfeZEm29fGQapYumgh0Bm6NEbjACDbH1iO9g==';
const DATABASE_ID = process.env.DATABASE_ID || 'crcscheduling';

const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
const database = client.database(DATABASE_ID);

// Helper function to get container
const getContainer = (containerName) => {
    return database.container(containerName);
};

// Helper function to handle CORS
const setCorsHeaders = (res) => {
    res.headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json'
    };
};

// Helper function to handle errors
const handleError = (res, error, message) => {
    console.error(`${message}:`, error);
    setCorsHeaders(res);
    res.status = 500;
    res.body = { error: error.message };
};

module.exports = async function (context, req) {
    const { method, url } = req;
    
    // Handle CORS preflight
    if (method === 'OPTIONS') {
        setCorsHeaders(context.res);
        context.res.status = 200;
        return;
    }

    try {
        // Parse the URL to get the endpoint
        const urlPath = url.replace('/api', '');
        const pathParts = urlPath.split('/').filter(part => part);
        const endpoint = pathParts[0];
        const id = pathParts[1];

        console.log(`API Request: ${method} ${urlPath}`);

        // Route handling
        switch (endpoint) {
            case 'studies':
                await handleStudies(context, req, method, id);
                break;
            case 'sites':
                await handleSites(context, req, method, id);
                break;
            case 'patients':
                await handlePatients(context, req, method, id);
                break;
            case 'crcs':
                await handleCrcs(context, req, method, id);
                break;
            case 'events':
                await handleEvents(context, req, method, id);
                break;
            case 'roles':
                await handleRoles(context, req, method, id);
                break;
            case 'training-types':
                await handleTrainingTypes(context, req, method, id);
                break;
            default:
                setCorsHeaders(context.res);
                context.res.status = 404;
                context.res.body = { error: 'Endpoint not found' };
        }
    } catch (error) {
        handleError(context.res, error, 'API Error');
    }
};

// Studies handler
async function handleStudies(context, req, method, id) {
    const container = getContainer('studies');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resource;
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resources;
            }
            break;
        case 'POST':
            const newStudy = { ...req.body, id: generateId() };
            const { resource: createdStudy } = await container.items.create(newStudy);
            setCorsHeaders(context.res);
            context.res.status = 201;
            context.res.body = createdStudy;
            break;
        case 'PUT':
            const updatedStudy = { ...req.body, id };
            const { resource: studyResult } = await container.item(id).replace(updatedStudy);
            setCorsHeaders(context.res);
            context.res.status = 200;
            context.res.body = studyResult;
            break;
        case 'DELETE':
            await container.item(id).delete();
            setCorsHeaders(context.res);
            context.res.status = 204;
            break;
    }
}

// Sites handler
async function handleSites(context, req, method, id) {
    const container = getContainer('sites');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resource;
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resources;
            }
            break;
        case 'POST':
            const newSite = { ...req.body, id: generateId() };
            const { resource: createdSite } = await container.items.create(newSite);
            setCorsHeaders(context.res);
            context.res.status = 201;
            context.res.body = createdSite;
            break;
        case 'PUT':
            const updatedSite = { ...req.body, id };
            const { resource: siteResult } = await container.item(id).replace(updatedSite);
            setCorsHeaders(context.res);
            context.res.status = 200;
            context.res.body = siteResult;
            break;
        case 'DELETE':
            await container.item(id).delete();
            setCorsHeaders(context.res);
            context.res.status = 204;
            break;
    }
}

// Patients handler
async function handlePatients(context, req, method, id) {
    const container = getContainer('patients');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resource;
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resources;
            }
            break;
        case 'POST':
            const newPatient = { ...req.body, id: generateId() };
            const { resource: createdPatient } = await container.items.create(newPatient);
            setCorsHeaders(context.res);
            context.res.status = 201;
            context.res.body = createdPatient;
            break;
        case 'PUT':
            const updatedPatient = { ...req.body, id };
            const { resource: patientResult } = await container.item(id).replace(updatedPatient);
            setCorsHeaders(context.res);
            context.res.status = 200;
            context.res.body = patientResult;
            break;
        case 'DELETE':
            await container.item(id).delete();
            setCorsHeaders(context.res);
            context.res.status = 204;
            break;
    }
}

// CRCs handler
async function handleCrcs(context, req, method, id) {
    const container = getContainer('crcs');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resource;
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resources;
            }
            break;
        case 'POST':
            const newCrc = { ...req.body, id: generateId() };
            const { resource: createdCrc } = await container.items.create(newCrc);
            setCorsHeaders(context.res);
            context.res.status = 201;
            context.res.body = createdCrc;
            break;
        case 'PUT':
            const updatedCrc = { ...req.body, id };
            const { resource: crcResult } = await container.item(id).replace(updatedCrc);
            setCorsHeaders(context.res);
            context.res.status = 200;
            context.res.body = crcResult;
            break;
        case 'DELETE':
            await container.item(id).delete();
            setCorsHeaders(context.res);
            context.res.status = 204;
            break;
    }
}

// Events handler
async function handleEvents(context, req, method, id) {
    const container = getContainer('events');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resource;
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resources;
            }
            break;
        case 'POST':
            const newEvent = { ...req.body, id: generateId() };
            const { resource: createdEvent } = await container.items.create(newEvent);
            setCorsHeaders(context.res);
            context.res.status = 201;
            context.res.body = createdEvent;
            break;
        case 'PUT':
            const updatedEvent = { ...req.body, id };
            const { resource: eventResult } = await container.item(id).replace(updatedEvent);
            setCorsHeaders(context.res);
            context.res.status = 200;
            context.res.body = eventResult;
            break;
        case 'DELETE':
            await container.item(id).delete();
            setCorsHeaders(context.res);
            context.res.status = 204;
            break;
    }
}

// Roles handler
async function handleRoles(context, req, method, id) {
    const container = getContainer('roles');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resource;
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resources;
            }
            break;
        case 'POST':
            const newRole = { ...req.body, id: generateId() };
            const { resource: createdRole } = await container.items.create(newRole);
            setCorsHeaders(context.res);
            context.res.status = 201;
            context.res.body = createdRole;
            break;
        case 'PUT':
            const updatedRole = { ...req.body, id };
            const { resource: roleResult } = await container.item(id).replace(updatedRole);
            setCorsHeaders(context.res);
            context.res.status = 200;
            context.res.body = roleResult;
            break;
        case 'DELETE':
            await container.item(id).delete();
            setCorsHeaders(context.res);
            context.res.status = 204;
            break;
    }
}

// Training Types handler
async function handleTrainingTypes(context, req, method, id) {
    const container = getContainer('training_types');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resource;
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                setCorsHeaders(context.res);
                context.res.status = 200;
                context.res.body = resources;
            }
            break;
        case 'POST':
            const newTrainingType = { ...req.body, id: generateId() };
            const { resource: createdTrainingType } = await container.items.create(newTrainingType);
            setCorsHeaders(context.res);
            context.res.status = 201;
            context.res.body = createdTrainingType;
            break;
    }
}

// Helper function to generate unique IDs
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}
