#!/usr/bin/env bash
# Build vendor/swmm-wasm/swmm5.js: EPA SWMM 5.2.4 (public domain) compiled to WebAssembly, embedded in one JS file.
# Needs git and Emscripten (https://emscripten.org). Results were checked identical to the native engine (tests/node/test_couple2way.js, C0).
set -euo pipefail
WORK=${WORK:-/tmp/swmm-wasm}; mkdir -p "$WORK"; cd "$WORK"
[ -d emsdk ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git
(cd emsdk && ./emsdk install 3.1.64 && ./emsdk activate 3.1.64)
source emsdk/emsdk_env.sh
[ -d swmm ] || git clone --depth 1 --branch v5.2.4 https://github.com/USEPA/Stormwater-Management-Model.git swmm
cd swmm/src/solver
emcc -O2 -I include *.c -o "$OLDPWD/swmm5.js" -s MODULARIZE=1 -s EXPORT_NAME=createSWMM -s SINGLE_FILE=1 -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web,worker,node -s FORCE_FILESYSTEM=1 -Wno-everything \
  -s EXPORTED_FUNCTIONS='["_swmm_open","_swmm_start","_swmm_step","_swmm_stride","_swmm_end","_swmm_report","_swmm_close","_swmm_run","_swmm_getMassBalErr","_swmm_getVersion","_swmm_getError","_swmm_getWarnings","_swmm_getCount","_swmm_getName","_swmm_getIndex","_swmm_getValue","_swmm_setValue","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["FS","ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8"]'
echo "built $WORK/swmm5.js; copy it to vendor/swmm-wasm/"
