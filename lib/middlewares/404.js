

//
// Return 404 middleware.
//
module.exports = function mountfourohfour(app) {
  /**
   * Handle unknown routes.
   *
   * @param {HTTPRequest} req Incoming HTTP request.
   * @param {HTTPResponse} res Outgoing HTTP response.
   * @param {Function} next Completion callback.
   * @public
   */
  return function fourohfour(req, res, next) { // eslint-disable-line no-unused-vars
    app.log.error('Not found: %s - %s', req.method, req.url);

    res.status(404).send({
      message: 'Not found',
      ok: false
    });
  };
};
