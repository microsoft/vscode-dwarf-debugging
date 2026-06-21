// This file is based on a file from revision cf3a5c70b97b388fff3490b62f1bdaaa6a26f8e1 
// of the Chrome DevTools C/C++ Debugging Extension, see the wasm/symbols-backend/LICENSE file.
//
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/extensions/cxx_debugging/src/CustomFormatters.ts

import type { Chrome } from './ExtensionAPI';

import type { WasmValue } from './WasmTypes';
import type { HostInterface } from './WorkerRPC';

export interface FieldInfo {
  typeId: string;
  offset: number;
  name?: string;
}

export interface Enumerator {
  typeId: string;
  name: string;
  value: bigint;
}

export interface VariantInfo {
  discriminatorValue?: bigint;
  members: FieldInfo[];
}

export interface VariantPartInfo {
  discriminatorMember: FieldInfo;
  variants: VariantInfo[];
}

export interface TemplateParameterInfo {
  typeId: string;
  name?: string;
}

export interface ExtendedTypeInfo {
  languageId: number;
  variantParts: VariantPartInfo[];
  templateParameters: TemplateParameterInfo[];
}

export interface TypeInfo {
  typeNames: string[];
  typeId: string;
  alignment: number;
  size: number;
  canExpand: boolean;
  hasValue: boolean;
  arraySize: number;
  isPointer: boolean;
  members: FieldInfo[];
  enumerators: Enumerator[];
  extendedInfo?: ExtendedTypeInfo;
}

export interface TypeInfoTree {
  root: TypeInfo;
  typeInfos: TypeInfo[];
}

export interface WasmInterface {
  readonly view: WasmMemoryView;
  readMemory(offset: number, length: number): Uint8Array<ArrayBuffer>;
  getOp(op: number): WasmValue;
  getLocal(local: number): WasmValue;
  getGlobal(global: number): WasmValue;
}

export interface Value {
  readonly location: number;
  readonly size: number;
  readonly typeNames: string[];
  readonly isEnumeratedValue: boolean;
  readonly extendedTypeInfo?: ExtendedTypeInfo;
  asUint8(): number;
  asUint16(): number;
  asUint32(): number;
  asUint64(): bigint;
  asInt8(): number;
  asInt16(): number;
  asInt32(): number;
  asInt64(): bigint;
  asFloat32(): number;
  asFloat64(): number;
  asDataView(offset?: number, size?: number): DataView<ArrayBuffer>;
  asType(typeId: string, offset?: number): Value;
  asPointerToType(typeId: string): Value;
  $(member: string | number): Value;
  getMembers(): string[];
}

export class MemorySlice {
  readonly begin: number;
  buffer: ArrayBuffer;

  constructor(buffer: ArrayBuffer, begin: number) {
    this.begin = begin;
    this.buffer = buffer;
  }

  merge(other: MemorySlice): MemorySlice {
    if (other.begin < this.begin) {
      return other.merge(this);
    }
    if (other.begin > this.end) {
      throw new Error('Slices are not contiguous');
    }
    if (other.end <= this.end) {
      return this;
    }

    const newBuffer = new Uint8Array(other.end - this.begin);
    newBuffer.set(new Uint8Array(this.buffer), 0);
    newBuffer.set(new Uint8Array(other.buffer, this.end - other.begin), this.length);

    return new MemorySlice(newBuffer.buffer, this.begin);
  }

  contains(offset: number): boolean {
    return this.begin <= offset && offset < this.end;
  }

  get length(): number {
    return this.buffer.byteLength;
  }

  get end(): number {
    return this.length + this.begin;
  }

  view(begin: number, length: number): DataView<ArrayBuffer> {
    return new DataView(this.buffer, begin - this.begin, length);
  }
}

export class PageStore {
  readonly slices: MemorySlice[] = [];

  // Returns the highest index |i| such that |slices[i].start <= offset|, or -1 if there is no such |i|.
  findSliceIndex(offset: number): number {
    let begin = 0;
    let end = this.slices.length;
    while (begin < end) {
      const idx = Math.floor((end + begin) / 2);

      const pivot = this.slices[idx];
      if (offset < pivot.begin) {
        end = idx;
      } else {
        begin = idx + 1;
      }
    }
    return begin - 1;
  }

  findSlice(offset: number): MemorySlice | null {
    return this.getSlice(this.findSliceIndex(offset), offset);
  }

