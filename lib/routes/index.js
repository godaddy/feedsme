'use strict';

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
    // ### /change
    // A package has been updated
    //
    app.routes.post('/change/:env', function (req, res) {
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

      app.feedsme.change(req.params.env, req.body, function changed(err) {
        if (err) {
          app.log.error('failed to trigger a change for ' + req.body.name + ', received error: ' + err.message);

          return res.status(500).send({
            message: err.message,
            ok: false
          });
        }

        res.status(200).send({
          ok: true
        });
      });
    });

    next();
  }, done);
};
