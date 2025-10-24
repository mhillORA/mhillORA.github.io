const { CosmosClient } = require('@azure/cosmos');

// Get from environment variables
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const DATABASE_ID = process.env.DATABASE_ID;

const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
const database = client.database(DATABASE_ID);

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

        const path = req.url.replace('/api/', '');
        const pathParts = path.split('/');
        const resource = pathParts[0];
        const id = pathParts[1];

        // Route handling
        switch (resource) {
            case 'studies':
                if (req.method === 'GET') {
                    const { resources } = await database.container('studies').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('studies').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('studies').item(id, '/id').replace(req.body);
                    context.res.body = resource;
                } else if (req.method === 'DELETE' && id) {
                    await database.container('studies').item(id, '/id').delete();
                    context.res.status = 204;
                }
                break;

            case 'sites':
                if (req.method === 'GET') {
                    const { resources } = await database.container('sites').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('sites').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('sites').item(id, '/id').replace(req.body);
                    context.res.body = resource;
                } else if (req.method === 'DELETE' && id) {
                    await database.container('sites').item(id, '/id').delete();
                    context.res.status = 204;
                }
                break;

            // Add other containers as needed...
            default:
                context.res.status = 404;
                context.res.body = { error: 'Resource not found' };
        }

    } catch (error) {
        context.log.error('Error:', error);
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};