  private getSlice(index: number, offset: number): MemorySlice | null {
    if (index < 0) {
      return null;
    }
    const candidate = this.slices[index];
    return candidate?.contains(offset) ? candidate : null;
  }

  addSlice(buffer: ArrayBuffer | number[], begin: number): MemorySlice {
    let slice = new MemorySlice(Array.isArray(buffer) ? new Uint8Array(buffer).buffer : buffer, begin);

    let leftPosition = this.findSliceIndex(slice.begin - 1);
    const leftOverlap = this.getSlice(leftPosition, slice.begin - 1);
    if (leftOverlap) {
      slice = slice.merge(leftOverlap);
    } else {
      leftPosition++;
    }
    const rightPosition = this.findSliceIndex(slice.end);
    const rightOverlap = this.getSlice(rightPosition, slice.end);
    if (rightOverlap) {
      slice = slice.merge(rightOverlap);
    }
    this.slices.splice(
      leftPosition,                      // Insert to the right if no overlap
      rightPosition - leftPosition + 1,  // Delete one additional slice if overlapping on the left
      slice);
    return slice;
  }
}

export class WasmMemoryView {
  private readonly wasm: WasmInterface;
  private readonly pages = new PageStore();
  private static readonly PAGE_SIZE = 4096;

  constructor(wasm: WasmInterface) {
    this.wasm = wasm;
  }

  private page(byteOffset: number, byteLength: number): { page: number, offset: number, count: number; } {
    const mask = WasmMemoryView.PAGE_SIZE - 1;
    const offset = byteOffset & mask;
    const page = byteOffset - offset;
    const rangeEnd = byteOffset + byteLength;
    const count = 1 + Math.ceil((rangeEnd - (rangeEnd & mask) - page) / WasmMemoryView.PAGE_SIZE);
    return { page, offset, count };
  }

  private getPages(page: number, count: number): DataView<ArrayBuffer> {
    if (page & (WasmMemoryView.PAGE_SIZE - 1)) {
      throw new Error('Not a valid page');
    }
    let slice = this.pages.findSlice(page);
    const size = WasmMemoryView.PAGE_SIZE * count;
    if (!slice || slice.length < count * WasmMemoryView.PAGE_SIZE) {
      const data = this.wasm.readMemory(page, size);
      if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) {
        throw new Error('Did not expect a partial memory view');
      }
      slice = this.pages.addSlice(data.buffer, page);
    }
    return slice.view(page, size);
  }

  getFloat32(byteOffset: number, littleEndian?: boolean): number {
    const { offset, page, count } = this.page(byteOffset, 4);
    const view = this.getPages(page, count);
    return view.getFloat32(offset, littleEndian);
  }
  getFloat64(byteOffset: number, littleEndian?: boolean): number {
    const { offset, page, count } = this.page(byteOffset, 8);
    const view = this.getPages(page, count);
    return view.getFloat64(offset, littleEndian);
  }
  getInt8(byteOffset: number): number {
    const { offset, page, count } = this.page(byteOffset, 1);
    const view = this.getPages(page, count);
    return view.getInt8(offset);
  }
  getInt16(byteOffset: number, littleEndian?: boolean): number {
    const { offset, page, count } = this.page(byteOffset, 2);
    const view = this.getPages(page, count);
    return view.getInt16(offset, littleEndian);
  }
  getInt32(byteOffset: number, littleEndian?: boolean): number {
    const { offset, page, count } = this.page(byteOffset, 4);
    const view = this.getPages(page, count);
    return view.getInt32(offset, littleEndian);
  }
  getUint8(byteOffset: number): number {
    const { offset, page, count } = this.page(byteOffset, 1);
    const view = this.getPages(page, count);
    return view.getUint8(offset);
  }
  getUint16(byteOffset: number, littleEndian?: boolean): number {
    const { offset, page, count } = this.page(byteOffset, 2);
    const view = this.getPages(page, count);
    return view.getUint16(offset, littleEndian);
  }
  getUint32(byteOffset: number, littleEndian?: boolean): number {
    const { offset, page, count } = this.page(byteOffset, 4);
    const view = this.getPages(page, count);
    return view.getUint32(offset, littleEndian);
  }
  getBigInt64(byteOffset: number, littleEndian?: boolean): bigint {
    const { offset, page, count } = this.page(byteOffset, 8);
    const view = this.getPages(page, count);
    return view.getBigInt64(offset, littleEndian);
  }
  getBigUint64(byteOffset: number, littleEndian?: boolean): bigint {
    const { offset, page, count } = this.page(byteOffset, 8);
    const view = this.getPages(page, count);
    return view.getBigUint64(offset, littleEndian);
  }
  asDataView(byteOffset: number, byteLength: number): DataView<ArrayBuffer> {
    const { offset, page, count } = this.page(byteOffset, byteLength);
    const view = this.getPages(page, count);
    return new DataView(view.buffer, view.byteOffset + offset, byteLength);
  }
}

