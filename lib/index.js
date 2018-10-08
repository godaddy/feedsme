

var path = require('path');
var App = exports.App = require('./app');

/**
 * Create a new application and start it.
 *
 * @param {Object} options - Options object
 * @param {Function} done Completion callback.
 *
 * @returns {slay.App} An application that is starting
 * @api public
 */
exports.start = function start(options, done) {
  var app;

  if (!done && typeof options === 'function') {
    done = options;
    options = {};
  }

  app = new App(path.join(__dirname, '..'), options);

  return app.start(function started(err) {
    if (err) app.log.error('failed to start the feedsme service', err.message);

    done(err, app);
  });
};
