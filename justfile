# Development and release tasks for attricat-extension-example.
#
# Attricat installs a zstd-compressed tar archive whose root contains the strict
# manifest and every artifact path declared by that manifest.

extension_id := "attricat-extension-example"
version := "0.1.15"
dist_dir := "dist"
stage_dir := "dist/package"
archive := "dist/attricat-extension-example-0.1.15.tar.zst"

# Run all implementation checks that are available before the component runtime
# lands. This is the default target for contributors.
default: check

fmt:
  cargo fmt --check

test:
  cargo test --workspace

check: fmt test check-documents

# Build the host-independent formula implementation. The server component will
# link this crate once Attricat's next-version WIT bindings are available.
build-core:
  cargo build --release -p attricat-extension-example-formula-core

# Validate that the two release artifacts produced by the server/client build
# steps exist. Keeping this check separate prevents packaging a native Rust
# library or a placeholder WASM module as an Attricat server component.
verify-artifacts:
  #!/usr/bin/env bash
  set -euo pipefail
  test -s {{dist_dir}}/server.wasm || {
    echo "Missing {{dist_dir}}/server.wasm (must be a catalog:host WASM component)." >&2
    exit 1
  }
  for artifact in app.js inspector.js decoration.js action.js table-cell.js row-action.js; do
    test -s "{{dist_dir}}/$artifact" || {
      echo "Missing {{dist_dir}}/$artifact (must export mount(root, catalog))." >&2
      exit 1
    }
  done

# Each contribution is a self-contained ES module. The route application is
# bundled with Preact so it has no external imports in Catalog's opaque iframe.
# The host calls mount(root, catalog), so artifacts cannot register host-DOM
# custom elements or infer which contribution mounted them.
build-client:
  pnpm run build
  cp client/inspector.js {{dist_dir}}/inspector.js
  cp client/decoration.js {{dist_dir}}/decoration.js
  cp client/action.js {{dist_dir}}/action.js
  cp client/table-cell.js {{dist_dir}}/table-cell.js
  cp client/row-action.js {{dist_dir}}/row-action.js

# Build a component with only the catalog host import. wasm32-wasip2 would
# import ambient WASI interfaces, which Attricat intentionally does not link.
build-server:
  #!/usr/bin/env bash
  set -euo pipefail
  command -v wasm-tools >/dev/null || { echo "Install wasm-tools: cargo install wasm-tools --locked" >&2; exit 1; }
  rustup target add wasm32-unknown-unknown
  if [[ "$(uname)" == "Darwin" ]]; then
    sysroot="$(rustc --print sysroot)"
    export DYLD_FALLBACK_LIBRARY_PATH="$sysroot/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
  fi
  cargo build --release --target wasm32-unknown-unknown -p attricat-extension-example-server
  mkdir -p {{dist_dir}}
  wasm-tools component new target/wasm32-unknown-unknown/release/attricat_extension_example_server.wasm -o {{dist_dir}}/server.wasm

# Build, validate, and package the extension.
build: check build-core build-client build-server verify-artifacts

# Produce the archive accepted by Attricat's extension installer. The staging
# directory makes the archive layout explicit and avoids packaging source,
# tests, or build intermediates.
pack: build && pack-documents
  #!/usr/bin/env bash
  set -euo pipefail
  rm -rf {{stage_dir}}
  mkdir -p {{stage_dir}}/{{dist_dir}}
  cp manifest.json README.md {{stage_dir}}/
  cp -R assets {{stage_dir}}/
  cp {{dist_dir}}/server.wasm {{dist_dir}}/app.js {{dist_dir}}/inspector.js {{dist_dir}}/decoration.js {{dist_dir}}/action.js {{dist_dir}}/table-cell.js {{dist_dir}}/row-action.js {{stage_dir}}/{{dist_dir}}/
  rm -f {{archive}}
  (cd {{stage_dir}} && tar -cf - manifest.json README.md assets {{dist_dir}}) | zstd -q -o {{archive}}
  echo "Created {{archive}}"

clean:
  rm -rf {{dist_dir}} target

# The reference document extension uses the interactive catalog:host@1.5.0
# operation world (selection reads, annotations, streamed artifacts).
documents_archive := "dist/reference-documents.tar.zst"
documents_stage := "dist/documents-package"

check-documents:
  cargo test -p attricat-reference-documents
  cargo check --target wasm32-unknown-unknown -p attricat-reference-documents

pack-documents:
  #!/usr/bin/env bash
  set -euo pipefail
  command -v wasm-tools >/dev/null || { echo "Install wasm-tools: cargo install wasm-tools --locked" >&2; exit 1; }
  cargo build --release --target wasm32-unknown-unknown -p attricat-reference-documents
  rm -rf {{documents_stage}}
  mkdir -p {{documents_stage}}
  wasm-tools component new target/wasm32-unknown-unknown/release/attricat_reference_documents.wasm -o {{documents_stage}}/server.wasm
  cp documents/manifest.json documents/icon.svg documents/client/action.js documents/client/dialog.js {{documents_stage}}/
  rm -f {{documents_archive}}
  (cd {{documents_stage}} && tar -cf - manifest.json icon.svg server.wasm action.js dialog.js) | zstd -q -o {{documents_archive}}
  echo "Created {{documents_archive}}"
