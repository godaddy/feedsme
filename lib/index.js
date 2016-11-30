'use strict';

var path = require('path');
var App = exports.App = require('slay').App;

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

  app.env = process.env.NODE_ENV || 'development';
  //
  // Default to an object here
  //
  app.agents = {};

  //
  // Close our database connection after we close our http servers
  //
  app.after('close', onClose);

  return app.start(function started(err) {
    if (err) app.log.error('failed to start the feedsme service', err.message);

    done(err, app);
  });
};

/**
 * See if we have an datastar instance and close it if we do
 *
 * @param {slay.App} app - Global app object
 * @param {Object} options - Options object to deal with
 * @param {function} callback - continuation function
 *
 * @returns {Object} Nothing of significance.
 */
function onClose(app, options, callback) {
  Object.keys(app.agents).forEach(key => {
    app.agents[key].destroy();
  });

  if (!app.datastar) return setImmediate(callback);

  app.datastar.close(callback);
}
