'use strict';
/* eslint max-nested-callbacks: 0 */

var Carpenter = require('carpenterd-api-client');
var Warehouse = require('warehouse.ai-api-client');
var ReleaseLine = require('@wrhs/release-line');
var jsonStream = require('json-stream');
var { AwaitWrap } = require('dynastar');
var thenify = require('tinythen');
var pFilter = require('p-filter');
var pLimit = require('p-limit');
var clone = require('clone');
var semver = require('semver');
var NpmRegistry = require('npm-registry-client');
var url = require('url');
var { promisify } = require('util');

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
    uri,
    agent: agents[proto]
  });

  // Make awaitable models
  this.models = Object.entries(models).reduce((acc, [key, model]) => {
    acc[key] = new AwaitWrap(model);
    return acc;
  }, {});

  this.release = new ReleaseLine({ models });
  this.registry = new NpmRegistry({
    retry: {
      count: 3,
      factor: 2,
      randomize: true
    }
  });

  const npm = config.get('npm');
  const { auth, ...parsed } = url.parse(npm);
  this.registryUrl = url.format(parsed).replace(/\/$/, '');
  const [username, password] = (auth || '').split(':');

  this.registryParams = {
    fullMetadata: true,
    auth: {
      username,
      password,
      alwaysAuth: true
    }
  };
  this.config = config;
  this.log = log;
  this.conc = config.get('concurrency') || 20;
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
 * @param {Object} opts feedsme change options
 * @param {Object} opts.data Package.json of the latest build.
 * @param {Boolean} opts.promote Should the build be promoted?
 * @param {Fucntion} done Completion callback.
 * @api private
 */
Feedsme.prototype.change = async function change(env, { data, promote = true }) {
  const pkg = this.extractLatest(data);
  const { name, version } = pkg;

  const meta = { name, version, env };

  this.log.info(`Processing change for ${ pkgName(pkg) } in ${ env }`, meta);

  //
  // Update dependent and dependent_of models for reference
  //
  await this.resolve(env, pkg);

  //
  // Trigger dependent builds and add dependents to parent release line if it
  // exists
  //
  await this.trigger(env, data, promote);

  this.log.info(`Successfully processed change for ${ pkgName(pkg) } in ${ env }`, meta);
};

/**
 * Trigger potential dependent builds and depOf additions for dependents that
 * have been published
 *
 * @param {String} env Environment we are triggerign for
 * @param {Object} data full publish payload of package
 * @param {Boolean} promote Should the build be promoted?
 * @returns {Promise} to be resolved
 */
Feedsme.prototype.trigger = function trigger(env, data, promote) {
  const publish = env === 'dev' && data.__published;
  const pkg = this.extractLatest(data);

  return Promise.all([
    // Root or Main package triggers dependent builds
    this.triggerDep({ publish, promote, env, pkg }),
    // Dependent packages associate with their release-line, only on publish
    publish && this.triggerDepOf({ pkg })
  ].filter(Boolean));
};

/**
 * Update the releaseline of the given package with the versions of the
 * dependent builds.
 *
 * @param {Object} options Options
 * @param {Object} options.pkg Package sent to us
 * @returns {Promise} to resolves
 * @api private
 */
Feedsme.prototype.triggerDepOf = async function triggerDepOf({ pkg }) {
  const { DependentOf } = this.models;
  const { name, version } = pkg;

  const depOf = await DependentOf.get(name);

  if (!depOf || (depOf && !depOf.dependentOf)) return this.log.info(`${name} does not have a parent package it depends on`);

  this.log.info(`trigger depOf`, depOf.toJSON());
  // Fetch the release line for the parent package that owns it
  const depOfName = depOf.dependentOf;
  let releaseLine = await this.release.get({ pkg: depOfName });

  if (!releaseLine) return this.log.info(`No release line found for ${depOfName}`);

  const rootPkgRange = pkg.dependencies[releaseLine.pkg];

  //
  // Since we've fetched the latest version we check to see if this dependent
  // package publish is meant for an older release line
  //
  if (!semver.satisfies(releaseLine.version, rootPkgRange)) {
    releaseLine = await this._walkReleaseLine({
      condition: line => !semver.satisfies(line.version, rootPkgRange),
      releaseLine
    });
  }

  if (!releaseLine) return this.log.info(`Could not find ${depOfName} releaseLine to satisfy ${rootPkgRange}`);

  this.log.debug(`Adding dependent ${name}@${version} to releaseLine`, releaseLine);
  //
  // Attach the package being built to the parent package release line
  //
  await this.release.dependent.add({
    pkg: releaseLine.pkg,
    version: releaseLine.version,
    dependent: name,
    dependentVersion: version
  });
};

