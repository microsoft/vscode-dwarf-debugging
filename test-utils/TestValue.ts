// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/tests/TestUtils.ts

import type { ExtendedTypeInfo, Value } from '../src/CustomFormatters';

interface TypedArrayLike {
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
}

export default class TestValue implements Value {
  private dataView: DataView<ArrayBuffer>;
  private typeMap: { [typeId: string]: TestValue; } = {};
  members: { [key: string]: TestValue, [key: number]: TestValue; };
  location: number;
  size: number;
  typeNames: string[];
  isEnumeratedValue: boolean = false;
  extendedTypeInfo?: ExtendedTypeInfo | undefined;

  static fromInt8(value: number, typeName = 'int8_t'): TestValue {
    const content = new DataView(new ArrayBuffer(1));
    content.setInt8(0, value);
    return new TestValue(content, typeName);
  }
  static fromInt16(value: number, typeName = 'int16_t'): TestValue {
    const content = new DataView(new ArrayBuffer(2));
    content.setInt16(0, value, true);
    return new TestValue(content, typeName);
  }
  static fromInt32(value: number, typeName = 'int32_t'): TestValue {
    const content = new DataView(new ArrayBuffer(4));
    content.setInt32(0, value, true);
    return new TestValue(content, typeName);
  }
  static fromInt64(value: bigint, typeName = 'int64_t'): TestValue {
    const content = new DataView(new ArrayBuffer(8));
    content.setBigInt64(0, value, true);
    return new TestValue(content, typeName);
  }
  static fromUint8(value: number, typeName = 'uint8_t'): TestValue {
    const content = new DataView(new ArrayBuffer(1));
    content.setUint8(0, value);
    return new TestValue(content, typeName);
  }
  static fromUint16(value: number, typeName = 'uint16_t'): TestValue {
    const content = new DataView(new ArrayBuffer(2));
    content.setUint16(0, value, true);
    return new TestValue(content, typeName);
  }
  static fromUint32(value: number, typeName = 'uint32_t'): TestValue {
    const content = new DataView(new ArrayBuffer(4));
    content.setUint32(0, value, true);
    return new TestValue(content, typeName);
  }
  static fromUint64(value: bigint, typeName = 'uint64_t'): TestValue {
    const content = new DataView(new ArrayBuffer(8));
    content.setBigUint64(0, value, true);
    return new TestValue(content, typeName);
  }
  static fromFloat32(value: number, typeName = 'float'): TestValue {
    const content = new DataView(new ArrayBuffer(4));
    content.setFloat32(0, value, true);
    return new TestValue(content, typeName);
  }
  static fromFloat64(value: number, typeName = 'double'): TestValue {
    const content = new DataView(new ArrayBuffer(8));
    content.setFloat64(0, value, true);
    return new TestValue(content, typeName);
  }
  static pointerTo(pointeeOrElements: TestValue | TestValue[], address?: number): TestValue {
    const content = new DataView(new ArrayBuffer(4));
    const elements = Array.isArray(pointeeOrElements) ? pointeeOrElements : [pointeeOrElements];
    address = address ?? elements[0].location;
    content.setUint32(0, address, true);
    const space = elements[0].typeNames[0].endsWith('*') ? '' : ' ';
    const members: { [key: string | number]: TestValue; } = { '*': elements[0] };
    for (let i = 0; i < elements.length; ++i) {
      members[i] = elements[i];
    }
    return new TestValue(content, `${elements[0].typeNames[0]}${space}*`, members);
  }
  static fromType(typeName: string, data: TypedArrayLike = new Uint8Array(), location?: number) {
    return new TestValue(new DataView(data.buffer), typeName, undefined, location);
  }
  static fromMembers(typeName: string, members: { [key: string]: TestValue, [key: number]: TestValue; }): TestValue {
    return new TestValue(new DataView(new ArrayBuffer(0)), typeName, members);
  }

  asInt8(): number {
    return this.dataView.getInt8(0);
  }
  asInt16(): number {
    return this.dataView.getInt16(0, true);
  }
  asInt32(): number {
    return this.dataView.getInt32(0, true);
  }
  asInt64(): bigint {
    return this.dataView.getBigInt64(0, true);
  }
  asUint8(): number {
    return this.dataView.getUint8(0);
  }
  asUint16(): number {
    return this.dataView.getUint16(0, true);
  }
  asUint32(): number {
    return this.dataView.getUint32(0, true);
  }
  asUint64(): bigint {
    return this.dataView.getBigUint64(0, true);
  }
  asFloat32(): number {
    return this.dataView.getFloat32(0, true);
  }
  asFloat64(): number {
    return this.dataView.getFloat64(0, true);
  }
  asType(typeId: string, offset = 0): Value {
    return this.typeMap[typeId] ?? new TestValue(this.dataView, typeId, undefined, this.location + offset);
  }
  asPointerToType(typeId: string): Value {
    return new TestValue(this.dataView, `${typeId} *`, new Proxy({}, {
      get(_target, p) {
        if (typeof p === 'string' && /^\*|(\d+)$/.test(p)) {
          return TestValue.fromType(typeId);
        }
      }
    }));
  }
  asDataView(offset?: number, size?: number): DataView<ArrayBuffer> {
    offset = this.location + (offset ?? 0);
    size = Math.min(size ?? this.size, this.size - Math.max(0, offset));
    return new DataView(this.dataView.buffer, offset, size);
  }
  getMembers(): string[] {
    return Object.keys(this.members);
  }
  $(member: string | number): Value {
    if (typeof member === 'number' || !member.includes('.')) {
      return this.members[member] || (() => { throw new Error(`Invalid member ${member}`); })();
    }
    let value: Value = this;
    for (const prop of member.split('.')) {
      value = value.$(prop);
    }
    return value;
  }

  offsetBy(offset: number) {
    return new TestValue(this.dataView, this.typeNames[0], this.members, this.location + offset);
  }

  registerAsType(value: TestValue): string {
    const typeId = `${Object.keys(this.typeMap).length + 1}`;
    this.typeMap[typeId] = value;
    return typeId;
  }

  withVariants(discriminator: TestValue, ...variants: [number, string, TestValue][]) {
    this.extendedTypeInfo ??= { languageId: 0, variantParts: [], templateParameters: [] };
    this.extendedTypeInfo.variantParts = [{
      discriminatorMember: { typeId: this.registerAsType(discriminator), offset: 0 },
      variants: variants.map(([discriminatorValue, name, variant]) => ({
        discriminatorValue: BigInt(discriminatorValue),
        members: [{
          name,
          typeId: this.registerAsType(TestValue.fromMembers(name, { '__0': variant.offsetBy(discriminator.size) })),
          offset: discriminator.size,
        }]
      })),
    }];
    return this;
  }

  withTemplateParameters(...typeNames: string[]) {
    this.extendedTypeInfo ??= { languageId: 0, variantParts: [], templateParameters: [] };
    this.extendedTypeInfo.templateParameters.push(...typeNames.map(typeId => ({ typeId })));
    return this;
  }

  constructor(
    content: DataView<ArrayBuffer>,
    typeName: string,
    members: { [key: string]: TestValue, [key: number]: TestValue; } = {},
    location: number = 0,
  ) {
    this.location = location;
    this.size = content.byteLength;
    this.typeNames = [typeName];
    this.members = members;
    this.dataView = content;
  }
}
