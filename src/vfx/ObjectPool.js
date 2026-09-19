/**
 * ObjectPool.js — 极简对象池（移植自 elemental-sandbox 的 utils/ObjectPool）。
 */
export class ObjectPool {
  constructor(create, release) {
    this._create = create;
    this._release = release;
    this._free = [];
  }

  acquire() {
    return this._free.length > 0 ? this._free.pop() : this._create();
  }

  release(object) {
    this._release?.(object);
    this._free.push(object);
  }

  dispose(disposeObject) {
    if (disposeObject) for (const object of this._free) disposeObject(object);
    this._free.length = 0;
  }
}
