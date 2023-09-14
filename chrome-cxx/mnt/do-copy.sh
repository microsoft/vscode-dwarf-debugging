rm -rf /mnt/extension /mnt/extension-api.d.ts /mnt/types

# debug wasm is ~1GB, no need to copy it...
rm /devtools/devtools-frontend/out/DevTools_CXX_Debugging.stage2/src/*.debug.wasm

# todo: compressing with brotli saves ~37% from a normal zip, but it would require extraction at
# runtime and self-modifying modules/extensions is spooky, yo

# echo "Compressing wasm"
# apt install -y brotli
# brotli -Z /devtools/devtools-frontend/out/DevTools_CXX_Debugging.stage2/src/SymbolsBackend.wasm

echo "Copying base data"
cp -r /devtools/devtools-frontend/out/DevTools_CXX_Debugging.stage2/src /mnt/extension
cp /devtools/devtools-frontend/extension-api/ExtensionAPI.d.ts /mnt/extension-api.d.ts

echo "Building types"
npx -y --package=typescript -- tsc -p . --declaration --emitDeclarationOnly --outDir /tmp/types
find /tmp/types -type f -exec sed -i 's=../../../extension-api/ExtensionAPI.js=../extension-api.js=g' {} \;
mv /tmp/types/src/* /mnt/extension
