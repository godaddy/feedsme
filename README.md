# feedsme

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

## Tests

```sh
npm test
```

## License
MIT

[carpenterd]: https://github.com/godaddy/carpenterd
