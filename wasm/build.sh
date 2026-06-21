#!/bin/sh -e
# shellcheck disable=SC1091
set -e
cd "$(dirname "$0")"

SCRIPT_DIR="$(pwd)" 

if [ -z "$EMSDK" ]; then
    echo "ERROR: Environment variable EMSDK must be set" 
    exit 1
fi

cd "$EMSDK"
. ./emsdk_env.sh

cd "$SCRIPT_DIR"

. ./fetch-git.sh
. ./build-stage-1.sh
. ./build-stage-2.sh
. ./build-e2e.sh

fetch symbols-backend/third_party/llvm/src \
    https://github.com/llvm/llvm-project.git \
    3c51ea3619e488db19cd26840ed46d58cfc7062f

fetch "symbols-backend/third_party/lldb-eval/src" \
    https://github.com/google/lldb-eval.git \
    e87123a7e639bf1d86f24c37079570fb7fa00b72

build_stage_1 symbols-backend \
    symbols-backend.build/stage-1

build_stage_2 symbols-backend \
    symbols-backend.build/stage-2 \
    symbols-backend.build/stage-1

build_e2e e2e e2e.build

cp symbols-backend.build/stage-2/compile_commands.json symbols-backend
