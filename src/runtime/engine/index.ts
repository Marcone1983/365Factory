/**
 * Engine barrel.
 *
 * Generated 3D products import from `./engine` only; nothing in a generated
 * game reaches into an engine submodule directly, which keeps the runtime
 * contract stable across regenerations.
 */
export * from './core';
export * from './input';
export * from './world';
export * from './physics';
export * from './fx';
export * from './audio';
export * from './ui';
export * from './state';
