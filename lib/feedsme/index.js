/* eslint max-nested-callbacks: 0 */
'use strict';

var Carpenter = require('carpenterd-api-client');
var Warehouse = require('warehouse.ai-api-client');
var jsonStream = require('json-stream');
var once = require('one-time');
var async = require('async');
var clone = require('clone');
var semver = require('semver');
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

  this.wrhs = new Warehouse(app.config.get('warehouse'));

  this.app = app;
}

/**
 * Return name and version from pacakge.
 *
 * @param {Object} pkg Package details.
 * @returns {String} name@version.
 * @api private
 */
function pkgName(pkg) {
  return `${ pkg.name }@${ pkg.version }`;
}

/**
 * Process the incoming change of an npm package.
 *
 * @param {String} env Environment for the builds.
 * @param {Object} data Package.json of the latest build.
 * @param {Fucntion} done Completion callback.
 * @api private
 */
Feedsme.prototype.change = function change(env, data, done) {
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
    if (err) return done(err);

    app.log.info(`Successfully processed change for ${ pkgName(pkg) } in ${ env }`, meta);
    done.apply(done, arguments);
  }

  app.log.info(`Processing change for ${ pkgName(pkg) } in ${ env }`, meta);
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
 * @param {Function} done Completion callback
 * @api private
 */
Feedsme.prototype.trigger = function trigger(env, data, done) {
  var feedsme = this;
  var app = feedsme.app;
  var BuildHead = app.models.BuildHead;
  var Dependent = app.models.Dependent;
  var Package = app.models.Package;
  var Version = app.models.Version;
  var npm = app.config.get('npm');
  var name = data.name;

  app.log.debug(`Trying to rebuild the dependents of ${ name }`);

  Dependent.get(name, function found(error, details) {
    if (error || !details) {
      if (error) {
        app.log.debug(`Failed to retrieve dependents of ${ name }: ${ error.message }`, {
          innerErrors: error.innerErrors,
          stack: error.stack
        });
      } else {
        app.log.debug(`Found no dependents ${ name }`);
      }

      return done(error);
    }

    async.eachLimit(details.dependents, 5, function notify(pack, fn) {
      app.log.debug(`Finding the package ${ pack }`);

      Package.get(pack, function packages(err, pkg) {
        if (err || !pkg) {
          if (err) {
            app.log.info(`Failed to look up package ${ pack } due to error ${ err.message }`, {
              innerErrors: err.innerErrors,
              stack: err.stack
            });
          } else {
            app.log.debug(`Package ${ pack } not found in cassandra`);
          }

          return fn(err);
        }

        //
        // Remove all the datastar model garbage so we can get a clean object to
        // manipulate and pass along.
        //
        pkg = pkg.toJSON();
        app.log.debug(`Finding version information of ${ pkgName(pkg) }`);

        async.parallel({
          version: Version.get.bind(Version, pkg.name + '@' + pkg.version),
          head: BuildHead.get.bind(BuildHead, { env, name: pkg.name })
        }, (e, { version, head = { version: '0.0.0' } }) => {
          if (!version || e) {
            if (e) {
              app.log.debug(`Failed to lookup dependent ${ pkg } of ${ name } `, err);
            } else {
              app.log.debug(`Unable to find ${ pkgName(pkg) }`);
            }

            return fn(err);
          }

          app.log.info(`Getting attachments for ${ pkg.name }`);
          version.getAttachment(npm, function attached(errored, body) {
            if (!body || errored) {
              if (errored) {
                app.log.debug(`Failed to lookup attachment for ${ pkgName(pkg) }, received error: ${ errored.message }`);
              } else {
                app.log.debug(`No attachment available for ${ pkgName(pkg) }`);
              }

              return fn(err);
            }

            data = JSON.parse(body.value);
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
            //
            // Update the version so we arent overwriting the current latest
            // version when triggering a dependent build
            //
            const { payload, action } = feedsme.increment(data, head);
            app.log.info(`Triggering ${action} action for ${ data.name }`);
            feedsme[action](payload, fn);
          });
        });
      });
    }, done);
  });
};

/**
 * Simulate a publish of the npm package
 *
 * @function increment
 * @param {Object} data - npm data object
 * @param {Function} fn - continuation function
 * @api private
 */
Feedsme.prototype.publish = function publish(data, fn) {
  const name = data.name;
  this.wrhs.publish({ name, data }, fn)
};

/**
 * Properly increment the version on the npm data-structure
 *
 * @function increment
 * @param {Object} payload - npm data object
 * @param {Object} head - latest build head for this package
 * @returns {Object} full data object
 * @api private
 */
