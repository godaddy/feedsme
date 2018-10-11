/* eslint max-nested-callbacks: 0 */

var Carpenter = require('carpenterd-api-client');
var Warehouse = require('warehouse.ai-api-client');
var ReleaseLine = require('@wrhs/release-line');
var jsonStream = require('json-stream');
var { AwaitWrap } = require('datastar');
var thenify = require('tinythen');
var pFilter = require('p-filter');
var pLimit = require('p-limit');
var once = require('one-time');
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
function Feedsme({ agents, models, config, log }) {

  var uri = config.get('carpenter');
  var proto = url.parse(uri).protocol;

  this.wrhs = new Warehouse(config.get('warehouse'));
  this.carpenter = new Carpenter({
    uri: uri,
    agent: agents[proto]
  });

  // Make awaitable models
  this.models = Object.entries(models).reduce((acc, [key, model]) => {
    acc[key] = new AwaitWrap(model);
    return acc;
  }, {});

  this.release = new ReleaseLine({ models });
  this.config = config;
  this.log = log;
  this.conc = config.get('concurrency');
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
Feedsme.prototype.change = async function change(env, data) {
  const { Dependent, DependentOf } = this.models;
  const pkg = this.extractLatest(data);
  const publish = env === 'dev';

  const { name, version } = pkg;

  const meta = { name, version, env };

  this.log.info(`Processing change for ${ pkgName(pkg) } in ${ env }`, meta);
  // Update dependent and dependent_of models for reference
  await this.resolve(env, pkg);

  // Fetch things we need to figure out what exactly to do
  const [releaseLine, dep, depOf] = await Promise.all([
    publish ? this.release.head({ pkg: name }) : this.release.get({ pkg: name, version }),
    Dependent.get(pkg.name),
    DependentOf.get(pkg.name)
  ]);

  await Promise.all([
    // Root or Main package triggers dependent builds
    this.triggerDep({ env, releaseLine, pkg, dep }),
    // Dependent packages associate with their release-line, only on publish
    publish && this.triggerDepOf({ pkg, depOf })
  ].filter(Boolean));

  this.log.info(`Successfully processed change for ${ pkgName(pkg) } in ${ env }`, meta);
};

Feedsme.prototype.triggerDepOf = async function triggerDepOf({ pkg, depOf }) {
  if (!depOf || (depOf && !depOf.dependentOf)) return this.log.info(`${pkg.name} does not have a parent package it depends on`);

  // Fetch the release line for the parent package that owns it
  const line = await this.release.get({ pkg: depOf.dependentOf });

  await this.release.dependent.add({
    pkg: line.pkg,
    version: line.version,
    dependent: pkg.name,
    dependentVersion: pkg.version
  });
};


/**
 * Trigger new builds for all the stored dependents.
 *
 * @param {Object} options Options for triggering all dependents
 * @returns {Promise} to resolve
 * @api private
 */
Feedsme.prototype.triggerDep = async function triggerDep({ env, dep, releaseLine, pkg }) {
  const { name, version } = pkg;
  const spec = {
    previousVersion: releaseLine.previousVersion,
    pkg: name,
    version
  };
  const publish = env === 'dev';

  // If we are a publish, create a release-line
  // NOTE: this version can be innaccurate if the npm publish was done with
  // a tag that !== latest. We should handle this case at some point, fetch
  // package for version or something
  if (publish) {
    this.log.info('create release-line', spec);
    await this.release.create({
      previousVersion: releaseLine.previousVersion,
      pkg: name,
      version
    });
  }

  this.log.debug(`Trying to rebuild the dependents of ${ name }`);
  if (!dep || (dep && dep.dependents.length === 0))
    return this.log.debug(`Found no dependents for ${ name }`);

  const limiter = pLimit(this.conc);

  await Promise.all(
    dep.dependents.map(name => {
      return limiter(() => this._triggerOne({ rootPkg: pkg, env, name, releaseLine }));
    })
  );
};

Feedsme.prototype._triggerOne = async function triggerOne({ env, rootPkg, name, releaseLine }) {
  const { Package, Version, BuildHead } = this.models;
  //
  // Grab the releaseVersion for the dependent if it exists in the
  // releaseLine. This is used for correct promotion from DEV -> TEST and
  // TEST -> PROD. Main package version owns the dependent package versions
  // which get promoted that were established upon publish
  //
  const releaseVersion = releaseLine.dependents && releaseLine.dependents[name];
  const publish = env === 'dev';

  let pkg = await Package.get(name);
  if (!pkg) return this.log.debug(`Package ${ name } not found in cassandra`);

  pkg = pkg.toJSON();

  //
  // If our newest version of our rootPkg published here is a new major
  // version, we need to see if the dependent would be properly inclusive of
  // the new version. If not, we detect if its a previousMajor or nextMajor and
  // take appropriate action for preventing trigger or having the correct
  // auto-increment take place
  //
  const { strategy, trigger } = this._triggerStrategy({ env, rootPkg, pkg });
  if (!trigger) return this.log.info(`Not triggering dependent build for ${pkgName(pkg)}, doesnt include ${rootPkg.name} version ${rootPkg.version}`);

  this.log.debug(`Fetch version and BuildHead information of ${ pkgName(pkg) }`);

  const [version, head = { version: '0.0.0' }] = await Promise.all([
    // Lets fetch the realeaseVersion when we are not a publish and it exists
    !publish && releaseVersion ? Version.get(`${pkg.name}@${releaseVersion}`) : Version.get(`${pkg.name}@${pkg.version}`),
    BuildHead.get({ env, name })
  ]);

  if (!version) return this.log.debug(`Unable to find ${ pkgName(pkg) }`);
  //
  // Fetch attachment and setup the data structure properly
  //
  const data = await this._expandVersion({ version, pkg, env });
  if (!data) return this.log.warn(`No attachment found for ${pkgName(pkg)}`);

  let previousReleaseVersion;
  //
  // If we have published and we need to get the previous Major version
  //
  if (publish && strategy === 'previous') previousReleaseVersion = await this._discoverPrevious({ name, releaseLine });
  //
  // Update the version so we arent overwriting the current latest
  // version when triggering a dependent build
  //
  const { payload, action } = this.increment({
    previousReleaseVersion,
    releaseVersion,
    payload: data,
    strategy,
    publish,
    head
  });

  this.log.info(`Triggering ${action} action for ${ data.name }`);
  await thenify(this, action, payload);
};

Feedsme.prototype._triggerStrategy = function triggerReady({ rootPkg, pkg, env }) {
  if (env !== 'dev') return { strategy: 'release', trigger: true };

  const { name, version: rootVersion } = rootPkg;
  const { version, dependencies } = pkg;
  const rootRange = dependencies[name];
  const rootDepVersion = semver.coerce(rootRange);
  //
  // Compare the version from the dependent package to what was just published
  // and see if its inclusive
  //
  const inclusive = semver.satisfies(rootVersion, rootRange);
  const nextMajor = semver.major(version) > semver.major(rootDepVersion);
  const previousMajor = semver.major(version) < semver.major(rootDepVersion);

  const trigger = previousMajor ? true : inclusive;
  let strategy;

  if (nextMajor) strategy = 'next'; // if inclusive, bump standalone to next major
  else if (previousMajor) strategy = 'previous'; // auto increment after finding last previous version
  else strategy = 'current'; // auto increment from last build head

  return { strategy, trigger };
};

Feedsme.prototype._expandVersion = async function ({ version, pkg, env }) {
  const npm = this.config.get('npm');

  this.log.info(`Getting attachments for ${ pkg.name }`);
  const body = await thenify(version, 'getAttachment', npm);
  if (!body) return null;

  const data = JSON.parse(body.value);
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
  return data;
};

Feedsme.prototype._discoverPrevious = async function _discoverPrevious({ name, releaseLine }) {
  // Setup the target to be the previous major version
  const target = semver.major(releaseLine.version) - 1;
  const { pkg } = releaseLine;
  let line = releaseLine;
  while (line.previousVersion && target < semver.major(line.version)) {
    line = await this.release.get({ pkg, version: line.previousVersion });
  }

  return line.dependents[name];

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
  this.wrhs.publish({ name, data }, fn);
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
Feedsme.prototype.increment = function inc({ publish, strategy, payload, head, previousReleaseVersion, releaseVersion }) {
  const latest = clone(this.extractLatest(payload));
  const name = latest.name || payload.name;
  const prevVersion = latest.version || payload.version;
  let prevTar = name + '-' + prevVersion + '.tgz';
  //
  // Remark: Figure out what the latest version is out of the two of these.
  // This matters for the cases where a new version was actually published even
  // though it normally gets built via dependent builds. We only increment the
  // version if the build-head is used, otherwise there is not a build
  // associated with the package version and we should use that to ensure
  // tarball reusage and proper version incrementing
  //
  let version = latest.version;
  const action = publish ? 'publish' : 'build';

  //
  // Now lets go through our incrementing strategies
  //
  switch (strategy) {
    case 'current': {
      //
      // We need to figure out the latest head version in case a rollback happened
      // which would mess up our whole system here
      //
      const latestHead = this._latestHead(head);
      if (!latest.version || semver.lte(latest.version, latestHead)) {
        version = semver.inc(latestHead, 'prerelease');
      }
      break;
    }
    // We are just building the release version specified by the releaseLine
    case 'release':
      version = releaseVersion;
      break;
    // We use the previousReleaseVersion we fetched
    case 'previous':
      version = semver.inc(previousReleaseVersion, 'prerelease');
      break;
    case 'next':
      version = semver.inc(prevVersion, 'major');
      break;
    default:
      break;
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
    self.log.error('carpenter build errored', assign({
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
      return onError(err);
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
        this.log.info('Carpenter build status', assign(d, meta));
        //
        // Just return early so we dont keep the socket open
        //
        if (d.event !== 'error') fn();
      })
      .on('end', () => {
        this.log.info('Carpenter build log has ended', meta);
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
 * @api private
 */
Feedsme.prototype.resolve = async function resolve(env, data) {
  const Package = this.models.Package;
  const opts = { concurrency: this.conc };

  this.log.debug(`Resolving dependent for ${ data.name }`);

  //
  // Only find the top level components, if we also find the dependencies of
  // these dependencies we will trigger multiple builds as a change in a sub
  // dependency will already trigger a build of the parent module, which
  // should cascade upwards until the last dependent module is triggered.
  //
  const { dependencies, name } = data;
  const filterer = async (name) => {
    try {
      const pkg = await Package.get(name);
      if (!pkg) return false;
      return true;
    } catch (ex) {
      return false;
    }
  };

  // Filter out dependencies not managed by warehouse
  const results = await pFilter(dependencies, filterer, opts);

  this.log.debug(`Found ${ results.length } private dependencies for ${ data.name }`);

  const limiter = pLimit(this.concurrency);
  //
  // Update dependents and dependent_of models
  //
  await Promise.all(
    results.map(dependency => {
      return limiter(() => this._resolveOne({ name, dependency }));
    })
  );

};

Feedsme.prototype._resolveOne = async function _resolveOne({ name, dependency }) {
  return Promise.all([
    this._resolveDep({ name, dependency }),
    this._resolveDepOf({ name, dependency })
  ]);
};
Feedsme.prototype._resolveDep = async function _resolveDep({ name, dependency }) {
  const { Dependent } = this.models;
  this.log.debug(`Lookup dependents of ${ dependency }`);

  const dependent = await Dependent.get(dependency);

  if (dependent && ~dependent.dependents.indexOf(name)) {
    this.log.debug(`Ignoring ${ name }, is already a dependent of ${ dependency }`);
    return;
  }

  if (dependent) {
    this.log.info(`Appending ${ name } as dependent of ${ dependency }`);
    return Dependent.update({
      name: dependency,
      dependents: {
        add: [name]
      }
    });
  }

  this.log.info(`Adding ${ name } as dependent of ${ dependency }`);
  return Dependent.create({
    name: dependency,
    dependents: [name]
  });


};

Feedsme.prototype._resolveDepOf = async function _resolveDepOf({ name, dependency }) {
  const { DependentOf } = this.models;

  return DependentOf.create({
    name,
    dependentOf: dependency
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