export class CXXValue implements Value, LazyObject {
  readonly location: number;
  private readonly type: TypeInfo;
  private readonly data?: number[];
  private readonly memoryOrDataView: DataView<ArrayBuffer> | WasmMemoryView;
  private readonly wasm: WasmInterface;
  private readonly typeMap: Map<unknown, TypeInfo>;
  private readonly memoryView: WasmMemoryView;
  private membersMap?: Map<string, { location: number, type: TypeInfo; }>;
  private readonly objectStore: LazyObjectStore;
  private readonly objectId: string;
  private readonly displayValue: string | undefined;
  private readonly memoryAddress?: number;

  constructor(
    objectStore: LazyObjectStore, wasm: WasmInterface, memoryView: WasmMemoryView, location: number, type: TypeInfo,
    typeMap: Map<unknown, TypeInfo>, data?: number[], displayValue?: string, memoryAddress?: number) {
    if (!location && !data) {
      throw new Error('Cannot represent nullptr');
    }
    this.data = data;
    this.location = location;
    this.type = type;
    this.typeMap = typeMap;
    this.wasm = wasm;
    this.memoryOrDataView = data ? new DataView(new Uint8Array(data).buffer) : memoryView;
    if (data && data.length !== type.size) {
      throw new Error('Invalid data size');
    }
    this.memoryView = memoryView;
    this.objectStore = objectStore;
    this.objectId = objectStore.store(this);
    this.displayValue = displayValue;
    this.memoryAddress = memoryAddress === undefined && !data ? this.location : memoryAddress;
  }

  static create(objectStore: LazyObjectStore, wasm: WasmInterface, memoryView: WasmMemoryView, value: {
    typeInfos: TypeInfo[],
    root: TypeInfo,
    location?: number,
    data?: number[],
    displayValue?: string,
    memoryAddress?: number,
  }): CXXValue {
    const typeMap = new Map();
    for (const info of value.typeInfos) {
      typeMap.set(info.typeId, info);
    }
    const { location, root, data, displayValue, memoryAddress } = value;
    return new CXXValue(objectStore, wasm, memoryView, location ?? 0, root, typeMap, data, displayValue, memoryAddress);
  }

  private get members(): Map<string, { location: number, type: TypeInfo; }> {
    if (!this.membersMap) {
      this.membersMap = new Map();
      for (const member of this.type.members) {
        const memberType = this.typeMap.get(member.typeId);
        if (memberType && member.name) {
          const memberLocation = member.name === '*' ? this.memoryOrDataView.getUint32(this.location, true) :
            this.location + member.offset;
          this.membersMap.set(member.name, { location: memberLocation, type: memberType });
        }
      }
    }
    return this.membersMap;
  }

  private getArrayElement(index: number): CXXValue {
    const data = this.members.has('*') ? undefined : this.data;
    const element = this.members.get('*') || this.members.get('0');
    if (!element) {
      throw new Error(`Incomplete type information for array or pointer type '${this.typeNames}'`);
    }
    return new CXXValue(
      this.objectStore, this.wasm, this.memoryView, element.location + index * element.type.size, element.type,
      this.typeMap, data);
  }

  async getProperties(): Promise<Array<{ name: string, property: LazyObject; }>> {
    const properties = [];
    if (this.type.arraySize > 0) {
      for (let index = 0; index < this.type.arraySize; ++index) {
        properties.push({ name: `${index}`, property: this.getArrayElement(index) });
      }
    } else {
      const members = this.members;
      const data = members.has('*') ? undefined : this.data;
      for (const [name, { location, type }] of members) {
        const property = new CXXValue(this.objectStore, this.wasm, this.memoryView, location, type, this.typeMap, data);
        properties.push({ name, property });
      }
    }
    return properties;
  }

