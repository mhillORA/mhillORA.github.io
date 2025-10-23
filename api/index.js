const { CosmosClient } = require('@azure/cosmos');

// Your Cosmos DB configuration
const COSMOS_ENDPOINT = 'https://ora-clinical-recruiting.documents.azure.com:443/';
const COSMOS_KEY = 'rl7a83apOq35OqfKpNt7hTRyeeQVftD8SHitw2QW0w7Kd1S39YJfeZEm29fGQapYumgh0Bm6NEbjACDbH1iO9g==';
const DATABASE_ID = 'crcscheduling';

const client = new CosmosClient({
    endpoint: COSMOS_ENDPOINT,
    key: COSMOS_KEY
});

const database = client.database(DATABASE_ID);

// Azure Functions handler
module.exports = async function (context, req) {
    context.log('Processing request:', req.method, req.url);

    try {
        // Handle CORS
        context.res.headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        };

        if (req.method === 'OPTIONS') {
            context.res.status = 200;
            return;
        }

        // Route handling
        const url = req.url;
        const method = req.method;

        if (url.startsWith('/api/studies')) {
            if (method === 'GET') {
                const { resources } = await database.container('studies').items.readAll().fetchAll();
                context.res = {
                    status: 200,
                    body: resources
                };
            } else if (method === 'POST') {
                const { resource } = await database.container('studies').items.create(req.body);
                context.res = {
                    status: 201,
                    body: resource
                };
            }
        } else if (url.startsWith('/api/sites')) {
            if (method === 'GET') {
                const { resources } = await database.container('sites').items.readAll().fetchAll();
                context.res = {
                    status: 200,
                    body: resources
                };
            } else if (method === 'POST') {
                const { resource } = await database.container('sites').items.create(req.body);
                context.res = {
                    status: 201,
                    body: resource
                };
            }
        } else if (url.startsWith('/api/patients')) {
            if (method === 'GET') {
                const { resources } = await database.container('patients').items.readAll().fetchAll();
                context.res = {
                    status: 200,
                    body: resources
                };
            } else if (method === 'POST') {
                const { resource } = await database.container('patients').items.create(req.body);
                context.res = {
                    status: 201,
                    body: resource
                };
            }
        } else if (url.startsWith('/api/crcs')) {
            if (method === 'GET') {
                const { resources } = await database.container('crcs').items.readAll().fetchAll();
                context.res = {
                    status: 200,
                    body: resources
                };
            } else if (method === 'POST') {
                const { resource } = await database.container('crcs').items.create(req.body);
                context.res = {
                    status: 201,
                    body: resource
                };
            }
        } else {
            context.res = {
                status: 404,
                body: { error: 'Not found' }
            };
        }

    } catch (error) {
        context.log.error('Error:', error);
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};
