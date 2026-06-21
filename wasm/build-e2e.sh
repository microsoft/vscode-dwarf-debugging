#!/bin/sh
set -e

build_e2e() {
    SOURCE_DIR="$(pwd)/$1"
    E2E_BUILD="$(pwd)/$2"

    mkdir -p "$E2E_BUILD"

    ./generate-e2e-resources-build "$SOURCE_DIR"/*.yaml > "$E2E_BUILD/build.ninja"
    
    ninja -C "$E2E_BUILD"
}