/**
 * Trigger new builds for all the stored dependents.
 *
 * @param {Object} options Options for triggering all dependents
 * @returns {Promise} to resolve
 * @api private
 */
Feedsme.prototype.triggerDep = async function triggerDep({ publish, promote, env, pkg }) {
  const { Dependent } = this.models;
  const { name, version } = pkg;

  //
  // Fetch previous release-line for creating a fresh one or current release-line
  // to be used for triggering dependent builds as well as the dependents for
  // the given package
  //
  const [releaseLine, dep] = await Promise.all([
    publish ? this.release.get({ pkg: name }) : this.release.get({ pkg: name, version }),
    Dependent.get(name)
  ]);

  const spec = {
    previousVersion: releaseLine && releaseLine.version,
    pkg: name,
    version
  };

  // If we are a publish, create a release-line
  // NOTE: this version can be innaccurate if the npm publish was done with
  // a tag that !== latest. We should handle this case at some point.
  if (publish) {
    if (spec.previousVersion === spec.version) {
      this.log.warn(`${name}@${version} already has release-line, ignoring release-line create`);
    } else {
      this.log.info('create release-line', spec);
      await this.release.create(spec);
    }
  }

  this.log.debug(`Trying to rebuild the dependents of ${ name }`);
  if (!dep || (dep && dep.dependents.length === 0))
    return this.log.debug(`Found no dependents for ${ name }`);

  const limiter = pLimit(this.conc);

  return Promise.all(
    dep.dependents.map(name => {
      return limiter(() => this._triggerOneDep({ publish, promote, rootPkg: pkg, env, name, releaseLine }));
    })
  );
};

/**
 * Assess and possibly trigger the build of a single dependent
 *
 * @param {Object} options Options to be used
 * @param {Boolean} options.publish Whether or not this was a publish
 * @param {String} options.env Environment to trigger build/publish for
 * @param {Object} options.rootPkg Parent package for this dependent
 * @param {String} options.name Name of the dependent package
 * @param {Object} [options.releaseLine] ReleaseLine of the parent package
 * @returns {Promise} to be resolved
 * @api private
 */