Feedsme.prototype.increment = function inc(payload, head) {
  const latest = clone(this.extractLatest(payload));
  const name = latest.name || payload.name;
  const prevVersion = latest.version || payload.version;
  let prevTar = name + '-' + prevVersion + '.tgz'
  //
  // Remark: Figure out what the latest version is out of the two of these.
  // This matters for the cases where a new version was actually published even
  // though it normally gets built via dependent builds. We only increment the
  // version if the build-head is used, otherwise there is not a build
  // associated with the package version and we should use that to ensure
  // tarball reusage and proper version incrementing
  //
  let version = latest.version;
  let action = 'build';

  //
  // We need to figure out the latest head version in case a rollback happened
  // which would mess up our whole system here
  //
  const latestHead = this._latestHead(head);
  if (!latest.version || semver.lte(latest.version, latestHead)) {
    version = semver.inc(latestHead, 'prerelease');
    action = 'publish';
  }

  // Protect regular publishes that dont need the rest of this
  if (version === latest.version) return { payload, action };

  latest.version = version;
  // Unique identifier set in publish in npm-registry-client this should change
  // but we can keep the tarballs the same since the content doesnt change. In
  // the future we may want to make this more complete to be a 100% "proper" publish
  latest._id = `${name}@${version}`;
  payload.version = version;
  // kill previous versions so we dont grow out of hand
  payload.versions = {};
  payload.versions[version] = latest;
  payload['dist-tags'].latest = version;

  const tar = name + '-' + version + '.tgz';
  //
  // Modify attachments since carpenterd uses this as well based on version
  //
  payload._attachments = payload._attachments || {};
  const key = Object.keys(payload._attachments)[0];
  if (!payload._attachments[prevTar]) prevTar = key;
  payload._attachments[tar] = payload._attachments[prevTar] || {};
  delete payload._attachments[prevTar];

  return { payload, action };
};

/**
 *
 * Figure out latest head version for the particular package so we know what to
 * compare with and increment from
 *
 * @param {Object} head - build head record
 * @returns {String} latest build head version
 */
Feedsme.prototype._latestHead = function _latestHead(head) {
  const rollbackIds = head.rollbackBuildIds || {};

  return Object.keys(rollbackIds)
    .map(id => this._respec(rollbackIds[id]).version)
    .concat(head.version)
    .sort(semver.rcompare)[0];
};


/**
 * Turn the given buildId key into a spec object
 *
 * @param {String} key The given compiled key
 * @returns {Object} The normalized spec.
 */
Feedsme.prototype._respec = function respec(key) {
  const [name, env, version, locale] = key.split('!');

  return { name, env, version, locale };
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
        this.app.log.info('Carpenter build status', assign(d, meta));
        //
        // Just return early so we dont keep the socket open
        //
        if (d.event !== 'error') fn();
      })
      .on('end', () => {
        this.app.log.info('Carpenter build log has ended', meta);
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
 * @param {Function} done Completion callback
 * @api private
 */
Feedsme.prototype.resolve = function resolve(env, data, done) {
  var feedsme = this;
  var app = feedsme.app;
  var Dependent = app.models.Dependent;
  var Package = app.models.Package;

  app.log.debug(`Resolving dependent for ${ data.name }`);

  //
  // Only find the top level components, if we also find the dependencies of
  // these dependencies we will trigger multiple builds as a change in a sub
  // dependency will already trigger a build of the parent module, which
  // should cascade upwards until the last dependent module is triggered.
  //
  async.filter(Object.keys(data.dependencies || {}), function filter(name, next) {
    Package.get(name, function exists(err, details) {
      if (err || !details) return next(false);
      return next(true);
    });
  }, function found(results) {
    app.log.debug(`Found ${ results.length } private dependencies for ${ data.name }`);

    async.each(results, function insert(dependency, next) {
      app.log.debug(`Lookup dependents of ${ dependency }`);

      Dependent.get(dependency, function retrieved(err, row) {
        if (err) {
          app.log.debug(`Failed to lookup dependent ${ dependency }`, err);
          return next(err);
        }

        if (row && ~row.dependents.indexOf(data.name)) {
          app.log.debug(`Ignoring ${ data.name }, is already a dependent of ${ dependency }`);
          return next();
        }

        if (row) {
          app.log.info(`Appending ${ data.name } as dependent of ${ dependency }`);

          return Dependent.update({
            name: dependency,
            dependents: {
              add: [data.name]
            }
          }, next);
        }

        app.log.info(`Adding ${ data.name } as dependent of ${ dependency }`);
        Dependent.create({
          name: dependency,
          dependents: [data.name]
        }, next);
      });
    }, done);
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
