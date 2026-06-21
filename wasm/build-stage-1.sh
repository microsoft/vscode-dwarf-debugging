#!/bin/sh
set -e

build_stage_1() {
    SOURCE_DIR="$(pwd)/$1"
    STAGE1_BUILD="$(pwd)/$2"

    mkdir -p "$STAGE1_BUILD"

    cmake \
        -S "$SOURCE_DIR" \
        -B "$STAGE1_BUILD" \
        -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
        -GNinja \
        -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
        -DLLVM_ENABLE_ZLIB=OFF \
        -DLLVM_ENABLE_TERMINFO=OFF \
        -DLLDB_ENABLE_CURSES=OFF \
        -DLLDB_ENABLE_LIBXML2=OFF \
        -DLLDB_ENABLE_LZMA=OFF \
        -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
        -DCMAKE_C_COMPILER="${HOST_C_COMPILER:-"clang"}" \
        -DCMAKE_CXX_COMPILER="${HOST_CXX_COMPILER:-"clang++"}"
        
    ninja -C "$STAGE1_BUILD" lldb-tblgen clang-tblgen llvm-tblgen llvm-dwp llvm-mc
}