Feedsme.prototype._triggerOneDep = async function _triggerOneDep({ publish, promote, env, rootPkg, name, releaseLine }) {
  const { Package, Version, BuildHead } = this.models;
  //
  // Grab the releaseVersion for the dependent if it exists in the
  // releaseLine. This is used for correct promotion from DEV -> TEST and
  // TEST -> PROD. Main package version owns the dependent package versions
  // which get promoted that were established upon publish
  //
  const releaseVersion = releaseLine && releaseLine.dependents && releaseLine.dependents[name];

  let [pkg, registryRootPkg] = await Promise.all([
    Package.get(name),
    // This is temporary solution until we can efficiently fetch all versions of
    // a given package from warehouse Version records which will happen with
    // DynamoDB conversion
    this._fetchFromRegistry(rootPkg.name)
  ]);
  if (!pkg) return this.log.debug(`Package ${ name } not found in cassandra`);
  if (!registryRootPkg) return this.log.debug(`Package ${ rootPkg.name } not found in configured registry`);

  pkg = pkg.toJSON();

  //
  // If our newest version of our rootPkg published here is a new major
  // version, we need to see if the dependent would be properly inclusive of
  // the new version. If not, we detect if its a previousMajor or nextMajor and
  // take appropriate action for preventing trigger or having the correct
  // auto-increment take place.
  //
  const { strategy, trigger, fetchReleaseVersion } = this._triggerStrategy({
    registryRootPkg,
    releaseVersion,
    releaseLine,
    rootPkg,
    pkg,
    env
  });

  this.log.info('trigger strategy results', { strategy, trigger, fetchReleaseVersion });
  if (!trigger) return this.log.info(`Not triggering dependent build for ${pkgName(pkg)}, doesnt include ${rootPkg.name} version ${rootPkg.version}`);


  let previousReleaseVersion;
  //
  // If we need to fetch a specific release line from a specific version that
  // has been published previously, we do it here and use it.
  //
  if (publish && fetchReleaseVersion) {
    this.log.info(`fetch previous releaseline for ${rootPkg.name}@${fetchReleaseVersion}`);
    const line = await this.release.get({ pkg: rootPkg.name, version: fetchReleaseVersion });
    previousReleaseVersion = line.dependents[name];
    this.log.info('found previousReleaseVersion', { name, previousReleaseVersion });
  }

  //
  // If we have published and we need to get the previous Major version
  //
  if (publish && strategy === 'previous') {
    // Setup the target to be the previous major version
    const target = semver.major(releaseLine.version) - 1;
    this.log.info('trigger strategy previous, looking for target for the given reaseLine', { target, releaseLine });
    const line = await this._walkReleaseLine({
      condition: (line) => target < semver.major(line.version),
      releaseLine
    });
    previousReleaseVersion = line.dependents[name];
    this.log.info('found previousReleaseVersion', { name, previousReleaseVersion });
  }

  let fetchVersion;
  if (!publish && releaseVersion) fetchVersion = releaseVersion;
  else if (previousReleaseVersion) fetchVersion = previousReleaseVersion;
  else fetchVersion = pkg.version;

  this.log.debug(`Fetch version and BuildHead information of ${pkg.name}@${fetchVersion}`);

  const [version, head = { version: '0.0.0' }] = await Promise.all([
    // Lets fetch the realeaseVersion when we are not a publish and it exists
    Version.get(`${pkg.name}@${fetchVersion}`),
    BuildHead.get({ env, name })
  ]);

  if (!version) return this.log.debug(`Unable to find ${ pkgName(pkg) }`);
  //
  // Fetch attachment and setup the data structure properly
  //
  const data = await this._expandVersion({ version, pkg, env });
  if (!data) return this.log.warn(`No attachment found for ${pkgName(pkg)}`);

  //
  // Update the version so we arent overwriting the current latest
  // version when triggering a dependent build
  //
  let { payload, action } = this.increment({
    previousReleaseVersion,
    releaseVersion,
    payload: data,
    strategy,
    publish,
    head
  });

  if (action !== 'publish') {
    payload = { data: payload, promote };
  }

  this.log.info(`Triggering ${action} action for ${ data.name }`);
  return this[action](payload);
};

/**
 * Return the proper strategy and whether or not a build should be triggered
 *
 * @param {Object} options Options to be used
 * @param {Object} options.releaseLine ReleaseLine for parent package
 * @param {Object} options.rootPkg Parent package for dependet
 * @param {Object} options.pkg Dependent package
 * @param {Object} options.env Environment triggered for
 * @returns {Object} strategy and whether we should trigger
 * @api private
 */
