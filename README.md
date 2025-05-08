# @vscode/dwarf-debugging

This repository publishes an npm module which is used by [js-debug](https://github.com/microsoft/vscode-js-debug) to better debug WebAssembly code when [DWARF](https://dwarfstd.org/) debugging information is present. You can use this in two ways:

- For VS Code users, you will be prompted to install the appropriate extension that contains this module when you first step into a WebAssembly file.
- For users of the js-debug standalone DAP server, you can install the `@vscode/dwarf-debugging` alongside js-debug or somewhere in your [NODE_PATH](https://nodejs.org/api/modules.html#loading-from-the-global-folders).

This project works by compiling the WebAssembly backend for the Chrome [C/C++ Debugging Extension](https://github.com/ChromeDevTools/devtools-frontend/tree/main/extensions/cxx_debugging) in a way that is usable by Node.js programs. Fortunately, the extension is architected such that most work is done inside a WebWorker, and porting the TypeScript code to instead run in a Node worker_thread is not terribly difficult. Appropriate TypeScript types are exposed, and this module is then shimmed into js-debug which 'pretends' to be Devtools.

In addition for the variable view and the basic `C/C++` expression evaluation support via [lldb-eval](https://github.com/google/lldb-eval) included in the original Chrome C/C++ Debugging Extension the following features has been added:

  - Basic support for `Rust` types, most specifically sum types which couldn't be viewed in the original extension but also better support for core / standard library types like:
    - `&[T]`
    - `alloc::vec::Vec<T>`
    - `alloc::collections::vec_deque::VecDeque<T>`
    - `&str`
    - `alloc::string::String`
    - `alloc::rc::Rc<T>`
    - `alloc::rc::Weak<T>`
    - `std::collections::hash::map::HashMap<K, V>`
    - `std::collections::hash::map::HashSet<T>`
    
## Contributing

### Building (using Docker or Podman)

1. Clone this repo, and have Docker or Podman installed.
2. Run `npm i`
3. Run `npm run build`. This will take a while (~1hr depending on how fast your computer is.) Note that for developing you can run individual build steps in their appropriate scripts.
4. You then have a built module. Run `npm run test` to run the test suite.

### Building (using local install of build tools and a posix compatible shell)

1. Clone this repo, and have the following dependencies installed on your machine:  
    - `cmake`, `python3` and `ninja-build`
    - [Emscripten SDK](https://github.com/emscripten-core/emsdk.git) installed, environment variable `EMSDK` pointing to the root folder of the SDK and version `3.1.14` activated.
    - `nodejs v20+`
    - `rust v1.83+` with target `wasm32-wasip1` added (for compiling parts of the test suite)
2. Run `npm i`
3. Run `wasm/build.sh && npm run build-meta`. This will take a while but probably shorter than if building with Docker or Podman.
4. You then have a built module. Run `npm run test` to run the test suite.


### General

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
