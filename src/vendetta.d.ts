// Minimal hand-written typings for the Vendetta-style API that Kettu/Revenge expose to
// plugins. They are intentionally loose (`any`): the goal is to let `tsc` check OUR code
// without installing a typings package. At runtime these modules are not bundled - the
// build maps "@vendetta/x/y" to the global object `vendetta.x.y` that the loader provides.

declare module "@vendetta/patcher" {
  export function before(funcName: string, parent: any, callback: (args: any[]) => any[] | void): () => void;
  export function after(funcName: string, parent: any, callback: (args: any[], ret: any) => any): () => void;
  export function instead(funcName: string, parent: any, callback: (args: any[], orig: (...a: any[]) => any) => any): () => void;
}

declare module "@vendetta/metro" {
  export function findByProps(...props: string[]): any;
  export function findByName(name: string, defaultExp?: boolean): any;
  export function findByStoreName(name: string): any;
}

declare module "@vendetta/metro/common" {
  export const React: any;
  export const ReactNative: any;
  export const FluxDispatcher: any;
}

declare module "@vendetta/plugin" {
  export const storage: any;
}

declare module "@vendetta/storage" {
  export function useProxy<T>(storage: T): T;
}

declare module "@vendetta/ui/toasts" {
  export function showToast(content: string, asset?: number): void;
}

declare module "@vendetta/commands" {
  export function registerCommand(command: any): () => void;
}
