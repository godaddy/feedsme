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

//
// These fixtures indicate a first of events that would come in
//
fixtures.first = {};
fixtures.first.rootVersion = {
  versionId: 'what@2.0.0',
  value: '{}',
  name: 'what',
  version: '2.0.0'
};

fixtures.first.rootPackage = {
  name: 'what',
  distTags: { latest: '2.0.0' },
  version: '2.0.0',
  main: 'index.js',
  dependencies: {
    moment: '0.0.x',
    slay: '*'
  },
  config: {
    locale: 'en'
  }
};

fixtures.first.rootHead = {
  name: 'what',
  version: '2.0.0',
  env: 'dev',
  locale: 'en-US'
};

fixtures.first.root = {
  'name': fixtures.first.rootPackage.name,
  'dist-tags': {
    latest: fixtures.first.rootPackage.version
  },
  'versions': {
    [fixtures.first.rootPackage.version]: fixtures.first.rootPackage
  },
  '_attachments': '',
  '__published': true
};

fixtures.first.childPackage = {
  name: 'huh',
  distTags: { latest: '2.0.0' },
  version: '2.0.0',
  main: 'index.js',
  dependencies: {
    moment: '0.0.x',
    what: '^2.0.0'
  },
  config: {
    locale: 'en'
  }
};

fixtures.first.childHead = {
  name: 'huh',
  version: '2.0.0',
  env: 'dev',
  locale: 'en-US'
};

fixtures.first.child = {
  'name': fixtures.first.childPackage.name,
  'dist-tags': {
    latest: fixtures.first.childPackage.version
  },
  'versions': {
    [fixtures.first.childPackage.version]: fixtures.first.childPackage
  },
  '_attachments': '',
  '__published': true
};

fixtures.first.childVersion = {
  versionId: 'huh@2.0.0',
  value: JSON.stringify(fixtures.first.child),
  name: 'huh',
  version: '2.0.0'
};

module.exports = fixtures;
