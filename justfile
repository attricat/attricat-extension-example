# Development and release tasks for attricat-extension-example.
#
# Attricat installs a zstd-compressed tar archive whose root contains the strict
# manifest and every artifact path declared by that manifest.

extension_id := "attricat-extension-example"
version := `node -p "require('./manifest.json').version"`
dist_dir := "dist"
stage_dir := "dist/package"
archive := dist_dir / extension_id + "-" + version + ".tar.zst"

default: check

fmt:
  cargo fmt --check

test:
  cargo test --workspace

check: fmt test check-documents

# Every client contribution is bundled into one self-contained ES module per
# manifest artifact (scripts/build-client.mjs). Catalog imports each into its
# own sandboxed, opaque-origin iframe and calls mount(root, catalog).
build-client:
  pnpm run build

# Build a component that imports only the unified catalog:host@1.6.0 ABI.
# wasm32-wasip2 would import ambient WASI interfaces, which Attricat never links.
build-server:
  #!/usr/bin/env bash
  set -euo pipefail
  command -v wasm-tools >/dev/null || { echo "Install wasm-tools: cargo install wasm-tools --locked" >&2; exit 1; }
  rustup target add wasm32-unknown-unknown
  cargo build --release --target wasm32-unknown-unknown -p attricat-extension-example-server
  mkdir -p {{dist_dir}}
  wasm-tools component new target/wasm32-unknown-unknown/release/attricat_extension_example_server.wasm -o {{dist_dir}}/server.wasm
  if wasm-tools component wit {{dist_dir}}/server.wasm | grep -E '^\s*import ' | grep -v 'catalog:host/.*@1\.6\.0'; then
    echo "server.wasm imports something other than catalog:host@1.6.0" >&2; exit 1
  fi

# Every artifact path declared by the manifest must exist and be non-empty.
verify-artifacts:
  node -e "const m=require('./manifest.json'),fs=require('fs');for(const a of m.artifacts){if(!fs.existsSync(a.path)||!fs.statSync(a.path).size){console.error('Missing '+a.path);process.exit(1)}}"

build: check build-client build-server verify-artifacts

# Produce the archive accepted by Catalog's installer: the manifest at the root
# plus exactly the files it declares (and the README and icon).
pack: build && pack-documents
  #!/usr/bin/env bash
  set -euo pipefail
  rm -rf {{stage_dir}}
  mkdir -p {{stage_dir}}
  cp manifest.json README.md {{stage_dir}}/
  cp -R assets {{stage_dir}}/
  files=$(node -p "require('./manifest.json').artifacts.map(a => a.path).join(' ')")
  for file in $files; do mkdir -p "{{stage_dir}}/$(dirname "$file")"; cp "$file" "{{stage_dir}}/$file"; done
  rm -f {{archive}}
  (cd {{stage_dir}} && tar -cf - manifest.json README.md assets $files) | zstd -q -o {{archive}}
  echo "Created {{archive}}"

# Browser + API verification against a running dev server (see e2e/verify.mjs).
# Requires CATALOG_WEB_URL and CATALOG_SESSION_FILE.
e2e:
  node e2e/verify.mjs

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
