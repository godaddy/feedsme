

var errs = require('errs');

//
// TODO: this should be in configuration or constants
// or something immutable of that nature.
//
var envs = ['dev', 'prod', 'test'];

module.exports = function setupParams(router) {
  //
  // @param :env used in:
  //
  // /meta/:env/:pkg/:version
  //
  router.param('env', function (req, res, next, env) {
    if (!~envs.indexOf(env)) {
      return next(errs.create({
        message: 'Incorrect environment requested'
      }));
    }

    next();
  });

  return router;
};
