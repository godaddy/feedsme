# feedsme

[![CircleCI](https://circleci.com/gh/godaddy/feedsme.svg?style=svg)](https://circleci.com/gh/godaddy/feedsme)
[![Build Status](https://travis-ci.org/godaddy/feedsme.svg?branch=master)](https://travis-ci.org/godaddy/feedsme)

Feedsme is a micro service that receive build completion notifications
from [carpenterd]. When these notifications are received we will try to find all
dependent modules on the package that was just build and send them in for
re-build in [carpenterd].

This ensures that all dependencies on your packages are always updated.

## Architecture overview

When carpenter completes a build it will trigger a `POST /change` on the Feedsme
microservice with the `package.json` contents of the package that was built. The
package.json is then processed in 2 ways:

1. Fetch all dependent packages of `package.name` and `POST /build` to the
   carpenter microservice to trigger a re-build of these packages as this
   dependency got updated.
2. Iterate over all dependencies, figure out which once's are private and add
   this `package.name` as dependent on that module.
3. ???
4. Profit

### Trigger re-build

Below is a scenario for what happens when a rebuild is triggered for the given
environment sequence of DEV -> TEST -> PROD.

So feedsme's core responsibility as a service is to receive change events from carpenter when a package's build has been triggered to see if that package needs to trigger MORE builds due to its dependents. The core of the logic we go through is found in [here][0]. Now in theory this is simple but the semantics of the auto incrementing is where it gets a bit complex.

How it currently exists, each time a build is triggered in DEV, the main package `foo` will trigger a dependent build for `foo-bar`. In this scenario the latest version of `foo-bar` is the latest BuildHead for `DEV` (or it may be the same as the latest published version), so our strategy is to auto-increment from this version and publish that new version to warehouse so it can exist in the registry backend, update the Package model as well as create a Version record. This will in turn trigger a build for this version of `foo-bar` once warehouse calls carpenter, runs a fresh npm install, build the set number of builds and all of `foo` will eventually complete for DEV.

Now when a build is triggered for TEST, when `foo-bar` is triggered, it will compare the latest BuildHead in test to the latest version published. We will see that the latest version published is greater than the BuildHead in TEST so we will just use that version in order to trigger our test build rather than auto-incrementing the version based on the BuildHead. In this case we hit carpenter directly with the correct payload and builds will happen as expected, pulling the already existing tarball for this version and then running the webpack builds. PROD also replicates this same scenario.

But where this breaks down is if there was a new publish to DEV and you now wanted to promote the older version currently in TEST to PROD. If you did this promotion, feedsme would use the latest published version of `foo-bar` to build for PROD because there is no sense of understanding the sequence of promotion or what version it should build. We either auto-increment for the DEV publish of main package case or we use the latest published version so we are reusing tarballs. This assumed that promotions from DEV, TEST -> PROD happened very quickly which is not always the case.

The above scenario describes how dependent builds work but this will change very
soon to better handle what would be expected.

## Tests

[Cassandra] should be running local. It can be installed through
[homebrew] for MacOS or run the docker container from [docker hub][hub].

```sh
npm test
```

## License
MIT

[0]: https://github.com/godaddy/feedsme/blob/master/lib/feedsme/index.js#L93
[carpenterd]: https://github.com/godaddy/carpenterd
[Cassandra]: https://cassandra.apache.org/
[homebrew]: http://brew.sh/
[hub]: https://hub.docker.com/_/cassandra/
