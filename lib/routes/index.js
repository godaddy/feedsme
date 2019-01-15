'use strict';

const asynk = require('express-async-handler');
//
// Define routes.
//
module.exports = function routes(app, options, done) {
  app.perform('actions', function performRoutes(next) {
    //
    // Setup our known param handlers for parameter names.
    //
    require('./params')(app.routes);

    app.log.verbose('Adding application routes');

    //
    // ### /healthcheck
    // Simple healthcheck
    //
    app.routes.get('/healthcheck(.html)?', function (req, res) {
      res.end('ok');
    });

    //
    // ### /v2/change
    // A package has been updated
    //
    app.routes.post('/v2/change/:env', asynk(async function (req, res) {
      app.log.info('Received a package processing request');

      if (!req.body || typeof req.body !== 'object' || !('data' in req.body) || !('name' in req.body.data)) {
        app.log.info('received invalid payload', {
          payload: req.body
        });

        return res.status(400).send({
          message: 'Invalid payload received',
          ok: false
        });
      }

      await app.feedsme.change(req.params.env, req.body);

      return res.status(200).send({
        ok: true
      });
    }));

    //
    // ### /change
    // A package has been updated
    //
    app.routes.post('/change/:env', asynk(async function (req, res) {
      app.log.info('Received a package processing request');

      if (!req.body || typeof req.body !== 'object' || !('name' in req.body)) {
        app.log.info('received invalid payload', {
          payload: req.body
        });

        return res.status(400).send({
          message: 'Invalid payload received',
          ok: false
        });
      }

      await app.feedsme.change(req.params.env, { promote: true, data: req.body });

      return res.status(200).send({
        ok: true
      });
    }));

    next();
  }, done);
};