Feedsme.prototype._triggerStrategy = function _triggerStrategy({ registryRootPkg = {}, releaseLine, rootPkg, pkg, env }) {
  if (env !== 'dev' && releaseLine) return { strategy: 'release', trigger: true };
  if (!releaseLine) return { strategy: 'legacy', trigger: true };

  const { name, version: rootVersion } = rootPkg;
  const { dependencies } = pkg;
  // The latest version that has been published at this point in time
  const latestRootPkgVersion = Object.keys(registryRootPkg.versions || {})
    // Sort so latest version is first in the array, desc order
    .sort((x, y) => semver.rcompare(x, y))
    // Grab first in the array which is latest by version
    .find(v => v !== rootVersion) || '0.0.0';

  let rootRange = dependencies[name];
  // Support legacy 'latest' and alias it to * so it doesnt fail semver.satisifes
  if (rootRange === 'latest') rootRange = '*';

  const rootDepVersion = semver.coerce(rootRange) || releaseLine.version;

  //
  // Compare the version from the dependent package to what was just published
  // and see if its inclusive
  //
  const inclusive = semver.satisfies(rootVersion, rootRange);
  if (!rootDepVersion) return { strategy: 'current', trigger: inclusive };

  //
  // Question: Do we even want to update a dependent package to the nextMajor
  // if its parent is updated to the nextMajor and still satisfies the semver
  // range? Or to make ease of publishing locally, just do regular build
  // incrementing. I think its less surprising to just do regular build
  // increment so it doesnt mess with future publishes
  //
  const previousMajor = semver.major(rootVersion) < semver.major(rootDepVersion);

  //
  // This gives us enough info to know if a fresh publish is a New Major
  // version never published before where we prevent dependent builds, or if it
  // is in line with a previous published major version but we had published
  // a previous major as the previous publish
  //
  const previousPublishedMajor = semver.major(rootVersion) === semver.major(latestRootPkgVersion);

  // If we are a previousMajor or a previous published Major version, we should
  // autotrigger builds since we can find where to increment from. It may be
  // possible to not have to walk the linked list for the previous case now
  // that we have this fully set of versions of the main package. TODO: we
  // should clean this up and leverage this.
  const trigger = previousMajor || previousPublishedMajor ? true : inclusive;
  let strategy;

  if (previousMajor) strategy = 'previous'; // auto increment after finding last previous version
  else strategy = 'current'; // auto increment from last build head

  let fetchReleaseVersion;
  if (previousPublishedMajor) fetchReleaseVersion = latestRootPkgVersion;

  return { strategy, trigger, fetchReleaseVersion };
};

