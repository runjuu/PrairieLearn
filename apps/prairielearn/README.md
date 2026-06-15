# PrairieLearn frontend and backend

More information about developing and contributing to PrairieLearn can be found on the docs in the [developer guide](https://docs.prairielearn.com/dev-guide/).

Key directories:

- [`elements`](./elements/): Contains the custom `pl-*` elements used in PrairieLearn ([element documentation](https://docs.prairielearn.com/elements/)). Information on creating custom elements can be found on the [element developer guide](https://docs.prairielearn.com/devElements/).
- [`src/pages`](./src/pages/): Contains the individual pages of the PrairieLearn application. The mapping of URLs to pages is defined in [`server.ts`](./src/server.ts).

## Local preview server

To preview question panels locally, start the preview server:

```sh
yarn workspace @prairielearn/prairielearn build
yarn workspace @prairielearn/prairielearn preview:server -- --course-dir /absolute/path/to/course
```

Open direct preview URLs such as `http://127.0.0.1:4310/questions/<qid>`, where `<qid>` is a
relative path under the course `questions/` directory. Edit local course files and refresh the
browser to render the current files.

To preview a specific variant, add a `variant` query parameter, for example
`http://127.0.0.1:4310/questions/<qid>?variant=2`. Use a seed that parses as a base-36 integer
from `0` through `2^32 - 1` (`4294967295`, or `1z141z3` in base 36). If `variant` is omitted, the
preview uses variant seed `1`.

Optional flags:

- `--host`: Bind address. Defaults to `127.0.0.1`.
- `--port`: Bind port. Defaults to `4310`.
- `--cache-type`: Cache backend for render results, one of `none`, `memory`, or `redis`. Defaults
  to `none`. To use `redis`, start Redis and configure `redisUrl`.
- `--dev-mode`: Enables development-mode asset handling, skips eager worker readiness checks, and
  disables some render caching. Defaults to `false`.
- `--question-timeout-ms`: Question-code worker timeout in milliseconds. Defaults to `5000`.
- `--workers-count`: Maximum number of question-code workers. Defaults to `1`.
- `--workers-execution-mode`: Worker execution mode, either `native` or `container`. Defaults to
  `container`.

With the default `container` mode, the local server runs question code inside a Docker container, so
Docker must be installed and running. The container isolates question code from your machine's
filesystem and processes, but does not currently restrict its outbound network access. Pass
`--workers-execution-mode native` to run question code directly on your machine instead, where
question `server.py` runs under your user account with its normal outbound network access.

This is distinct from production Quesal preview: the local server does not implement Quesal
authorization, Source Course Reference resolution, Temporary Preview Course materialization,
Sandboxed Preview Worker policy, or Preview Shell policy.
