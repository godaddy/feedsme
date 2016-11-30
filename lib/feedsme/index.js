/* eslint max-nested-callbacks: 0 */
'use strict';

var Carpenter = require('carpenter-api-client');
var jsonStream = require('json-stream');
var once = require('one-time');
var async = require('async');
var url = require('url');

var assign = Object.assign;

/**
 * Little Feedsme instance to process all incoming and outgoing changes.
 *
 * @constructor
 * @param {Slay} app Reference to the slay instance we're mounted on
 * @api private
 */
function Feedsme(app) {
  if (!this) return new Feedsme(app);

  var uri = app.config.get('carpenter');
  var proto = url.parse(uri).protocol;

  this.carpenter = new Carpenter({
    uri: uri,
    agent: app.agents[proto]
  });

  this.app = app;
  this.debug = this.app.log.debug.bind(this.app.log);
}

/**
 * Process the incoming change of an npm package.
 *
 * @param {String} env Environment for the builds.
 * @param {Object} data Package.json of the latest build.
 * @param {Fucntion} fn Completion callback.
 * @api private
 */
Feedsme.prototype.change = function change(env, data, fn) {
  var pkg = this.extractLatest(data);
  var app = this.app;
  //
  // TODO: Figure out if we can get previous here or if we need to do a GET on
  // artifactory which would kind of suck
  //

  var meta = {
    name: pkg.name,
    version: pkg.version,
    env: env
  };

  function finish(err) {
    if (err) return fn(err);

    app.log.info('Successfully processed change for %s@%s in %s',
        pkg.name, pkg.version, env, meta);
    fn.apply(fn, arguments);
  }

  app.log.info('Processing change for %s@%s in %s',
      pkg.name, pkg.version, env, meta);

  async.parallel([
    this.trigger.bind(this, env, data),
    this.resolve.bind(this, env, pkg)
  ], finish);
};

/**
 * Trigger new builds for all the stored dependencies.
 *
 * @param {String} env Environment for the builds.
 * @param {Object} data Package.json of the latest build.
 * @param {Function} fn Completion callback
 * @api private
 */
Feedsme.prototype.trigger = function trigger(env, data, fn) {
  var Dependent = this.app.models.Dependent;
  var Package = this.app.models.Package;
  var Version = this.app.models.Version;
  var npm = this.app.config.get('npm');
  var debug = this.debug;
  var name = data.name;
  var feedsme = this;

  debug('Trying to rebuild the dependents of %s', name);

  Dependent.get(name, function found(err, data) {
    if (err || !data) {
      if (err) debug('failed to retrieve dependents of %s:', name, err.message, {
        innerErrors: err.innerErrors,
        stack: err.stack
      });
      else { debug('found no dependents %s', name); }

      return fn(err);
    }

    async.each(data.dependents, function notify(pack, fn) {
      debug('finding the package %s', pack);

      Package.get(pack, function packages(err, pkg) {
        if (err || !pkg) {
          if (err) debug('failed to look up pkg %s due to err %s', pack, err.message, {
            innerErrors: err.innerErrors,
            stack: err.stack
          });
          else { debug('pkg %s not found in cassandra', pack); }

          return fn(err);
        }

        //
        // Remove all the datastar model garbage so we can get a clean object to
        // manipulate and pass along.
        //
        pkg = pkg.toJSON();
        debug('finding the version information of %s:%s', pkg.name, pkg.version);

        Version.get(pkg.name + '@' + pkg.version, function found(err, version) {
          if (!version || err) {
            if (err) debug('failed to lookup dependent %s of %s', pkg, name, err);
            else { debug('unable to find %s@%s', pkg.name, pkg.version); }

            return fn(err);
          }

          debug('getting the attachments for %s', pkg.name);
          version.getAttachment(npm, function attached(err, body) {
            if (!body || err) {
              if (err) debug('failed to lookup attachment for %s@%s, received error: %s', pkg.name, pkg.version, err.message);
              else { debug('No attachment available for %s@%s', pkg.name, pkg.version); }

              return fn(err);
            }

            var data = JSON.parse(body.value);
            data._attachments = body._attachments;

            Object.keys(pkg).forEach(function merge(key) {
              if (key in data) return;
              //
              // Specially handle dist-tags to make sure we have the latest
              // for the particular package since this is stored as camelCase
              // since we cannot store dash based keys in C*
              //
              if (key === 'distTags') {
                data['dist-tags'] = pkg[key];
                return;
              }

              data[key] = pkg[key];
            });

            //
            // Force the environment on which we need to build in as this is
            // what we received as initiator.
            //
            data.env = env;

            feedsme.app.log.info('triggering a carpenter build for ' + data.name);
            feedsme.build(data, fn);
          });
        });
      });
    }, fn);
  });
};

