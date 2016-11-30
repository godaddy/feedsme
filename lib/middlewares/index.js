'use strict';

var bodyParser = require('body-parser');

//
// Add middlewares.
//
module.exports = function middleware(app, options, done) {
  app.perform('middleware', function performAfter(next) {
    app.use(bodyParser.urlencoded(app.config.get('json')));
    app.use(bodyParser.json(app.config.get('json')));

    app.use(function httpLogger(req, res, next) {
      app.log.info('%s request - %s', req.method, req.url);
      next();
    });

    app.after('actions', function postRouting(next) {
      app.log.verbose('Adding post-routing middleware');

      app.use(require('./404')(app));
      app.use(require('./500')(app));

      next();
    });

    next();
  }, done);
};
