'use strict';

var wrhs = require('warehouse-models');
var Feedsme = require('../feedsme');
const { DynamoDB } = require('aws-sdk');
var dynamo = require('dynamodb-x');
const AwsLiveness = require('aws-liveness');
const liveness = new AwsLiveness();
var HttpsAgent = require('https').Agent;
var HttpAgent = require('http').Agent;

module.exports = function setup(app, options = { dynamo: {} }, next) {
  const ensure = app.config.get('ensure') || options.ensure;
  //
  // Setup the feedsme instance and other helpers.
  //
  const region = app.config.get('AWS_REGION') || app.config.get('dynamo:region') || options.dynamo.region;
  // Used mainly for localstack usage
  const endpoint = app.config.get('DYNAMO_ENDPOINT') || app.config.get('dynamo:endpoint') || options.dynamo.endpoint;
  const driver = new DynamoDB({ region, endpoint });

  dynamo.dynamoDriver(driver);
  app.dynamo = dynamo;
  app.models = options.models || wrhs(app.dynamo);

  app.agents = agents(app, options);
  app.feedsme = new Feedsme(app);


  liveness.waitForServices({
    clients: [driver],
    waitSeconds: app.config.get('dynamo:waitSeconds') || 60
  }).then(() => {
    if (ensure) return app.models.ensure(next);
    next();
  }).catch(next);
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
