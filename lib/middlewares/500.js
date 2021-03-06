'use strict';

//
// Return 500 middleware.
//
module.exports = function mountfourohfour(app) {
  /**
   * Handle uncaught exceptions in the middleware.
   *
   * @param {Error} err Thing that caused us to fail
   * @param {HTTPRequest} req Incoming HTTP request.
   * @param {HTTPResponse} res Outgoing HTTP response.
   * @param {Function} next Completion callback.
   * @public
   */
  return function fivehundered(err, req, res, next) { // eslint-disable-line no-unused-vars
    const name = req.body && req.body.name;
    app.log.error('ERROR: %s - %s for %s', req.method, req.url, name, err);

    res.status(500).send({
      message: 'Internal Server Error: ' + err.message,
      ok: false
    });
  };
};