  async asRemoteObject(): Promise<Chrome.DevTools.RemoteObject | Chrome.DevTools.ForeignObject> {
    const formatter = CustomFormatters.get(this.type);
    if (formatter) {
      if (this.location === undefined || (!this.data && this.location === 0xffffffff)) {
        const type = 'undefined' as Chrome.DevTools.RemoteObjectType;
        const description = '<optimized out>';
        return { type, description, hasChildren: false };
      }
      try {
        const formattedValue = formatter.format(this.wasm, this);
        return await lazyObjectFromAny(
          formattedValue, this.objectStore, this.type, this.displayValue, this.memoryAddress)
          .asRemoteObject();
      } catch {
        // Fallthrough
      }
    } else if (this.type.hasValue && this.type.arraySize === 0) {
      const type = 'undefined' as Chrome.DevTools.RemoteObjectType;
      const description = '<not displayable>';
      return { type, description, hasChildren: false };
    }

    const type = (this.type.arraySize > 0 ? 'array' : 'object') as Chrome.DevTools.RemoteObjectType;
    const { objectId } = this;
    return {
      type,
      description: this.type.typeNames[0],
      hasChildren: this.type.members.length > 0,
      linearMemoryAddress: this.memoryAddress,
      linearMemorySize: this.type.size,
      objectId,
    };
  }

  get size(): number {
    return this.type.size;
  }

  get typeNames(): string[] {
    return this.type.typeNames;
  }

  get isEnumeratedValue(): boolean {
    return this.type.enumerators.length > 0;
  }

  get extendedTypeInfo(): ExtendedTypeInfo | undefined {
    return this.type.extendedInfo;
  }

  asInt8(): number {
    return this.memoryOrDataView.getInt8(this.location);
  }
  asInt16(): number {
    return this.memoryOrDataView.getInt16(this.location, true);
  }
  asInt32(): number {
    return this.memoryOrDataView.getInt32(this.location, true);
  }
  asInt64(): bigint {
    return this.memoryOrDataView.getBigInt64(this.location, true);
  }
  asUint8(): number {
    return this.memoryOrDataView.getUint8(this.location);
  }
  asUint16(): number {
    return this.memoryOrDataView.getUint16(this.location, true);
  }
  asUint32(): number {
    return this.memoryOrDataView.getUint32(this.location, true);
  }
  asUint64(): bigint {
    return this.memoryOrDataView.getBigUint64(this.location, true);
  }
  asFloat32(): number {
    return this.memoryOrDataView.getFloat32(this.location, true);
  }
  asFloat64(): number {
    return this.memoryOrDataView.getFloat64(this.location, true);
  }
  asDataView(offset?: number, size?: number): DataView<ArrayBuffer> {
    offset = this.location + (offset ?? 0);
    size = size ?? this.size;
    if (this.memoryOrDataView instanceof DataView) {
      size = Math.min(size - offset, this.memoryOrDataView.byteLength - offset - this.location);
      if (size < 0) {
        throw new RangeError('Size exceeds the buffer range');
      }
      return new DataView(
        this.memoryOrDataView.buffer, this.memoryOrDataView.byteOffset + this.location + offset, size);
    }
    return this.memoryView.asDataView(offset, size);
  }
  asType(typeId: string, offset?: number): CXXValue {
    const targetType = this.typeMap.get(typeId);
    if (!targetType) {
      throw new Error(`Invalid type id ${typeId}`);
    }
    const targetData = offset && this.data !== undefined
      ? this.data.slice(offset, offset + targetType.size)
      : this.data;
    return new CXXValue(
      this.objectStore,
      this.wasm,
      this.memoryView,
      this.location + (offset || 0),
      targetType,
      this.typeMap,
      targetData,
      this.displayValue,
      this.memoryAddress
    );
  }
  asPointerToType(typeId: string): CXXValue {
    const targetType = this.typeMap.get(typeId);
    if (!targetType) {
      throw new Error(`Invalid type id ${typeId}`);
    }
    return new CXXValue(
      this.objectStore,
      this.wasm,
      this.memoryView,
      this.location,
      {
        typeNames: targetType.typeNames.map(t => `${t}${t.endsWith('*') ? '' : ' '}*`),
        typeId: '',
        alignment: 4,
        size: 4,
        canExpand: true,
        hasValue: true,
        arraySize: 0,
        isPointer: true,
        members: [{ name: '*', typeId, offset: 0 }],
        enumerators: [],
      },
      this.typeMap,
      this.data,
      this.displayValue,
      this.memoryAddress
    );
  }
  $(selector: string | number): CXXValue {
    const data = this.members.has('*') ? undefined : this.data;

    if (typeof selector === 'number') {
      return this.getArrayElement(selector);
    }

    const dot = selector.indexOf('.');
    const memberName = dot >= 0 ? selector.substring(0, dot) : selector;
    selector = selector.substring(memberName.length + 1);

    const member = this.members.get(memberName);
    if (!member) {
      throw new Error(`Type ${this.typeNames[0] || '<anonymous>'} has no member '${memberName}'. Available members are: ${Array.from(this.members.keys())}`);
    }
    const memberValue =
      new CXXValue(this.objectStore, this.wasm, this.memoryView, member.location, member.type, this.typeMap, data);
    if (selector.length === 0) {
      return memberValue;
    }
    return memberValue.$(selector);
  }

