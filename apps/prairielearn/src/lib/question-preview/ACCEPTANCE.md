# Standalone Preview Server acceptance evidence

This matrix names the automated evidence for the complete `experimental-1` Standalone Preview
Server contract. Test names are stable behavior descriptions; implementation internals are not
part of the asserted contract.

| Area                | Automated evidence                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process lifecycle   | `engine.test.ts`: “shares one engine generation across independently closeable course renderers”, “drains one stale generation and coordinates one replacement for concurrent callers”; `server.test.ts`: “shares one process engine while closing course renderers independently”; `question-preview-entrypoint.test.ts`; compiled-entrypoint and graceful-signal coverage in `standalonePreview.spec.ts` |
| Course registration | `course-source.test.ts`: relative/canonical paths, `infoCourse.json`, `questions/`, metadata/UTC, source refresh, traversal and symlink containment; `server.test.ts`: “starts with zero courses and registers valid startup courses before readiness”                                                                                                                                                     |
| Session semantics   | `local-preview-session.test.ts`: “removes a closing session before draining its leases and owned state” and “keeps duplicate course sessions distinct until their owner closes them”; `server.test.ts`: create/list/delete, duplicate startup sessions, atomic startup and drain-before-204; `standalonePreview.spec.ts`: startup and runtime sessions                                                     |
| Security            | `server.test.ts`: bearer boundary, stable control-plane errors, generic browser errors, malicious paths and removed routes; `course-source.test.ts` and `qid.test.ts`: trusted path rules; `standalonePreview.spec.ts`: unknown/deleted browser-safe documents and cross-session generated-file isolation                                                                                                  |
| Rendering           | `document.test.ts`: shared document policy and both Source Question Type adapters; `server.test.ts`: deterministic default seed, both render modes, current-file refresh, and the complete GET deadline with late-completion recovery; `standalonePreview.spec.ts`: Chromium hydration for all six Source Question Types, deterministic seeds and source refresh                                           |
| Grading             | `document.test.ts`: Freeform and legacy submissions, authoritative legacy seed regeneration, Internal/External/Manual boundaries and stateless grading; `server.test.ts`: no retained submission state and the complete POST answer-check deadline with late-completion recovery; `standalonePreview.spec.ts`: both native browser submission contracts                                                    |
| Assets              | `assets.test.ts`, `generated-files.test.ts`, and `submission-files.test.ts`; `server.test.ts`: global PrairieLearn assets, scoped course/question/generated/submission resources and malicious paths; `standalonePreview.spec.ts`: emitted URLs, file contents, global assets and session isolation                                                                                                        |
| Workspaces          | `workspace-launcher.test.ts`: global limit/LRU, activity, namespacing, reboot/reset and cleanup; `workspace-proxy.test.ts`: HTTP/WebSocket and session socket close; `server.test.ts`: scoped routes, metadata, default-off behavior, session cleanup and opt-in real-Docker lifecycle                                                                                                                     |
| Discovery           | `server.test.ts`: “protects only the control plane and advertises exact default capabilities” and “advertises exact full-rendering and Preview Workspace capabilities”; compiled zero-course health/discovery in `standalonePreview.spec.ts`                                                                                                                                                               |
| Compatibility       | `server.test.ts`: removed-route and removed-flag assertions; `question-preview-entrypoint.test.ts`: package scripts and entrypoint; `standalonePreview.spec.ts`: compiled `dist/preview-server.js` with zero and startup courses                                                                                                                                                                           |
| Module shape        | Public-interface tests in `engine.test.ts`, `course-source.test.ts`, `local-preview-session.test.ts`, `document.test.ts`, `workspace-launcher.test.ts`, and `workspace-proxy.test.ts`; no test reaches into engine generations, mutable workspace registries, or generated/submission stores through HTTP                                                                                                  |

Run the principal release gates from the PrairieLearn checkout:

```sh
pnpm run test
pnpm --filter @prairielearn/prairielearn test:e2e
pnpm --filter @prairielearn/prairielearn test:e2e:standalone-preview
make build
make test-prairielearn-docker-smoke-tests
```

Run the opt-in real Preview Workspace lifecycle where Docker is available:

```sh
PL_PREVIEW_WORKSPACE_DOCKER_TEST=1 \
  pnpm test apps/prairielearn/src/lib/question-preview/server.test.ts
```
