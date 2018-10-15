/* eslint max-nested-callbacks: 0, no-invalid-this: 0, max-statements: 0, no-process-env: 0 */
require('make-promises-safe');

describe('feedsme', function () {


  var EventEmitter = require('events').EventEmitter;
  var sinonAssume = require('assume-sinon');
  var Feedsme = require('./lib/feedsme');
  var request = require('request');
  var assume = require('assume');
  var async = require('async');
  var sinon = require('sinon');
  var path = require('path');
  var feedsme = require('./');
  var nock = require('nock');
  var url = require('url');

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

  before(function (next) {
    feedsme.start({
      log: {
        level: process.env.FEEDSME_LOG || 'critical'
      },
      ensure: true,
      config: {
        file: path.join(__dirname, 'config.example.json'),
        overrides: {
          http: 0
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
    });
  });

  describe('Feedsme', function () {
    var fme;
    var fixtures = {
      dependent: {
        name: 'email',
        version: '2.0.0',
        main: 'index.js',
        dependencies: {
          moment: '0.0.x',
          slay: '*'
        },
        config: {
          locale: 'en'
        }
      },
      parent: {
        name: 'cows',
        version: '2.0.0',
        distTags: {
          latest: '2.0.0'
        },
        main: 'index.js',
        dependencies: {
          moment: '0.0.x',
          email: '*'
        },
        config: {
          locale: 'en'
        }
      },
      head: {
        name: 'cows',
        version: '2.0.0',
        env: 'dev',
        locale: 'en-US'
      }
    };

    fixtures.version = {
      versionId: 'cows@2.0.0',
      value: JSON.stringify({
        'name': fixtures.parent.name,
        'dist-tags': {
          latest: fixtures.parent.version
        },
        'versions': {
          [fixtures.parent.version]: fixtures.parent
        }
      }),
      name: 'cows',
      version: '2.0.0'
    };

    fixtures.dependentPayloadPublished = {
      'name': fixtures.dependent.name,
      'dist-tags': {
        latest: fixtures.dependent.version
      },
      'versions': {
        [fixtures.dependent.version]: fixtures.dependent
      },
      '_attachments': '',
      '__published': true
    };

    //
    // Mimic payload from npm.
    //
    fixtures.payload = {
      'name': fixtures.parent.name,
      'dist-tags': {
        latest: fixtures.parent.version
      },
      'versions': {
        [fixtures.parent.version]: fixtures.parent
      },
      '_attachments': ''
    };

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

      //
      // Fake carpenter responses.
      //
      nock(app.config.get('carpenter'))
        .post('/build')
        .reply(200, function reply(uri, body) {
          carpenter.emit('build', uri, body, this);

          return { ok: true };
        });

      nock(app.config.get('warehouse'))
        .put('/cows')
        .reply(200, function (uri, body) {
          carpenter.emit('publish', uri, body, this);

          return { ok: true };
        });

      //
      // Fake npm responses.
      //
      nock(app.config.get('npm'))
        .get('/cows/-/cows-2.0.0.tgz')
        .reply(200, function (uri, body) {
          carpenter.emit('npm', uri, body, this);

          return require('fs').readFileSync(__filename); // eslint-disable-line no-sync
        });
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
          body = JSON.parse(body);
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
    });

    describe('#change', function () {
      it('will trigger and resolve the package payload', async function () {
        const spyTrigger = sinon.spy(fme, 'trigger');
        const spyResolve = sinon.spy(fme, 'resolve');
        const spyDependent = sinon.spy(fme.models.Dependent, 'get');

        await fme.change('prod', fixtures.payload);
        assume(spyTrigger.calledOnce).to.be.true();
        assume(spyResolve.calledOnce).to.be.true();
        // since resolve is called first rather than in parallel
        assume(spyDependent.firstCall).to.not.equal(null);
        assume(spyDependent.firstCall).to.be.calledWith('email');

        spyTrigger.restore();
        spyResolve.restore();
        spyDependent.restore();

      });
    });

    describe('#destroy', function () {
      it('can be called multiple times without side affects', function () {
        assume(fme.destroy()).is.true();
        assume(fme.destroy()).is.false();
        assume(fme.destroy()).is.false();
        assume(fme.destroy()).is.false();
      });

      it('removes the app reference', function () {
        assume(fme.log).equals(app.log);

        fme.destroy();

        assume(fme.log).equals(null);
      });
    });
  });
});
