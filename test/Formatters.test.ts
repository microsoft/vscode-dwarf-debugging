// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/tests/Formatters_test.ts

import assert from 'assert';
import { describe, it } from 'node:test';

import { CustomFormatters, type TypeInfo } from '../src/CustomFormatters';
import * as Formatters from '../src/Formatters';
import TestValue from '../test-utils/TestValue';
import TestWasmInterface from '../test-utils/TestWasmInterface';

describe('Formatters', () => {
  it('formatChar', () => {
    const wasm = new TestWasmInterface();

    const chars = [0x0, 0x7, 0x8, 0x9, 0xA, 0xB, 0xC, 0xD, 0x19, 0x20, 0x7e, 0x7f, 0x21, 0x7d];
    const expectation = [
      '\\0',
      '\\a',
      '\\b',
      '\\t',
      '\\n',
      '\\v',
      '\\f',
      '\\r',
      '\\x19',
      ' ',
      '~',
      '\\x7f',
      '!',
      '}',
    ].map(c => `'${c}'`).join();

    assert.deepEqual(chars.map(c => Formatters.formatChar(wasm, TestValue.fromInt8(c))).join(), expectation);
    assert.deepEqual(chars.map(c => Formatters.formatChar(wasm, TestValue.fromUint8(c))).join(), expectation);
  });

  it('formatCStrings', () => {
    const wasm = new TestWasmInterface();

    // 0x0
    const ptr = TestValue.fromUint32(0, 'char *');
    assert.deepEqual(Formatters.formatCString(wasm, ptr), { '0x0': null });
    assert.deepEqual(Formatters.formatU16CString(wasm, ptr), { '0x0': null });
    assert.deepEqual(Formatters.formatCWString(wasm, ptr), { '0x0': null });
    // short string

    const shortString = 'abcdef';
    const shortStringQuoted = `"${shortString}"`;
    const shortStringChars = new TextEncoder().encode(shortString + '\0');
    const shortStringValue =
      new TestValue(new DataView(shortStringChars.buffer), 'char');
    assert.deepEqual(
      Formatters.formatCString(wasm, TestValue.pointerTo(shortStringValue, Formatters.Constants.SAFE_HEAP_START)),
      {
        size: shortStringChars.length - 1,
        string: shortStringQuoted,
        chars: shortStringChars.slice(0, shortStringChars.length - 1),
      });

    const wideStringChars = new Uint32Array(shortString.length + 1);
    const wideStringContents = new DataView(wideStringChars.buffer);
    for (let i = 0; i < wideStringChars.length; ++i) {
      wideStringContents.setUint32(i * Uint32Array.BYTES_PER_ELEMENT, shortString.codePointAt(i) ?? 0, true);
    }
    const shortWString = new TestValue(wideStringContents, 'wchar_t');
    assert.deepEqual(
      Formatters.formatCWString(wasm, TestValue.pointerTo(shortWString, Formatters.Constants.SAFE_HEAP_START)),
      {
        size: wideStringChars.length - 1,
        string: shortStringQuoted,
        chars: wideStringChars.slice(0, wideStringChars.length - 1),
      });

    // long string
    const longString = `${new Array(Formatters.Constants.PAGE_SIZE / 4).fill('abcdefg').join('')}`;
    const longStringQuoted = `"${longString}"`;
    const longStringChars = new TextEncoder().encode(longString + '\0');
    const longStringValue = new TestValue(new DataView(longStringChars.buffer), 'char');
    assert.deepEqual(
      Formatters.formatCString(wasm, TestValue.pointerTo(longStringValue, Formatters.Constants.SAFE_HEAP_START)),
      {
        size: longStringChars.length - 1,
        string: longStringQuoted,
        chars: longStringChars.slice(0, longStringChars.length - 1),
      });

    const longWideStringChars = new Uint32Array(longString.length + 1);
    const longWideStringContents = new DataView(longWideStringChars.buffer);
    for (let i = 0; i < longWideStringChars.length; ++i) {
      longWideStringContents.setUint32(i * Uint32Array.BYTES_PER_ELEMENT, longString.codePointAt(i) ?? 0, true);
    }
    const longWString = new TestValue(longWideStringContents, 'wchar_t');
    assert.deepEqual(
      Formatters.formatCWString(wasm, TestValue.pointerTo(longWString, Formatters.Constants.SAFE_HEAP_START)),
      {
        size: longWideStringChars.length - 1,
        string: longStringQuoted,
        chars: longWideStringChars.slice(0, longWideStringChars.length - 1),
      });
  });

  it('formatLibCXXString', () => {
    const wasm = new TestWasmInterface();
    // short string
    const shortString = 'abcdefgh';
    const shortStringQuoted = `"${shortString}"`;
    const shortStringChars = new TextEncoder().encode(shortString);
    const shortFlag = TestValue.fromUint8(shortString.length);
    const longString = new Array(128 / shortString.length).fill(shortString).join('');
    const longStringQuoted = `"${longString}"`;
    const longStringChars = new TextEncoder().encode(longString);
    const longFlag = TestValue.fromUint8(0x80);

    // eslint-disable-next-line @typescript-eslint/naming-convention
    const __s_union = TestValue.fromMembers('__s_union', {});
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const __s = TestValue.fromMembers('__s', { '<union>': __s_union });
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const __l = TestValue.fromMembers('__l', {});
    const str = TestValue.fromMembers('std::string', {
      __r_: TestValue.fromMembers('__r_', {
        __value_: TestValue.fromMembers('__value_', { '<union>': TestValue.fromMembers('__value_union', { __s, __l }) }),
      }),
    });

    // short char8_t
    __s.members.__data_ = new TestValue(new DataView(shortStringChars.buffer), 'char');
    __s_union.members.__size_ = shortFlag;

    assert.deepEqual(Formatters.formatLibCXX8String(wasm, str), {
      size: shortStringChars.length,
      string: shortStringQuoted,
      chars: shortStringChars,
    });

    // long char8_t
    const wideStringChars = new Uint32Array(shortString.length);
    const wideStringContents = new DataView(wideStringChars.buffer);
    for (let i = 0; i < shortString.length; ++i) {
      wideStringContents.setUint32(i * Uint32Array.BYTES_PER_ELEMENT, shortString.codePointAt(i) ?? 0, true);
    }
    __s.members.__data_ = new TestValue(wideStringContents, 'wchar_t');
    __s_union.members.__size_ = shortFlag;

    assert.deepEqual(Formatters.formatLibCXX32String(wasm, str), {
      size: wideStringChars.length,
      string: shortStringQuoted,
      chars: wideStringChars,
    });

    // long char8_t
    wasm.memory = new ArrayBuffer(Formatters.Constants.SAFE_HEAP_START + longString.length);
    new Uint8Array(wasm.memory).set(longStringChars, Formatters.Constants.SAFE_HEAP_START);
    __l.members.__data_ = TestValue.pointerTo(
      new TestValue(new DataView(wasm.memory, Formatters.Constants.SAFE_HEAP_START), 'char'),
      Formatters.Constants.SAFE_HEAP_START);
    __s_union.members.__size_ = longFlag;
    __l.members.__size_ = TestValue.fromUint32(longString.length);

    assert.deepEqual(Formatters.formatLibCXX8String(wasm, str), {
      size: longStringChars.length,
      string: longStringQuoted,
      chars: longStringChars,
    });

    // long char32_t
    wasm.memory =
      new ArrayBuffer(Formatters.Constants.SAFE_HEAP_START + longString.length * Uint32Array.BYTES_PER_ELEMENT);
    const longWideStringChars = new Uint32Array(wasm.memory, Formatters.Constants.SAFE_HEAP_START);
    const longWideStringContents = new DataView(wasm.memory, Formatters.Constants.SAFE_HEAP_START);
    for (let i = 0; i < longString.length; ++i) {
      longWideStringContents.setUint32(i * Uint32Array.BYTES_PER_ELEMENT, longString.codePointAt(i) ?? 0, true);
    }
    __l.members.__data_ =
      TestValue.pointerTo(new TestValue(longWideStringContents, 'wchar_t'), Formatters.Constants.SAFE_HEAP_START);
    __s_union.members.__size_ = longFlag;
    __l.members.__size_ = TestValue.fromUint32(longString.length);

    assert.deepEqual(Formatters.formatLibCXX32String(wasm, str), {
      size: longWideStringChars.length,
      string: longStringQuoted,
      chars: longWideStringChars,
    });
  });

  it('formatVector', () => {
    const wasm = new TestWasmInterface();
    const elements = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(v => TestValue.fromFloat32(v));
    const __begin_ = TestValue.pointerTo(elements, 0x1234);  // eslint-disable-line @typescript-eslint/naming-convention
    const __end_ =                                           // eslint-disable-line @typescript-eslint/naming-convention
      TestValue.pointerTo(elements[elements.length - 1], 0x1234 + Float32Array.BYTES_PER_ELEMENT * elements.length);
    const vector = new TestValue(new DataView(new ArrayBuffer(0)), 'std::vector<float>', { __begin_, __end_ });

    assert.deepEqual(Formatters.formatVector(wasm, vector), elements);
  });

  it('formatPointerOrReference', () => {
    const wasm = new TestWasmInterface();
    assert.deepEqual(Formatters.formatPointerOrReference(wasm, TestValue.fromUint32(0)), { '0x0': null });

    const pointee = TestValue.fromFloat64(15);

    assert.deepEqual(
      Formatters.formatPointerOrReference(wasm, TestValue.pointerTo(pointee, 0x1234)), { '0x1234': pointee });
  });

  it('formatDynamicArray', () => {
    const wasm = new TestWasmInterface();
    const element = TestValue.fromFloat32(5);
    const array = new TestValue(element.asDataView(), 'float[]', { 0: element });
    array.location = 0x1234;
    assert.deepEqual(Formatters.formatDynamicArray(wasm, array), { '0x1234': element });
  });

  it('formatUint128', () => {
    const wasm = new TestWasmInterface();
    const high = 0xdeadn;
    const low = 0xbeefbeefbeefbeefn;
    const content = new DataView(new BigUint64Array([low, high]).buffer);

    const actual = Formatters.formatUInt128(wasm, new TestValue(content, 'uint128_t'));
    const expected = 0xdeadbeefbeefbeefbeefn;
    assert.deepEqual(actual, expected, `expected 0x${actual.toString(16)} to equal 0x${expected.toString(16)}`);
  });

  it('formatInt128', () => {
    const wasm = new TestWasmInterface();
    const expected = -0xdeadbeefbeefbeefbeefn;
    const high = expected >> 64n;
    const low = expected & 0xffffffffffffffffn;
    const content = new DataView(new BigInt64Array([low, high]).buffer);

    const actual = Formatters.formatInt128(wasm, new TestValue(content, 'int128_t'));
    assert.deepEqual(actual, expected, `expected 0x${actual.toString(16)} to equal 0x${expected.toString(16)}`);
  });

  it('formatVoid', async () => {
    const actual = await Formatters.formatVoid()().asRemoteObject();
    assert.deepEqual(actual, {
      type: 'undefined',
      value: undefined,
      description: '<void>',
      hasChildren: false,
      linearMemorySize: undefined,
      linearMemoryAddress: undefined,
    });
  });
});

