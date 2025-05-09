
interface HasClassPointer<T> {
  ['$$']: { '__embind_type_marker': T; };
};

export interface EmbindObject<T = object> extends HasClassPointer<T> {
  new(): this;
  delete(): void;
}

export interface Vector<T> extends EmbindObject<Vector<T>> {
  size(): number;
  get(index: number): T;
  push_back(value: T): void;
}

export interface EnumValue<E, K extends string> extends EmbindObject<E & { 'values': { [P in K]: E }; }> {
  value(): number;
}

export type EnumDefinition<T extends EnumValue<any, string>> = T['$$']['__embind_type_marker']['values'];

export type UnmarshalObject<T> =
  T extends EnumValue<T, infer E> ? E :
  T extends Vector<infer E> ? UnmarshalObject<E>[] :
  T extends EmbindObject ? { [P in Exclude<keyof T, keyof EmbindObject>]: UnmarshalObject<T[P]> } :
  T;

export type UnmarshalInterface<T> = {
  [P in Exclude<keyof T, keyof HasClassPointer<T>>]: T[P] extends (...args: infer A) => infer R
  ? (...args: A) => UnmarshalObject<R>
  : never
};

export interface UnmarshallerOptions {
  enumTypes?: Record<string | symbol, object>[];
}

export interface UnmarshalledInterfaceOptions<K> extends UnmarshallerOptions {
  methods: K[];
}

function prototypeOfHasMethods(obj: unknown, ...methods: string[]): boolean {
  return typeof obj === 'object' && obj !== null && methods.every(m => m in Object.getPrototypeOf(obj));
}

function isEmbindObject(obj: unknown): obj is EmbindObject {
  return prototypeOfHasMethods(obj, 'delete');
}

function isEmVector(obj: unknown): obj is Vector<unknown> {
  return prototypeOfHasMethods(obj, 'delete', 'size', 'get', 'push_back');
}

export function getUnmarshaller(options: UnmarshallerOptions) {
  const { enumTypes = [] } = options;

  const enumValueToNameMap = new Map<object, string>(
    enumTypes.flatMap(t =>
      Object.entries(t)
        .filter(([, value]) => 'value' in value)
        .map(([name, value]) => [value, name]))
  );

  return function unmarshal<T>(obj: (T & EmbindObject) | UnmarshalObject<T>): UnmarshalObject<T> {

    if (typeof obj === 'object' && obj !== null && enumValueToNameMap.has(obj)) {
      return enumValueToNameMap.get(obj) as UnmarshalObject<T> & string;
    }

    if (!isEmbindObject(obj)) {
      return obj;
    }

    try {
      if (isEmVector(obj)) {
        const unmarshalledArray: unknown[] = [];
        unmarshalledArray.length = obj.size();
        for (let i = 0; i < unmarshalledArray.length; i++) {
          unmarshalledArray[i] = unmarshal(obj.get(i));
        }
        return unmarshalledArray as UnmarshalObject<T>;
      } else {
        const unmarshalledObj: Record<string, unknown> = {};
        for (const k in obj) {
          const v = (obj as Record<string, unknown>)[k];
          if (typeof v !== 'function') {
            unmarshalledObj[k] = unmarshal(v);
          }
        }
        return unmarshalledObj as UnmarshalObject<T>;
      }
    } finally {
      obj.delete();
    }
  };
}

export function getUnmarshalledInterface<T extends { [P in K]: (...args: any[]) => any }, K extends keyof T>(
  target: T,
  options: UnmarshalledInterfaceOptions<K>,
): UnmarshalInterface<Pick<T, K>> {

  const { methods } = options;
  const unmarshal = getUnmarshaller(options);

  return Object.fromEntries(methods.map(method => [
    method,
    (...args: any[]) => {
      return unmarshal(target[method](...args));
    }
  ])) as UnmarshalInterface<Pick<T, K>>;
}
