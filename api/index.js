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

// Studies endpoint
app.http('studies', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'studies/{id?}',
    handler: async (request, context) => {
        const { method } = request;
        const id = request.params.id;
        
        // Handle CORS preflight
        if (method === 'OPTIONS') {
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
            console.log(`Studies API Request: ${method} ${id ? `with id: ${id}` : 'all'}`);
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
        } catch (error) {
            console.error('Studies API Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: { error: error.message }
            };
        }
    }
});

// Sites endpoint
app.http('sites', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'sites/{id?}',
    handler: async (request, context) => {
        const { method } = request;
        const id = request.params.id;
        
        // Handle CORS preflight
        if (method === 'OPTIONS') {
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
            console.log(`Sites API Request: ${method} ${id ? `with id: ${id}` : 'all'}`);
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
        } catch (error) {
            console.error('Sites API Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: { error: error.message }
            };
        }
    }
});

// Patients endpoint
app.http('patients', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'patients/{id?}',
    handler: async (request, context) => {
        const { method } = request;
        const id = request.params.id;
        
        // Handle CORS preflight
        if (method === 'OPTIONS') {
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
            console.log(`Patients API Request: ${method} ${id ? `with id: ${id}` : 'all'}`);
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
        } catch (error) {
            console.error('Patients API Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: { error: error.message }
            };
        }
    }
});

// CRCs endpoint
app.http('crcs', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'crcs/{id?}',
    handler: async (request, context) => {
        const { method } = request;
        const id = request.params.id;
        
        // Handle CORS preflight
        if (method === 'OPTIONS') {
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
            console.log(`CRCs API Request: ${method} ${id ? `with id: ${id}` : 'all'}`);
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
        } catch (error) {
            console.error('CRCs API Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: { error: error.message }
            };
        }
    }
});

// Events endpoint
app.http('events', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'events/{id?}',
    handler: async (request, context) => {
        const { method } = request;
        const id = request.params.id;
        
        // Handle CORS preflight
        if (method === 'OPTIONS') {
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
            console.log(`Events API Request: ${method} ${id ? `with id: ${id}` : 'all'}`);
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
        } catch (error) {
            console.error('Events API Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: { error: error.message }
            };
        }
    }
});

// Roles endpoint
app.http('roles', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'roles/{id?}',
    handler: async (request, context) => {
        const { method } = request;
        const id = request.params.id;
        
        // Handle CORS preflight
        if (method === 'OPTIONS') {
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
            console.log(`Roles API Request: ${method} ${id ? `with id: ${id}` : 'all'}`);
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
        } catch (error) {
            console.error('Roles API Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: { error: error.message }
            };
        }
    }
});

// Training Types endpoint
app.http('training-types', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'training-types/{id?}',
    handler: async (request, context) => {
        const { method } = request;
        const id = request.params.id;
        
        // Handle CORS preflight
        if (method === 'OPTIONS') {
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
            console.log(`Training Types API Request: ${method} ${id ? `with id: ${id}` : 'all'}`);
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
        } catch (error) {
            console.error('Training Types API Error:', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: { error: error.message }
            };
        }
    }
});
