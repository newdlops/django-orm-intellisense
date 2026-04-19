# Rust crates

Native performance-critical components for the Django ORM Intellisense
VSCode extension.

## Layout

- `core/` — pure Rust library. Caching, AST indexing, discovery, semantic
  graph, feature extraction. Unit-testable without Node.
- `node/` — napi-rs bindings exposing `core` functions to the TS language
  server. Built as a `cdylib`, renamed to `index.node`, and loaded via
  `src/client/native/loader.ts`.

## Local build

```bash
# Build and place at native/<triple>/index.node
npm run build:native

# Smoke test
node -e "console.log(require('./native/darwin-arm64/index.node').hello('x'))"
node out/client/native/loader.test.js
```

## CI prebuild

GitHub Actions workflow `.github/workflows/rust-prebuild.yml` produces
`darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `win32-x64-msvc` artifacts.
Tag pushes attach them to the GitHub release; they are downloaded by the
`.vsix` packaging step (`package-vsix.sh`, updated in P1).
