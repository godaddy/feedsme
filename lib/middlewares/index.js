'use strict';

var bodyParser = require('body-parser');
var healthcheck = /healthcheck/;
var rid = 0;

//
// Add middlewares.
//
module.exports = function middleware(app, options, done) {
  app.perform('middleware', function performAfter(next) {
    app.use(bodyParser.urlencoded(app.config.get('json')));
    app.use(bodyParser.json(app.config.get('json')));

    app.use(function httpLogger(req, res, fn) {
      // Reduce healthcheck logs as it creates unnecessary noise
      if (healthcheck.test(req.url) && rid++ % 50 !== 0) return fn();
      app.log.info('%s request - %s', req.method, req.url);
      fn();
    });

    app.after('actions', function postRouting(fn) {
      app.log.verbose('Adding post-routing middleware');

      app.use(require('./404')(app));
      app.use(require('./500')(app));

      fn();
    });

    next();
  }, done);
};
