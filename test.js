/* eslint max-nested-callbacks: 0, no-invalid-this: 0, max-statements: 0, no-process-env: 0 */

describe('feedsme', function () {
  'use strict';

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

  var carpenter = new EventEmitter()
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
    app.close(next);
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
        'name': 'email',
        'version': '2.0',
        'main': 'index.js',
        'dependencies': {
          'moment': '0.0.x',
          'slay': '*'
        },
        'config': {
          'locale': 'en'
        }
      },
      parent: {
        'name': 'cows',
        'version': '2.0',
        'main': 'index.js',
        'dependencies': {
          'moment': '0.0.x',
          'email': '*'
        },
        'config': {
          'locale': 'en'
        }
      },
      version: {
        'versionId': 'cows@2.0',
        'value': '{}',
        'name': 'cows',
        'version': '2.0'
      }
    };

    //
    // Mimic payload from npm.
    //
    fixtures.payload = {
      name: fixtures.parent.name,
      'dist-tags': {
        latest: fixtures.parent.version
      },
      versions: {
        [fixtures.parent.version]: fixtures.parent
      },
      _attachments: ''
    };

    this.timeout(60000);

    before(function (next) {
      async.parallel([
        app.models.Package.create.bind(app.models.Package, fixtures.dependent),
        app.models.Package.create.bind(app.models.Package, fixtures.parent),
        app.models.Version.create.bind(app.models.Version, fixtures.version)
      ], next);
    });

    after(function (next) {
      async.parallel([
        app.models.Package.remove.bind(app.models.Package, fixtures.dependent),
        app.models.Package.remove.bind(app.models.Package, fixtures.parent),
        app.models.Version.remove.bind(app.models.Version, fixtures.version)
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

      //
      // Fake npm responses.
      //
      nock(app.config.get('npm'))
      .get('/cows/-/cows-2.0.tgz')
      .reply(200, function (uri, body) {
        carpenter.emit('npm', uri, body, this);

        return require('fs').readFileSync(__filename); // eslint-disable-line no-sync
      });
    });

    afterEach(function () {
      fme.destroy();
    });

    describe('#resolve', function () {
      it('only adds private dependencies to dependend', function (next) {
        fme.resolve('dev', fixtures.parent, function (error) {
          if (error) return next(error);

          app.models.Dependent.findOne({
            conditions: {
              name: fixtures.dependent.name
            }
          }, function (err, data) {
            if (err) return next();

            var dependent = data.dependents;

            assume(dependent).is.length(1);
            assume(dependent).is.a('array');
            assume(dependent).includes(fixtures.parent.name);

            next();
          });
        });
      });
    });

    describe('#trigger', function () {
      it('triggers the carpenter for each dependend module with pkgjson', function (next) {
        next = assume.wait(2, next);

        carpenter.once('build', function (uri, body) {
          body = JSON.parse(body);

          assume(body).is.a('object');
          assume(body.name).equals(fixtures.parent.name);
          assume(body.dependencies).contains(fixtures.dependent.name);
          assume(body._attachments).is.a('object');
          assume(body._attachments).contains('cows-2.0.tgz');
          assume(body.env).equals('prod');

          next();
        });

        fme.trigger('prod', fixtures.dependent, next);
      });
    });

    describe('#change', function () {
      it('will trigger and resolve the package payload', function (next) {
        var spyTrigger = sinon.spy(fme, 'trigger');
        var spyResolve = sinon.spy(fme, 'resolve');
        var spyDependent = sinon.spy(fme.app.models.Dependent, 'get');

        fme.change('dev', fixtures.payload, function (err, results) {
          assume(err).to.be.falsy();
          assume(results).to.be.an('array');
          assume(results).to.have.length(2);
          assume(spyTrigger.calledOnce).to.be.true();
          assume(spyResolve.calledOnce).to.be.true();
          assume(spyDependent.secondCall).to.not.equal(null);
          assume(spyDependent.secondCall).to.be.calledWith('email');

          spyTrigger.restore();
          spyResolve.restore();
          spyDependent.restore();

          next();
        });
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
        assume(fme.app).equals(app);

        fme.destroy();

        assume(fme.app).equals(null);
      });
    });
  });
});
