const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yaml');
const { query } = require('./db');
const { errorHandler, notFoundRoute } = require('./middleware/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
      },
    },
  }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (_req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api/auth', require('./modules/auth/routes').router);
  app.use('/api/books', require('./modules/books/routes').router);
  app.use('/api/loans', require('./modules/loans/routes').router);
  app.use('/api/holds', require('./modules/holds/routes').router);
  app.use('/api/fines', require('./modules/fines/routes').router);
  app.use('/api/members', require('./modules/members/routes').router);
  app.use('/api/staff', require('./modules/reports/routes').router);

  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.yaml'), 'utf8'));
  app.get('/api/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Shelfmark API' }));

  app.use('/api', notFoundRoute);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