describe('CustomFormatters', () => {
  for (const makeConst of [true, false]) {
    it(`looks up formatters correctly ${makeConst ? 'const' : 'non-const'} type`, () => {
      const type = (typeName: string, typeProperties: Partial<TypeInfo> = {}): TypeInfo => {
        if (makeConst) {
          typeName = `const ${typeName}`;
        }
        return {
          typeNames: [typeName],
          typeId: typeName,
          members: [],
          alignment: 0,
          arraySize: 0,
          size: 0,
          isPointer: Boolean(typeName.match(/^.+\*$/) || typeName.match(/^.+&$/)),
          canExpand: false,
          hasValue: false,
          ...typeProperties,
        };
      };

      assert.deepEqual(CustomFormatters.get(type('std::__2::string'))?.format, Formatters.formatLibCXX8String);
      assert.deepEqual(
        CustomFormatters
          .get(type('std::__2::basic_string<char, std::__2::char_traits<char>, std::__2::allocator<char> >'))
          ?.format,
        Formatters.formatLibCXX8String);
      assert.deepEqual(CustomFormatters.get(type('std::__2::u8string'))?.format, Formatters.formatLibCXX8String);
      assert.deepEqual(
        CustomFormatters
          .get(type(
            'std::__2::basic_string<char8_t, std::__2::char_traits<char8_t>, std::__2::allocator<char8_t> >'))
          ?.format,
        Formatters.formatLibCXX8String);

      assert.deepEqual(CustomFormatters.get(type('std::__2::u16string'))?.format, Formatters.formatLibCXX16String);
      assert.deepEqual(
        CustomFormatters
          .get(type(
            'std::__2::basic_string<char16_t, std::__2::char_traits<char16_t>, std::__2::allocator<char16_t> >'))
          ?.format,
        Formatters.formatLibCXX16String);

      assert.deepEqual(CustomFormatters.get(type('std::__2::wstring'))?.format, Formatters.formatLibCXX32String);
      assert.deepEqual(
        CustomFormatters
          .get(type(
            'std::__2::basic_string<wchar_t, std::__2::char_traits<wchar_t>, std::__2::allocator<wchar_t> >'))
          ?.format,
        Formatters.formatLibCXX32String);
      assert.deepEqual(CustomFormatters.get(type('std::__2::u32string'))?.format, Formatters.formatLibCXX32String);
      assert.deepEqual(
        CustomFormatters
          .get(type(
            'std::__2::basic_string<char32_t, std::__2::char_traits<char32_t>, std::__2::allocator<char32_t> >'))
          ?.format,
        Formatters.formatLibCXX32String);

      assert.deepEqual(CustomFormatters.get(type('char *'))?.format, Formatters.formatCString);
      assert.deepEqual(CustomFormatters.get(type('char8_t *'))?.format, Formatters.formatCString);
      assert.deepEqual(CustomFormatters.get(type('char16_t *'))?.format, Formatters.formatU16CString);
      assert.deepEqual(CustomFormatters.get(type('wchar_t *'))?.format, Formatters.formatCWString);
      assert.deepEqual(CustomFormatters.get(type('char32_t *'))?.format, Formatters.formatCWString);
      assert.deepEqual(
        CustomFormatters.get(type('int (*)()', { isPointer: true }))?.format, Formatters.formatPointerOrReference);

      assert.deepEqual(CustomFormatters.get(type('std::vector<int>'))?.format, Formatters.formatVector);
      assert.deepEqual(CustomFormatters.get(type('std::vector<const float>'))?.format, Formatters.formatVector);

      assert.deepEqual(CustomFormatters.get(type('int *'))?.format, Formatters.formatPointerOrReference);
      assert.deepEqual(CustomFormatters.get(type('int &'))?.format, Formatters.formatPointerOrReference);
      assert.deepEqual(CustomFormatters.get(type('int[]'))?.format, Formatters.formatDynamicArray);

      assert.deepEqual(CustomFormatters.get(type('unsigned __int128'))?.format, Formatters.formatUInt128);
      assert.deepEqual(CustomFormatters.get(type('__int128'))?.format, Formatters.formatInt128);
    });
  }
});
