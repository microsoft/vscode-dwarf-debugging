# Copyright 2023 The Chromium Authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.

set(CXX_DEBUGGING_BUILD_REVISION 0 CACHE STRING "Project build revision")
set(CXX_DEBUGGING_BUILD_PATCH 0 CACHE STRING "Project build patch")

cmake_minimum_required(VERSION 3.16)
cmake_policy(SET CMP0048 NEW)
project(DevToolsCXXDebuggingExtension VERSION 0.2.${CXX_DEBUGGING_BUILD_REVISION}.${CXX_DEBUGGING_BUILD_PATCH} LANGUAGES CXX)

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 17)
set(REPO_SOURCE_DIR ${PROJECT_SOURCE_DIR}/../..)
set(THIRD_PARTY_DIR ${PROJECT_SOURCE_DIR}/third_party)
set(DEVTOOLS_SOURCE_DIR ${REPO_SOURCE_DIR})
set(CXX_DEBUGGING_GEN_DIR ${PROJECT_BINARY_DIR}/gen)
set(CXX_DEBUGGING_BINARY_DIR ${PROJECT_BINARY_DIR}/bin)
set(CXX_DEBUGGING_SOURCE_DIR ${PROJECT_SOURCE_DIR})

option(CXX_DEBUGGING_USE_SANITIZERS "Enable sanitizers" OFF)

option(CXX_DEBUGGING_ENABLE_DWARF5 "Enable -gdwarf-5 for emitting DWARF5" OFF)
if(CXX_DEBUGGING_ENABLE_DWARF5)
  add_compile_options(-gdwarf-5)
  add_link_options(-gdwarf-5)
endif()

option(CXX_DEBUGGING_ENABLE_PUBNAMES "Enable -gpubnames for emitting a DWARF index" OFF)
if(CXX_DEBUGGING_ENABLE_PUBNAMES)
  add_compile_options(-gpubnames)
  add_link_options(-gpubnames)
endif()

# Build LLVM dependencies.
set(LLVM_TARGETS_TO_BUILD "WebAssembly" CACHE STRING "")
set(LLVM_ENABLE_PROJECTS "clang;lldb" CACHE STRING "")
set(LLDB_INCLUDE_TESTS "OFF" CACHE STRING "")
set(CLANG_INCLUDE_TESTS "OFF" CACHE STRING "")

if (CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  set(CXX_DEBUGGING_BUILD_WASM TRUE)
else()
  set(CXX_DEBUGGING_BUILD_WASM FALSE)
endif()

if (CXX_DEBUGGING_BUILD_WASM)
  set(LLVM_ENABLE_RTTI "ON" CACHE STRING "")
  set(LLVM_ENABLE_THREADS "OFF" CACHE STRING "")
else()
  set(LLVM_ON_WIN32 0)
  set(LLVM_ON_UNIX 1)
endif()


if (CXX_DEBUGGING_BUILD_WASM)
  link_libraries(-sWASM_BIGINT)
  if (NOT CMAKE_BUILD_TYPE STREQUAL "Release")
    link_libraries(
      -sREVERSE_DEPS=all
      )
  endif()
endif()

if (CXX_DEBUGGING_USE_SANITIZERS)
  set(LLVM_USE_SANITIZER "Address;Undefined" CACHE STRING "")
else()
  set(LLVM_USE_SANITIZER "")
endif()

# llvm/cmake/config-ix.cmake imports 'Platform/${CMAKE_HOST_SYSTEM_NAME}' which used to work on
# earlier versions of CMake however newer versions does not support importing the 'Platform/${CMAKE_HOST_SYSTEM_NAME}'
# files directly. 
# We work around this by including a copy of the _cmake_record_install_prefix function 
# from 'CMakeSystemSpecificInformation.cmake' here.
function(_cmake_record_install_prefix )
  set(_CMAKE_SYSTEM_PREFIX_PATH_INSTALL_PREFIX_VALUE "${CMAKE_INSTALL_PREFIX}" PARENT_SCOPE)
  set(_CMAKE_SYSTEM_PREFIX_PATH_STAGING_PREFIX_VALUE "${CMAKE_STAGING_PREFIX}" PARENT_SCOPE)
  set(icount 0)
  set(scount 0)
  foreach(value IN LISTS CMAKE_SYSTEM_PREFIX_PATH)
    if(value STREQUAL CMAKE_INSTALL_PREFIX)
      math(EXPR icount "${icount}+1")
    endif()
    if(value STREQUAL CMAKE_STAGING_PREFIX)
      math(EXPR scount "${scount}+1")
    endif()
  endforeach()
  set(_CMAKE_SYSTEM_PREFIX_PATH_INSTALL_PREFIX_COUNT "${icount}" PARENT_SCOPE)
  set(_CMAKE_SYSTEM_PREFIX_PATH_STAGING_PREFIX_COUNT "${scount}" PARENT_SCOPE)
endfunction()

add_subdirectory(${THIRD_PARTY_DIR}/llvm/src/llvm ${CMAKE_CURRENT_BINARY_DIR}/third_party/llvm/src/llvm)
set_property(DIRECTORY ${THIRD_PARTY_DIR}/llvm/src/llvm PROPERTY EXCLUDE_FROM_ALL TRUE)


if (CXX_DEBUGGING_BUILD_WASM)
  if (CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_options(clangCodeGen PRIVATE -O2)
    target_compile_options(obj.clangCodeGen PRIVATE -O2)
  endif()
endif()

# Required to enable llvm option parsing
include(${THIRD_PARTY_DIR}/llvm/src/llvm/cmake/modules/DetermineGCCCompatible.cmake)

set(LLVM_RUNTIME_OUTPUT_INTDIR ${LLVM_BINARY_DIR}/${CMAKE_CFG_INTDIR}/bin)
set(LLVM_LIBRARY_OUTPUT_INTDIR ${LLVM_BINARY_DIR}/${CMAKE_CFG_INTDIR}/lib${LLVM_LIBDIR_SUFFIX})
set(LLVM_TOOLS_BINARY_DIR ${LLVM_RUNTIME_OUTPUT_INTDIR})

set(CMAKE_BUILD_WITH_INSTALL_RPATH FALSE)
set(CMAKE_SKIP_BUILD_RPATH FALSE)

# Turn on -gsplit-dwarf if requested in debug builds.
option(CXX_DEBUGGING_USE_SPLIT_DWARF "Enable -gsplit-dwarf for the extension" OFF)
if(CXX_DEBUGGING_USE_SPLIT_DWARF)
  if(NOT LLVM_USE_SPLIT_DWARF)
    message(WARNING "CXX_DEBUGGING_USE_SPLIT_DWARF turned ON, but LLVM_USE_SPLIT_DWARF turned off, might not be what you want?")
  endif()
  string(TOUPPER "${CMAKE_BUILD_TYPE}" uppercase_CMAKE_BUILD_TYPE)
  if((uppercase_CMAKE_BUILD_TYPE STREQUAL "DEBUG") OR
     (uppercase_CMAKE_BUILD_TYPE STREQUAL "RELWITHDEBINFO"))
    add_compile_options(-gsplit-dwarf)
  endif()
endif()

if (CXX_DEBUGGING_BUILD_WASM)
  add_subdirectory(lib)
  add_subdirectory(src)
  add_subdirectory(tests)
endif()
