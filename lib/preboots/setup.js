var wrhs = require('warehouse-models');
var Feedsme = require('../feedsme');
var Datastar = require('datastar');

var HttpsAgent = require('https').Agent;
var HttpAgent = require('http').Agent;

module.exports = function setup(app, options, next) {
  const ensure = app.config.get('ensure') || options.ensure;
  //
  // Setup the feedsme instance and other helpers.
  //
  app.datastar = options.datastar || new Datastar(app.config.get('datastar') || {
    config: app.config.get('cassandra')
  });
  app.models = options.models || wrhs(app.datastar);

  app.agents = agents(app, options);
  app.feedsme = new Feedsme(app);

  if (!ensure) return app.datastar.connect(next);
  app.datastar.connect(err => {
    if (err) return next(err);
    app.models.ensure(next);
  });
};

var agentDefaults = {
  keepAlive: true
};

function agents(app, options) {
  var opts = app.config.get('agent') || options.agent || agentDefaults;
  return new Agents(opts);
}


function Agents(opts) {
  var http = new HttpAgent(opts);
  var https = new HttpsAgent(opts);

  this.http = http;
  this.https = https;
  this['https:'] = https;
  this['http:'] = http;
}