/**
 * Fetch the versions attachment and appropriately modify the data structure
 *
 * @param {Object} options Options to be used
 * @param {Version} version Version object for dependent
 * @param {Object} pkg Package for dependent
 * @param {String} env Environment we are triggering for
 * @returns {Promise} to be resolved
 * @api private
 */
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
    // since we cannot store dash based keys in C*. We overwrite everything
    // except the latest tag since we rely on latest to be the version we
    // intend to deal with.
    //
    if (key === 'distTags') {
      Object.keys(pkg[key]).forEach(tag => {
        if (tag !== 'latest') data['dist-tags'][tag] = pkg[key][tag];
      });
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

/**
 * Walk the linked list of release line until the condition function is
 * satisfied or there is no more previousVersion
 *
 * @param {Object} options Options to be used
 * @param {Function} condition Used to evaluate terminating condition, if it returns true we continue to look
 * @param {Object} releaseLine ReleaseLine to be used to start the walk
 * @returns {Promise} wrapped releaseLine
 */
Feedsme.prototype._walkReleaseLine = async function _walkReleaseLine({ condition, releaseLine }) {
  const { pkg } = releaseLine;
  let line = releaseLine;
  while (line.previousVersion && condition(line)) {
    line = await this.release.get({ pkg, version: line.previousVersion });
  }

  //
  // If walk was never satisified, return null
  //
  if (!line.previousVersion && condition(line)) return null;
  return line;
};

/**
 * Simulate a publish of the npm package
 *
 * @param {Object} data - npm data object
 * @returns {Thenable} to be awaited
 * @api private
 */
Feedsme.prototype.publish = function _publish(data) {
  const name = data.name;
  return thenify(this.wrhs, 'publish', { name, data });
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
  const defaultInc = () => {
    //
    // We need to figure out the latest head version in case a rollback happened
    // which would mess up our whole system here. If our version fetched is
    // somehow greater than the current build head, we will increrment that
    // version only if its in the same major version line
    //
    const latestHead = this._latestHead(head);
    if (!latest.version ||
      (semver.lte(latest.version, latestHead) // head > latest.version
        && semver.major(latest.version) === semver.major(latestHead))) { // && same major version line
      version = semver.inc(latestHead, 'prerelease');
    } else if (latest.version) {
      version = semver.inc(latest.version, 'prerelease');
    }
  };

  //
  // Now lets go through our incrementing strategies
  //
  switch (strategy) {
    case 'current': {
      defaultInc();
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
      defaultInc();
      break;
  }

  this.log.info(`Potentially incrementing ${name}`, {
    prevVersion,
    releaseVersion,
    previousReleaseVersion,
    version,
    strategy,
    latestDistTag: payload && payload['dist-tags'] && payload['dist-tags'].latest
  });
  this.log.debug(`Previous versions for ${name}`, {
    versions: payload && payload.versions && Object.keys(payload.versions)
  });

  //
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

  if (publish) payload.__published = true;
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
 * Fetch a given package name from the configured registry
 *
 * @param {String} name - Package name
 * @returns {Promise<Object>} Wrapped pkg object
 */
Feedsme.prototype._fetchFromRegistry = function (name) {
  const uri = `${this.registryUrl}/${encodeURIComponent(name)}`;
  const get = promisify(this.registry.get.bind(this.registry));
  return get(uri, this.registryParams);
};

/**
 * Send a build to carpenter
 * @param {Object} opts - build options
 * @param {Object} opts.data - Package data that will be sent to carpenter
 * @param {Boolean} opts.promote - Should the build be promoted?
 * @returns {Promise} to be resolved
 */
Feedsme.prototype.build = function build({ data, promote = true }) {
  var self = this;

  var meta = {
    env: data.env,
    name: data.name,
    distTags: data['dist-tags']
  };

  return new Promise((resolve, reject) => {
    function onError(err) {
      self.log.error('carpenter build errored', assign({
        message: err.message,
        stack: err.stack
      }, meta));
      return reject(err);
    }

    //
    // Send build to carpenter and trace the build logs we receive back
    //
    this.carpenter.build({ data: { promote, data } }, (err, buildLog) => {
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
          if (d.event !== 'error') resolve();
        })
        .on('end', () => {
          this.log.info('Carpenter build log has ended', meta);
        });
    });
  });
};

/**
 * Resolve the dependencies of the given package.
 *
 * @TODO We should remove this magic and make it explicit config
 *
 * @param {String} env Environment for the builds.
 * @param {Object} data Package.json of the latest build.
 * @api private
 */
Feedsme.prototype.resolve = async function resolve(env, data) {
  const { Package } = this.models;
  const opts = { concurrency: this.conc };

  this.log.debug(`Resolving dependent for ${ data.name }`);

  //
  // Only find the top level components, if we also find the dependencies of
  // these dependencies we will trigger multiple builds as a change in a sub
  // dependency will already trigger a build of the parent module, which
  // should cascade upwards until the last dependent module is triggered.
  //
  const { dependencies, name } = data;
  async function filterer(name) {
    try {
      const pkg = await Package.get(name);
      if (!pkg) return false;
      return true;
    } catch (ex) {
      return false;
    }
  }

  // Filter out dependencies not managed by warehouse
  const results = await pFilter(Object.keys(dependencies), filterer, opts);

  this.log.debug(`Found ${ results.length } private dependencies for ${ data.name }`);

  const limiter = pLimit(this.conc);
  //
  // Update dependents and dependent_of models
  //
  await Promise.all(
    results.map(dependency => {
      return limiter(() => this._resolveOne({ name, dependency }));
    })
  );
};

/**
 * Resolve a single dependency for creating Dependents and DependentOf
 *
 * @param {Object} options Options to use
 * @param {String} options.name Name of package
 * @param {String} options.dependency Name of dependency
 * @returns {Promise} to be resolved
 * @api private
 */
Feedsme.prototype._resolveOne = function _resolveOne({ name, dependency }) {
  return Promise.all([
    this._resolveDep({ name, dependency }),
    this._resolveDepOf({ name, dependency })
  ]);
};

/**
 * Create or Update the dependent
 *
 * @param {Object} options Options to use
 * @param {String} options.name Name of package
 * @param {String} options.dependency Name of dependency
 * @returns {Promise} to be resolved
 * @api private
 */
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
/**
 * Create dependentOf
 *
 * @param {Object} options Options to use
 * @param {String} options.name Name of package
 * @param {String} options.dependency Name of dependency
 * @returns {Promise} to be resolved
 * @api private
 */
Feedsme.prototype._resolveDepOf = async function _resolveDepOf({ name, dependency }) {
  const { DependentOf } = this.models;

  this.log.info(`Adding ${ dependency } as depOf of ${ name }`);
  return DependentOf.create({
    pkg: name,
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
  if (!(this.models && this.release && this.log)) return false;

  this.models = null;
  this.release = null;
  this.log = null;

  return true;
};

//
// Expose the feedsme
//
module.exports = Feedsme;
