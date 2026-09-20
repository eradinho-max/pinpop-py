const serverless = require('serverless-http');
const { app, ensureDatabaseReady } = require('../../server');

const expressHandler = serverless(app);

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await ensureDatabaseReady();
  return expressHandler(event, context);
};
