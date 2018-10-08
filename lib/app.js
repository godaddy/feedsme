

var util = require('util');
var slay = require('slay');

module.exports = App;

util.inherits(App, slay.App);

function App(root, opts) {
  slay.App.call(this, root, opts);

  this.env = process.env.NODE_ENV || 'development'; // eslint-disable-line

  //
  // Default to an object here
  //
  this.agents = {};
  //
  // Close our database connection after we close our http servers
  //
  this.after('close', onClose);
}

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
