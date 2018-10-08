
/* eslint no-sync: 0 */

const winston = require('winston');

module.exports = function preboot(app, options, next) {
  app.preboot(require('slay-config')());

  app.preboot(require('slay-log')({
    transports: [
      new (winston.transports.Console)({
        raw: app.env !== 'local'
      })
    ]
  }));

  app.preboot(require('./setup'));
  next();

};