/**
 * Send a build to carpenter
 * @param {Object} data - Package data that will be sent to carpenter
 * @param {function} done - continuation to call when we realize we haven't
 * errored
 */
Feedsme.prototype.build = function build(data, done) {
  var self = this;
  var fn = once(done);

  var meta = {
    env: data.env,
    name: data.name,
    distTags: data['dist-tags']
  };

  function onError(err) {
    self.app.log.error('carpenter build errored', assign({
      message: err.message,
      stack: err.stack
    }, meta));
    return fn(err);
  }

  //
  // Send build to carpenter and trace the build logs we receive back
  //
  this.carpenter.build({ data: data }, (err, buildLog) => {
    if (err) {
      return onError(err)
    }
    //
    // The big question here is do we wait to respond for the builds to fully
    // complete? I think to save sockets it doesnt matter, we should only return
    // early on an error because we cant really do anything if a build errors
    // anyway, we might as well just have the logs though. We only wait and
    // detect an error from carpenter when we tag something in the design
    // models because we have the power to then delete the tag.
    //
    buildLog
      .once('error', onError)
      .pipe(jsonStream())
      .once('error', onError)
      .on('data', d => {
        this.app.log.info('carpenter build status', assign(d, meta));
        //
        // Just return early so we dont keep the socket open
        //
        if (d.event !== 'error') fn();
      })
      .on('end', () => {
        this.app.log.info('carpenter build log has ended', meta);
      });
  });
};

/**
 * Resolve the dependencies of the given package.
 *
 * @TODO We should compare the resolved packages with the result of the previous
 * version so we know if we have to remove a package from a dependent.
 *
 * @param {String} env Environment for the builds.
 * @param {Object} data Package.json of the latest build.
 * @param {Function} fn Completion callback
 * @api private
 */
Feedsme.prototype.resolve = function resolve(env, data, fn) {
  var Dependent = this.app.models.Dependent;
  var Package = this.app.models.Package;
  var debug = this.debug;
  var feedsme = this;

  debug('resolving dependent for %s', data.name);

  //
  // Only find the top level components, if we also find the dependencies of
  // these dependencies we will trigger multiple builds as a change in a sub
  // dependency will already trigger a build of the parent module, which
  // should cascade upwards until the last dependent module is triggered.
  //
  async.filter(Object.keys(data.dependencies || {}), function filter(name, next) {
    Package.get(name, function exists(err, data) {
      if (err || !data) return next(false);
      return next(true);
    });
  }, function found(results) {
    debug('Found %d private dependencies for %s', results.length, data.name);

    async.each(results, function insert(dependency, next) {
      debug('Lookup dependents of %s', dependency);

      Dependent.get(dependency, function found(err, row) {
        if (err) {
          debug('Failed to lookup dependent %s', dependency, err);
          return next(err);
        }

        if (row && ~row.dependents.indexOf(data.name)) {
          debug('ignoring %s, is already a dependent of %s', data.name, dependency);
          return next();
        }

        if (row) {
          feedsme.app.log.info('Appending ' + data.name + ' as dependent of ' + dependency);

          return Dependent.update({
            name: dependency,
            dependents: {
              add: [data.name]
            }
          }, next);
        }

        feedsme.app.log.info('Adding ' + data.name + ' as dependent of ' + dependency);
        Dependent.create({
          name: dependency,
          dependents: [data.name]
        }, next);
      });
    }, fn);
  });
};

/**
 * Get the package.json content from the payload.
 *
 * @param {Object} data Payload content.
 * @returns {Object} Package.json
 * @api private
 */
Feedsme.prototype.extractLatest = function extractLatest(data) {
  var version = (data.distTags || data['dist-tags'] || {}).latest;

  return (data.versions || {})[version] || {};
};

/**
 * Destroy the Feedsme instance so we can have the .app instance reclaimed by
 * the V8 garbage collector.
 *
 * @returns {Boolean} indication of destruction.
 * @api private
 */
Feedsme.prototype.destroy = function destroy() {
  if (!this.app) return false;

  this.app = null;

  return true;
};

//
// Expose the feedsme
//
module.exports = Feedsme;