  getMembers(): string[] {
    return Array.from(this.members.keys());
  }
}

export interface LazyObject {
  getProperties(): Promise<Array<{ name: string, property: LazyObject; }>>;
  asRemoteObject(): Promise<Chrome.DevTools.RemoteObject | Chrome.DevTools.ForeignObject>;
}

export function primitiveObject<T>(
  value: T, description?: string, linearMemoryAddress?: number, type?: TypeInfo): PrimitiveLazyObject<T> | null {
  if (['number', 'string', 'boolean', 'bigint', 'undefined'].includes(typeof value)) {
    if (typeof value === 'bigint' || typeof value === 'number') {
      const enumerator = type?.enumerators.find(e => e.value === BigInt(value));
      if (enumerator) {
        description = enumerator.name;
      }
    }
    return new PrimitiveLazyObject(
      typeof value as Chrome.DevTools.RemoteObjectType, value, description, linearMemoryAddress, type?.size);
  }
  return null;
}

function lazyObjectFromAny(
  value: FormatterResult, objectStore: LazyObjectStore, type?: TypeInfo, description?: string,
  linearMemoryAddress?: number): LazyObject {
  const primitive = primitiveObject(value, description, linearMemoryAddress, type);
  if (primitive) {
    return primitive;
  }
  if (value instanceof CXXValue) {
    return value;
  }
  if (typeof value === 'object') {
    if (value === null) {
      return new PrimitiveLazyObject(
        'null' as Chrome.DevTools.RemoteObjectType, value, description, linearMemoryAddress);
    }
    return new LocalLazyObject(value, objectStore, type, linearMemoryAddress);
  }
  if (typeof value === 'function') {
    return value();
  }

  throw new Error('Value type is not formattable');
}

export class LazyObjectStore {
  private nextObjectId = 0;
  private objects = new Map<string, LazyObject>();

  store(lazyObject: LazyObject): string {
    const objectId = `${this.nextObjectId++}`;
    this.objects.set(objectId, lazyObject);
    return objectId;
  }

  get(objectId: string): LazyObject | undefined {
    return this.objects.get(objectId);
  }

  release(objectId: string): void {
    this.objects.delete(objectId);
  }

  clear(): void {
    this.objects.clear();
  }
}

export class PrimitiveLazyObject<T> implements LazyObject {
  readonly type: Chrome.DevTools.RemoteObjectType;
  readonly value: T;
  readonly description: string;
  private readonly linearMemoryAddress?: number;
  private readonly linearMemorySize?: number;
  constructor(
    type: Chrome.DevTools.RemoteObjectType, value: T, description?: string, linearMemoryAddress?: number,
    linearMemorySize?: number) {
    this.type = type;
    this.value = value;
    this.description = description ?? `${value}`;
    this.linearMemoryAddress = linearMemoryAddress;
    this.linearMemorySize = linearMemorySize;
  }

  async getProperties(): Promise<Array<{ name: string, property: LazyObject; }>> {
    return [];
  }

  async asRemoteObject(): Promise<Chrome.DevTools.RemoteObject> {
    const { type, value, description, linearMemoryAddress, linearMemorySize } = this;
    return { type, hasChildren: false, value, description, linearMemoryAddress, linearMemorySize };
  }
}

