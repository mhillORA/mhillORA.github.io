const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

// Helper function to generate unique IDs
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Helper function to get Cosmos DB client (lazy initialization)
let cosmosClient = null;
let database = null;

const getCosmosClient = () => {
    if (!cosmosClient) {
        // Cosmos DB configuration - using environment variables with fallbacks
        const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || 'https://ora-clinical-recruiting.documents.azure.com:443/';
        const COSMOS_KEY = process.env.COSMOS_KEY || 'rl7a83apOq35OqfKpNt7hTRyeeQVftD8SHitw2QW0w7Kd1S39YJfeZEm29fGQapYumgh0Bm6NEbjACDbH1iO9g==';
        const DATABASE_ID = process.env.DATABASE_ID || 'crcscheduling';

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

// Helper function to handle CORS
const setCorsHeaders = (response) => {
    response.headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json'
    };
};

// Helper function to handle errors
const handleError = (response, error, message) => {
    console.error(`${message}:`, error);
    setCorsHeaders(response);
    response.status = 500;
    response.body = { error: error.message };
};

// Main API function that handles all routes
app.http('api', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'api/{*path}',
    handler: async (request, context) => {
        const { method, url } = request;
        
        // Handle CORS preflight
        if (method === 'OPTIONS') {
            setCorsHeaders(request);
            return {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
                }
            };
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
                    return await handleStudies(request, method, id);
                case 'sites':
                    return await handleSites(request, method, id);
                case 'patients':
                    return await handlePatients(request, method, id);
                case 'crcs':
                    return await handleCrcs(request, method, id);
                case 'events':
                    return await handleEvents(request, method, id);
                case 'roles':
                    return await handleRoles(request, method, id);
                case 'training-types':
                    return await handleTrainingTypes(request, method, id);
                default:
                    return {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' },
                        body: { error: 'Endpoint not found' }
                    };
            }
        } catch (error) {
            console.error('API Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: { error: error.message }
            };
        }
    }
});

// Studies handler
async function handleStudies(request, method, id) {
    const container = getContainer('studies');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resource
                };
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resources
                };
            }
        case 'POST':
            const newStudy = { ...request.json(), id: generateId() };
            const { resource: createdStudy } = await container.items.create(newStudy);
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: createdStudy
            };
        case 'PUT':
            const updatedStudy = { ...request.json(), id };
            const { resource: studyResult } = await container.item(id).replace(updatedStudy);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: studyResult
            };
        case 'DELETE':
            await container.item(id).delete();
            return {
                status: 204,
                headers: { 'Content-Type': 'application/json' }
            };
    }
}

// Sites handler
async function handleSites(request, method, id) {
    const container = getContainer('sites');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resource
                };
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resources
                };
            }
        case 'POST':
            const newSite = { ...request.json(), id: generateId() };
            const { resource: createdSite } = await container.items.create(newSite);
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: createdSite
            };
        case 'PUT':
            const updatedSite = { ...request.json(), id };
            const { resource: siteResult } = await container.item(id).replace(updatedSite);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: siteResult
            };
        case 'DELETE':
            await container.item(id).delete();
            return {
                status: 204,
                headers: { 'Content-Type': 'application/json' }
            };
    }
}

// Patients handler
async function handlePatients(request, method, id) {
    const container = getContainer('patients');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resource
                };
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resources
                };
            }
        case 'POST':
            const newPatient = { ...request.json(), id: generateId() };
            const { resource: createdPatient } = await container.items.create(newPatient);
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: createdPatient
            };
        case 'PUT':
            const updatedPatient = { ...request.json(), id };
            const { resource: patientResult } = await container.item(id).replace(updatedPatient);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: patientResult
            };
        case 'DELETE':
            await container.item(id).delete();
            return {
                status: 204,
                headers: { 'Content-Type': 'application/json' }
            };
    }
}

// CRCs handler
async function handleCrcs(request, method, id) {
    const container = getContainer('crcs');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resource
                };
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resources
                };
            }
        case 'POST':
            const newCrc = { ...request.json(), id: generateId() };
            const { resource: createdCrc } = await container.items.create(newCrc);
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: createdCrc
            };
        case 'PUT':
            const updatedCrc = { ...request.json(), id };
            const { resource: crcResult } = await container.item(id).replace(updatedCrc);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: crcResult
            };
        case 'DELETE':
            await container.item(id).delete();
            return {
                status: 204,
                headers: { 'Content-Type': 'application/json' }
            };
    }
}

// Events handler
async function handleEvents(request, method, id) {
    const container = getContainer('events');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resource
                };
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resources
                };
            }
        case 'POST':
            const newEvent = { ...request.json(), id: generateId() };
            const { resource: createdEvent } = await container.items.create(newEvent);
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: createdEvent
            };
        case 'PUT':
            const updatedEvent = { ...request.json(), id };
            const { resource: eventResult } = await container.item(id).replace(updatedEvent);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: eventResult
            };
        case 'DELETE':
            await container.item(id).delete();
            return {
                status: 204,
                headers: { 'Content-Type': 'application/json' }
            };
    }
}

// Roles handler
async function handleRoles(request, method, id) {
    const container = getContainer('roles');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resource
                };
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resources
                };
            }
        case 'POST':
            const newRole = { ...request.json(), id: generateId() };
            const { resource: createdRole } = await container.items.create(newRole);
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: createdRole
            };
        case 'PUT':
            const updatedRole = { ...request.json(), id };
            const { resource: roleResult } = await container.item(id).replace(updatedRole);
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: roleResult
            };
        case 'DELETE':
            await container.item(id).delete();
            return {
                status: 204,
                headers: { 'Content-Type': 'application/json' }
            };
    }
}

// Training Types handler
async function handleTrainingTypes(request, method, id) {
    const container = getContainer('training_types');
    
    switch (method) {
        case 'GET':
            if (id) {
                const { resource } = await container.item(id).read();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resource
                };
            } else {
                const { resources } = await container.items.readAll().fetchAll();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: resources
                };
            }
        case 'POST':
            const newTrainingType = { ...request.json(), id: generateId() };
            const { resource: createdTrainingType } = await container.items.create(newTrainingType);
            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                body: createdTrainingType
            };
    }
}
