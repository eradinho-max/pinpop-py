const serverless = require('serverless-http');
const { app, ensureDatabaseReady } = require('../../server');

const expressHandler = serverless(app);

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    await ensureDatabaseReady();
    return await expressHandler(event, context);
  } catch (err) {
    console.error('PINPOP Netlify Function boot error:', err);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        error: 'PINPOP_API_BOOT_FAILED',
        message: 'La API no pudo iniciar correctamente.'
      })
    };
  }
};