export class LocalLazyObject implements LazyObject {
  readonly value: Object;
  private readonly objectId;
  private readonly objectStore: LazyObjectStore;
  private readonly type?: TypeInfo;
  private readonly linearMemoryAddress?: number;

  constructor(value: object, objectStore: LazyObjectStore, type?: TypeInfo, linearMemoryAddress?: number) {
    this.value = value;
    this.objectStore = objectStore;
    this.objectId = objectStore.store(this);
    this.type = type;
    this.linearMemoryAddress = linearMemoryAddress;
  }

  async getProperties(): Promise<Array<{ name: string, property: LazyObject; }>> {
    return Object.entries(this.value).map(([name, value]) => {
      const property = lazyObjectFromAny(value, this.objectStore);
      return { name, property };
    });
  }

  async asRemoteObject(): Promise<Chrome.DevTools.RemoteObject> {
    const type = (Array.isArray(this.value) ? 'array' : 'object') as Chrome.DevTools.RemoteObjectType;
    const { objectId, type: valueType, linearMemoryAddress } = this;
    return {
      type,
      objectId,
      description: valueType?.typeNames[0],
      hasChildren: Object.keys(this.value).length > 0,
      linearMemorySize: valueType?.size,
      linearMemoryAddress,
    };
  }
}

export type FormatterResult = number | string | boolean | bigint | undefined | CXXValue | object | (() => LazyObject);
export type FormatterCallback = (wasm: WasmInterface, value: Value) => FormatterResult;

export interface Formatter {
  types: string[] | ((t: TypeInfo) => boolean);
  format: FormatterCallback;
}

export class HostWasmInterface implements WasmInterface {
  private readonly hostInterface: HostInterface;
  private readonly stopId: unknown;
  readonly view: WasmMemoryView;
  constructor(hostInterface: HostInterface, stopId: unknown) {
    this.hostInterface = hostInterface;
    this.stopId = stopId;
    this.view = new WasmMemoryView(this);
  }
  readMemory(offset: number, length: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.hostInterface.getWasmLinearMemory(offset, length, this.stopId));
  }
  getOp(op: number): WasmValue {
    return this.hostInterface.getWasmOp(op, this.stopId);
  }
  getLocal(local: number): WasmValue {
    return this.hostInterface.getWasmLocal(local, this.stopId);
  }
  getGlobal(global: number): WasmValue {
    return this.hostInterface.getWasmGlobal(global, this.stopId);
  }
}

export class DebuggerProxy {
  wasm: WasmInterface;
  target: EmscriptenModule;
  constructor(wasm: WasmInterface, target: EmscriptenModule) {
    this.wasm = wasm;
    this.target = target;
  }

  readMemory(src: number, dst: number, length: number): number {
    const data = this.wasm.view.asDataView(src, length);
    this.target.HEAP8.set(new Uint8Array(data.buffer, data.byteOffset, length), dst);
    return data.byteLength;
  }
  getLocal(index: number): WasmValue {
    return this.wasm.getLocal(index);
  }
  getGlobal(index: number): WasmValue {
    return this.wasm.getGlobal(index);
  }
  getOperand(index: number): WasmValue {
    return this.wasm.getOp(index);
  }
}

export class CustomFormatters {
  private static formatters = new Map<string, Formatter>();
  private static genericFormatters: Formatter[] = [];

  static addFormatter(formatter: Formatter): void {
    if (Array.isArray(formatter.types)) {
      for (const type of formatter.types) {
        CustomFormatters.formatters.set(type, formatter);
      }
    } else {
      CustomFormatters.genericFormatters.push(formatter);
    }
  }

  static get(type: TypeInfo): Formatter | null {
    for (const name of type.typeNames) {
      const formatter = CustomFormatters.formatters.get(name);
      if (formatter) {
        return formatter;
      }
    }

    for (const t of type.typeNames) {
      const CONST_PREFIX = 'const ';
      if (t.startsWith(CONST_PREFIX)) {
        const formatter = CustomFormatters.formatters.get(t.substr(CONST_PREFIX.length));
        if (formatter) {
          return formatter;
        }
      }
    }

    for (const formatter of CustomFormatters.genericFormatters) {
      if (formatter.types instanceof Function) {
        if (formatter.types(type)) {
          return formatter;
        }
      }
    }
    return null;
  }
}
