/* eslint max-nested-callbacks: 0, no-invalid-this: 0, max-statements: 0, no-process-env: 0 */
require('make-promises-safe');

describe('feedsme', function () {

  var EventEmitter = require('events').EventEmitter;
  var sinonAssume = require('assume-sinon');
  var Feedsme = require('../lib/feedsme');
  var request = require('request');
  var assume = require('assume');
  var async = require('async');
  var sinon = require('sinon');
  var path = require('path');
  var feedsme = require('..');
  var nock = require('nock');
  var url = require('url');
  var semver = require('semver');
  var clone = require('clone');
  var fixtures = require('./fixtures');

  var carpenter = new EventEmitter();
  var root;
  var app;

  this.timeout(10000);
  assume.use(sinonAssume);

  function address(properties) {
    const socket = app.servers.http.address();
    return url.format(Object.assign({
      hostname: socket.address,
      port: socket.port,
      protocol: 'http'
    }, properties || {}));
  }

  function mockRequests(pkg = 'cows', version = '2.0.0') {
    //
    // Fake carpenter responses.
    //
    nock(app.config.get('carpenter'))
      .post('/v2/build')
      .reply(200, function reply(uri, body) {
        carpenter.emit('build', uri, body, this);

        return { ok: true };
      });

    nock(app.config.get('warehouse'))
      .put(`/${pkg}`)
      .reply(200, function (uri, body) {
        carpenter.emit('publish', uri, body, this);

        return { ok: true };
      });

    //
    // Fake npm responses.
    //
    nock(app.config.get('npm'))
      .get(`/${pkg}/-/${pkg}-${version}.tgz`)
      .reply(200, function (uri, body) {
        carpenter.emit('npm', uri, body, this);

        return require('fs').readFileSync(__filename); // eslint-disable-line no-sync
      });
  }

  function waitCarpenter(type = 'build') {
    return new Promise((resolve) => {
      carpenter.once(type, (uri, body) => {
        resolve({ uri, body });
      });
    });
  }

  before(function (next) {
    feedsme.start({
      log: {
        level: process.env.FEEDSME_LOG || 'critical'
      },
      ensure: true,
      config: {
        file: path.join(__dirname, '..', 'config.example.json'),
        overrides: {
          http: {
            host: '127.0.0.1',
            port: 0
          }
        }
      }
    }, function (err, instance) {
      if (err) return next(err);
      app = instance;

      root = address();
      next();
    });
  });

  after(function (next) {
    app.models.drop(() => app.close(next));
  });

  afterEach(function () {
    sinon.restore();
  });

  describe('routes', function () {
    it('returns a JSON payload for 404 routes', function (next) {
      request.get({
        uri: url.resolve(root, '/hello-world'),
        json: true
      }, function (err, res, body) {
        if (err) return next(err);

        assume(body).is.a('object');
        assume(body.ok).is.false();
        assume(body.message).equals('Not found');
        assume(res.statusCode).equals(404);

        next();
      });
    });

    it('returns a 500 & JSON Payload if something fails', function (next) {
      request.post({
        uri: url.resolve(root, '/change'),
        json: true,
        body: ''
      }, function (err, res, body) {
        if (err) return next(err);

        assume(body).is.a('object');
        assume(body.ok).is.false();
        assume(body.message).includes('Internal Server Error');
        assume(res.statusCode).equals(500);

        next();
      });
    });

    describe('POST /change/dev', function () {
      it('validates if it received a valid environment', function (next) {
        request.post({
          uri: url.resolve(root, '/change/spacecake'),
          json: true,
          body: { mybody: 'is ready' }
        }, function (err, res, body) {
          if (err) return next(err);

          assume(body).is.a('object');
          assume(body.ok).is.false();
          assume(body.message).includes('Internal Server');
          assume(body.message).includes('Incorrect environment');
          assume(res.statusCode).equals(500);

          next();
        });
      });

      it('validates if it received a valid package json', function (done) {
        async.each([
          {},
          { hello: 'world' },
          []
        ], function process(payload, next) {
          request.post({
            uri: url.resolve(root, '/change/dev'),
            json: true,
            body: payload
          }, function (err, res, body) {
            if (err) return next(err);

            assume(body).is.a('object');
            assume(body.ok).is.false();
            assume(body.message).equals('Invalid payload received');
            assume(res.statusCode).equals(400);

            next();
          });
        }, done);
      });

      it('Always promotes the build', function (done) {
        sinon.stub(app.feedsme, 'change');

        request.post({
          uri: url.resolve(root, '/change/dev'),
          json: true,
          body: { name: 'pkg' }
        }, function (err, res, body) {
          if (err) return done(err);

          assume(app.feedsme.change).is.calledWith('dev', sinon.match({ promote: true, data: sinon.match.object }));
          assume(body).is.a('object');
          assume(body.ok).is.true();
          assume(res.statusCode).equals(200);

          done();
        });
      });
    });

    describe('POST /v2/change/dev', function () {
      it('validates if it received a valid environment', function (next) {
        request.post({
          uri: url.resolve(root, '/v2/change/spacecake'),
          json: true,
          body: { mybody: 'is ready' }
        }, function (err, res, body) {
          if (err) return next(err);

          assume(body).is.a('object');
          assume(body.ok).is.false();
          assume(body.message).includes('Internal Server');
          assume(body.message).includes('Incorrect environment');
          assume(res.statusCode).equals(500);

          next();
        });
      });

      it('validates if it received a valid package json', function (done) {
        async.each([
          {},
          { hello: 'world' },
          []
        ], function process(payload, next) {
          request.post({
            uri: url.resolve(root, '/v2/change/dev'),
            json: true,
            body: payload
          }, function (err, res, body) {
            if (err) return next(err);

            assume(body).is.a('object');
            assume(body.ok).is.false();
            assume(body.message).equals('Invalid payload received');
            assume(res.statusCode).equals(400);

            next();
          });
        }, done);
      });

      it('accepts a promotion option', function (done) {
        sinon.stub(app.feedsme, 'change');

        const data = { name: 'pkg' };

        request.post({
          uri: url.resolve(root, '/v2/change/dev'),
          json: true,
          body: { promote: false, data }
        }, function (err, res, body) {
          if (err) return done(err);

          assume(app.feedsme.change).is.calledWith('dev', sinon.match({ promote: false, data: sinon.match(data) }));
          assume(body).is.a('object');
          assume(body.ok).is.true();
          assume(res.statusCode).equals(200);

          done();
        });
      });

      it('defaults to promoting', function (done) {
        sinon.stub(app.feedsme, 'trigger');

        const { root: data } = clone(fixtures.first);

        request.post({
          uri: url.resolve(root, '/v2/change/dev'),
          json: true,
          body: { data }
        }, function (err, res, body) {
          if (err) return done(err);

          assume(app.feedsme.trigger).is.calledWith('dev', sinon.match(data), true);
          assume(body).is.a('object');
          assume(body.ok).is.true();
          assume(res.statusCode).equals(200);

          done();
        });
      });

      it('promotes when promote = true', function (done) {
        sinon.stub(app.feedsme, 'trigger');

        const { root: data } = clone(fixtures.first);

        request.post({
          uri: url.resolve(root, '/v2/change/dev'),
          json: true,
          body: { promote: true, data }
        }, function (err, res, body) {
          if (err) return done(err);

          assume(app.feedsme.trigger).is.calledWith('dev', sinon.match(data), true);
          assume(body).is.a('object');
          assume(body.ok).is.true();
          assume(res.statusCode).equals(200);

          done();
        });
      });
    });
  });

  describe('Feedsme', function () {
    var fme;

    this.timeout(60000);

    before(function (next) {
      async.parallel([
        app.models.Package.create.bind(app.models.Package, fixtures.dependent),
        app.models.Package.create.bind(app.models.Package, fixtures.parent),
        app.models.Version.create.bind(app.models.Version, fixtures.version),
        app.models.BuildHead.create.bind(app.models.BuildHead, fixtures.head)
      ], next);
    });

    after(function (next) {
      async.parallel([
        app.models.Package.remove.bind(app.models.Package, fixtures.dependent),
        app.models.Package.remove.bind(app.models.Package, fixtures.parent),
        app.models.Version.remove.bind(app.models.Version, fixtures.version),
        app.models.BuildHead.remove.bind(app.models.BuildHead, fixtures.head)
      ], next);
    });

    beforeEach(function () {
      fme = new Feedsme(app);
      mockRequests();
    });

    afterEach(function () {
      fme.destroy();
    });

    describe('#_latestHead', function () {
      it('returns the latest build head version given a set of rollbackIds', function () {
        const head = {
          rollbackBuildIds: {
            'Thu Jun 08 2017 02:04:19 GMT+0000 (UTC)': 'some-package!dev!2.3.9-0!en-US',
            'Thu Jun 08 2017 02:27:11 GMT+0000 (UTC)': 'some-package!dev!2.3.9-2!en-US'
          },
          createDate: '2017-06-08T02:27:11.657Z',
          udpateDate: '2017-06-08T02:27:11.657Z',
          version: '2.3.9-1'
        };
        assume(fme._latestHead(head)).equals('2.3.9-2');
      });
    });

    describe('#_triggerStrategy', function () {
      it('resolves latest version correctly as * and shows any version as inclusive', function () {
        const rootPkg = { name: 'what', version: '6.0.1' };
        const pkg = { dependencies: { [rootPkg.name]: 'latest' } };
        const releaseLine = { version: '6.0.1' };
        const env = 'dev';

        const { strategy, trigger } = fme._triggerStrategy({ rootPkg, pkg, releaseLine, env });
        assume(strategy).is.equal('current');
        assume(trigger).is.equal(true);
      });
    });

    describe('#resolve', function () {
      it('only adds private dependencies to dependend', async function () {
        await fme.resolve('dev', fixtures.parent);

        const data = await fme.models.Dependent.get(fixtures.dependent.name);

        const dependent = data.dependents;

        assume(dependent).is.length(1);
        assume(dependent).is.a('array');
        assume(dependent).includes(fixtures.parent.name);

        const depOf = await fme.models.DependentOf.get(fixtures.parent.name);
        const dependentOf = depOf.dependentOf;
        assume(dependentOf).equals(fixtures.dependent.name);
      });
    });

    describe('#trigger', function () {
      it('triggers carpenter for each dependend module with pkgjson for dev: legacy', function (next) {
        next = assume.wait(2, next);

        carpenter.once('publish', function (uri, body) {
          assume(body).is.a('object');
          assume(body.name).equals(fixtures.parent.name);
          assume(body.dependencies).contains(fixtures.dependent.name);
          assume(body._attachments).is.a('object');
          assume(body._attachments).contains('cows-2.0.1-0.tgz');
          assume(body.env).equals('dev');
          assume(body['dist-tags'].latest).contains('-');
          assume(body.versions[body['dist-tags'].latest]._id).contains(body.version);

          next();
        });

        fme.trigger('dev', fixtures.dependentPayloadPublished).then(next.bind(null, null), next);
      });

      it('does not create a new release line when previous release.version is the same', async function () {
        const prevRelease = {
          pkg: fixtures.dependent.name,
          version: fixtures.dependent.version
        };

        sinon.stub(fme, 'triggerDepOf').resolves();
        const warnSpy = sinon.spy(fme.log, 'warn');
        sinon.stub(fme.models.Dependent, 'get').resolves({ dependents: [] });
        sinon.stub(fme.release, 'get').resolves(prevRelease);
        const rcreate = sinon.stub(fme.release, 'create').resolves();
        await fme.trigger('dev', fixtures.dependentPayloadPublished);

        assume(rcreate).is.not.called();
        assume(warnSpy).is.calledWith('email@2.0.0 already has release-line, ignoring release-line create');
        sinon.restore();
      });
    });

    describe(`#change`, function () {
      async function change(env, data, promote = true) {
        await fme.change(env, { data, promote });
      }

      before(function (done) {
        async.parallel([
          app.models.Package.remove.bind(app.models.Package, fixtures.dependent),
          app.models.Package.remove.bind(app.models.Package, fixtures.parent),
          app.models.Version.remove.bind(app.models.Version, fixtures.version),
          app.models.BuildHead.remove.bind(app.models.BuildHead, fixtures.head),
          app.models.Dependent.remove.bind(app.models.Dependent, fixtures.dependent),
          app.models.Dependent.remove.bind(app.models.Dependent, fixtures.first.rootHead)
        ], function () {
          async.parallel([
            app.models.Package.create.bind(app.models.Package, fixtures.dependent),
            app.models.Package.create.bind(app.models.Package, fixtures.parent),
            app.models.Version.create.bind(app.models.Version, fixtures.version),
            app.models.BuildHead.create.bind(app.models.BuildHead, fixtures.head)
          ], done);
        });
      });

      it('will trigger and resolve the package payload', async function () {
        const spyTrigger = sinon.spy(fme, 'trigger');
        const spyResolve = sinon.spy(fme, 'resolve');
        const spyDependent = sinon.spy(fme.models.Dependent, 'get');

        await change('prod', fixtures.payload);
        assume(spyTrigger.calledOnce).to.be.true();
        assume(spyResolve.calledOnce).to.be.true();
        // since resolve is called first rather than in parallel
        assume(spyDependent.firstCall).to.not.equal(null);
        assume(spyDependent.firstCall).to.be.calledWith('email');
      });

      it('will resolve and trigger consecutive package payloads, correctly create a release line and trigger build based on its version', async function () {
        const { Package, Version } = fme.models;
        const { root, rootPackage, rootVersion, child, childPackage, childVersion } = fixtures.first;
        await Promise.all([
          Package.create(rootPackage),
          Version.create(rootVersion)
        ]);
        await change('dev', root);

        await Promise.all([
          Package.create(childPackage),
          Version.create(childVersion)
        ]);
        await change('dev', child);

        const release = await fme.release.get({ pkg: root.name });
        assume(release.pkg).equals(root.name);
        assume(release.version).equals(rootPackage.version);
        assume(release.dependents).hasOwn(child.name);
        assume(release.dependents[child.name]).equals(childPackage.version);

        mockRequests(childPackage.name, childPackage.version);
        const [noPromoteBuildInfo] = await Promise.all([
          waitCarpenter(),
          change('test', root, false)
        ]);
        assume(noPromoteBuildInfo.body.promote).false();

        // mock the requests for the dependent build triggered by this build of
        // main package.
        mockRequests(childPackage.name, childPackage.version);
        const [buildInfo] = await Promise.all([
          waitCarpenter(),
          change('test', root)
        ]);

        const childPayload = buildInfo.body.data;
        const latest = fme.extractLatest(childPayload);
        // validate that this payload has the correct releaseVersion
        assume(childPayload.name).equals(child.name);
        assume(latest.version).equals(release.dependents[child.name]);

        // Is the promote option being passed through?
        assume(buildInfo.body.promote).true();

        await Promise.all([
          Package.create(latest),
          Version.create({
            versionId: `${latest.name}@${latest.version}`,
            name: latest.name,
            value: JSON.stringify(childPayload),
            version: latest.version
          })
        ]);

        await change('test', childPayload);
      });

      it('should simulate publish of existing root package (new major) and prevent dependent package builds when semver is not inclusive', async function () {
        const { Package, Version } = fme.models;
        const env = 'dev';
        const inc = 'major';
        const logSpy = sinon.spy(fme.log, 'info');
        let { root, rootPackage, rootVersion, child, childPackage, childVersion } = clone(fixtures.first);

        root = increment(root, 'payload', { env, inc });
        rootPackage = increment(rootPackage, 'package', { env, inc });
        rootVersion = increment(rootVersion, 'version', { env, inc });

        await Promise.all([
          Package.create(rootPackage),
          Version.create(rootVersion)
        ]);

        await change(env, root);
        assume(logSpy.args[3]).contains(`Not triggering dependent build for huh@2.0.0, doesnt include what version 3.0.0`);
        sinon.restore();

        //
        // Bump child package and dependencies to update release line
        //
        child = increment(child, 'payload', { env, inc, dependencies: [root.name] });
        childPackage = increment(childPackage, 'package', { env, inc, dependencies: [root.name] });
        childVersion = increment(childVersion, 'version', { env, inc });
        // Manually publish so the release line gets
        await Promise.all([
          Package.create(childPackage),
          Version.create(childVersion)
        ]);
        mockRequests(childPackage.name, childPackage.version);
        await change(env, child);

        const release = await fme.release.get({ pkg: rootPackage.name });
        assume(release.version).equals(rootPackage.version);
        assume(release.pkg).equals(rootPackage.name);
        assume(release.dependents).contains(childPackage.name);
        assume(release.dependents[childPackage.name]).equals(childPackage.version);
      });

      it('should simulate publish of existing root package (previous major) and build proper dependent package based on previous', async function () {
        const { Package, Version } = fme.models;
        let { root, rootPackage, rootVersion, childPackage } = clone(fixtures.first);
        const env = 'dev';
        const inc = 'minor';

        root = increment(root, 'payload', { env, inc });
        rootVersion = increment(rootVersion, 'version', { env, inc });
        rootPackage = increment(rootPackage, 'package', { env, inc });

        mockRequests(childPackage.name, childPackage.version);
        await Promise.all([
          Package.create(rootPackage),
          Version.create(rootVersion)
        ]);

        const prevrelease = await fme.release.get({ pkg: rootPackage.name });
        const [{ body }] = await Promise.all([
          waitCarpenter('publish'),
          change(env, root)
        ]);

        const latest = fme.extractLatest(body);
        delete latest._id;
        assume(semver.satisfies(root.version, latest.dependencies[rootPackage.name]));

        await Promise.all([
          Package.create(latest),
          Version.create({
            versionId: `${latest.name}@${latest.version}`,
            name: latest.name,
            version: latest.version,
            value: JSON.stringify(body)
          })
        ]);

        await change(env, body);
        const release = await fme.release.get({ pkg: rootPackage.name });
        assume(release.version).equals(rootPackage.version);
        assume(release.previousVersion).equals(prevrelease.version);
        assume(release.dependents).contains(latest.name);
        assume(release.dependents[latest.name]).equals(latest.version);
      });

      it('should publish new version of dependent package in semver of previous releaseLine and update accordingly', async function () {
        // relies on previous test currently
        const pkg = 'what';
        const version = '3.0.0';
        const env = 'dev';
        const inc = 'major';

        let { child, childPackage } = clone(fixtures.first);
        childPackage = increment(childPackage, 'package', { env, inc, dependencies: [pkg] });
        childPackage = increment(childPackage, 'package', { env, inc: 'minor' });
        child = increment(child, 'payload', { env, inc, dependencies: [pkg] });
        child = increment(child, 'payload', { env, inc: 'minor' });

        await change(env, child);

        const release = await fme.release.get({ pkg, version });
        assume(release.dependents).contains(childPackage.name);
        assume(release.dependents[childPackage.name]).equals(childPackage.version);
      });

      it('should simulate publish of existing root package (new major) and bump  version of dependent package when semver is inclusive', async function () {
        const  { Package, Version } = fme.models;
        const env = 'dev';
        const inc = 'major';

        let { dependentPayloadPublished } = clone(fixtures);
        // This case can be tested because the package has
        // a * dependency on this root package
        dependentPayloadPublished = increment(dependentPayloadPublished, 'payload', { env, inc });
        const dependentPackage = fme.extractLatest(dependentPayloadPublished);

        await Promise.all([
          Package.create(dependentPackage),
          Version.create({
            versionId: `${dependentPackage.name}@${dependentPackage.version}`,
            version: dependentPackage.version,
            name: dependentPackage.name,
            value: JSON.stringify(dependentPayloadPublished)
          })
        ]);

        const [buildInfo] = await Promise.all([
          waitCarpenter('publish'),
          change(env, dependentPayloadPublished)
        ]);
        const childPayload = buildInfo.body;

        const latest = fme.extractLatest(childPayload);
        assume(latest.version).equals(`2.0.1-0`);
        delete latest._id;

        await Promise.all([
          Package.create(latest),
          Version.create({
            versionId: `${latest.name}@${latest.version}`,
            version: latest.version,
            name: latest.name,
            value: JSON.stringify(childPayload)
          })
        ]);

        await change(env, childPayload);

        const release = await fme.release.get({ pkg: dependentPackage.name });
        assume(release.pkg).equals(dependentPackage.name);
        assume(release.version).equals(dependentPackage.version);
        assume(release.dependents).contains(latest.name);
        assume(release.dependents[latest.name]).equals(latest.version);
      });

      it('should publish new version of dependent package and update the release-line accordingly', async function () {
        // relies on previous test currently
        const pkg = 'email';
        const version = '3.0.0';
        const env = 'dev';
        const inc = 'minor';

        let { parent, payload } = clone(fixtures);
        parent = increment(parent, 'package', { env, inc });
        payload = increment(payload, 'payload', { env, inc });
        payload.__published = true;

        await change('dev', payload);

        const release = await fme.release.get({ pkg, version });
        assume(release.dependents).contains(parent.name);
        assume(release.dependents[parent.name]).equals(parent.version);
      });
    });

    describe('#destroy', function () {
      it('can be called multiple times without side affects', function () {
        assume(fme.destroy()).is.true();
        assume(fme.destroy()).is.false();
        assume(fme.destroy()).is.false();
        assume(fme.destroy()).is.false();
      });

      it('removes the log reference', function () {
        assume(fme.log).equals(app.log);

        fme.destroy();

        assume(fme.log).equals(null);
      });
    });
  });

  function increment(data, type, { inc = 'patch', env = 'test', dependencies = [] }) {
    const ret = clone(data);
    switch (type) {
      case 'package': {
        ret.version = semver.inc(ret.version, inc);
        for (const dep of dependencies) {
          ret.dependencies[dep] = '^' + semver.inc(semver.coerce(ret.dependencies[dep]), inc);
        }
        break;
      }
      case 'version': {
        const version = semver.inc(ret.version, inc);
        ret.versionId = `${ret.name}@${version}`;
        ret.version = version;
        break;
      }
      case 'payload': {
        const previousVer = ret['dist-tags'].latest;
        const latest = ret.versions[previousVer];
        latest.version = semver.inc(latest.version, inc);
        for (const dep of dependencies) {
          latest.dependencies[dep] = '^' + semver.inc(semver.coerce(latest.dependencies[dep]), inc);
        }
        ret.versions[latest.version] = latest;
        ret['dist-tags'].latest = latest.version;
        delete ret.versions[previousVer];
        if (env !== 'dev') delete ret.__published;
        break;
      }
      default: {
        throw new Error(`Incorrect type ${type}`);
      }
    }
    return ret;
  }
});


