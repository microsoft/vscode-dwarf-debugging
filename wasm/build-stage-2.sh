#!/bin/sh
set -e

build_stage_2() {
    SOURCE_DIR="$(pwd)/$1"
    STAGE2_BUILD="$(pwd)/$2"
    STAGE1_TOOLS="$(pwd)/$3/third_party/llvm/src/llvm/bin"

    mkdir -p "$STAGE2_BUILD"

    cmake \
        -S "$SOURCE_DIR" \
        -B "$STAGE2_BUILD" \
        -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
        -GNinja \
        -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
        -DLLVM_ENABLE_ZLIB=OFF \
        -DLLVM_ENABLE_TERMINFO=OFF \
        -DLLDB_ENABLE_CURSES=OFF \
        -DLLDB_ENABLE_LIBXML2=OFF \
        -DLLDB_ENABLE_LZMA=OFF \
        -DCMAKE_CXX_FLAGS_RELWITHDEBINFO="-O1 -g -DNDEBUG" \
        -DCMAKE_C_FLAGS_RELWITHDEBINFO="-O1 -g -DNDEBUG" \
        -DCMAKE_EXE_LINKER_FLAGS_RELWITHDEBINFO="-O1 -g -DNDEBUG -gseparate-dwarf" \
        -DCMAKE_CXX_FLAGS_DEBUG="-O0 -g -DNDEBUG " \
        -DCMAKE_EXE_LINKER_FLAGS_DEBUG="-O0 -g -gseparate-dwarf " \
        -DHAVE_POSIX_REGEX=0 \
        -DCMAKE_BUILD_TYPE=RelWithDebInfo \
        -DCMAKE_TOOLCHAIN_FILE="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
        -DLLVM_DWP="$STAGE1_TOOLS/llvm-dwp" \
        -DLLVM_TABLEGEN="$STAGE1_TOOLS/llvm-tblgen" \
        -DCLANG_TABLEGEN="$STAGE1_TOOLS/clang-tblgen" \
        -DLLDB_TABLEGEN="$STAGE1_TOOLS/lldb-tblgen" \
        -DWASM_LD="$EMSDK/upstream/bin/wasm-ld" \
        -DCXX_DEBUGGING_USE_SPLIT_DWARF=OFF \
        -DLLVM_USE_SPLIT_DWARF=OFF \
        -DCXX_DEBUGGING_ENABLE_DWARF5=OFF \
        -DCXX_DEBUGGING_ENABLE_PUBNAMES=OFF \
        -DCXX_DEBUGGING_DWO_ONLY=OFF \
        -DCXX_DEBUGGING_USE_SANITIZERS=OFF

    ninja -C "$STAGE2_BUILD" -j10 all
}
