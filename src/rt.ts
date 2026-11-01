// Resolves React / React Native robustly. In some Kettu builds the `React` exported by
// @vendetta/metro/common has no usable createElement, so we try several sources and keep
// the first one that actually works.
import { React as CommonReact, ReactNative as CommonRN } from "@vendetta/metro/common";
import { findByProps, findByName } from "@vendetta/metro";

function usableReact(c: any): boolean {
  return !!c && typeof c.createElement === "function" && typeof c.useState === "function";
}

function pickReact(): any {
  const tries: Array<() => any> = [
    () => CommonReact,
    () => CommonReact?.default,
    () => findByProps("createElement", "useState"),
    () => (globalThis as any).React,
    () => (globalThis as any).vendetta?.metro?.common?.React,
  ];
  for (const t of tries) {
    try {
      const c = t();
      if (usableReact(c)) return c;
    } catch {}
  }
  return CommonReact;
}

function pickRN(): any {
  for (const t of [() => CommonRN, () => (CommonRN as any)?.default, () => findByProps("View", "Text", "StyleSheet")]) {
    try {
      const c = t();
      if (c && c.View && c.Text) return c;
    } catch {}
  }
  return CommonRN;
}

export const React: any = pickReact();
export const RN: any = pickRN();

/** Short description of what we found, for the on-screen error report. */
export function reactDiagnostics(): string {
  const d = (n: string, c: any) => `${n}: ${c ? "obj keys=" + Object.keys(c).slice(0, 12).join(",") : String(c)}`;
  return [d("common.React", CommonReact), "createElement=" + typeof (CommonReact as any)?.createElement, "picked createElement=" + typeof React?.createElement, "missing RN components: " + missingComponents(["View","Text","ScrollView","TextInput","Switch","TouchableOpacity","Pressable"])].join("\n");
}

/** Looks a React Native component up by name from several sources; undefined if none has it. */
export function comp(name: string): any {
  const tries: Array<() => any> = [
    () => RN?.[name],
    () => (CommonRN as any)?.[name],
    () => findByProps(name)?.[name],
    () => findByName(name, false)?.default ?? findByName(name),
    () => (globalThis as any).ReactNative?.[name],
  ];
  for (const t of tries) {
    try {
      const c = t();
      if (c) return c;
    } catch {}
  }
  return undefined;
}

export function missingComponents(names: string[]): string {
  return names.filter((n) => !comp(n)).join(",") || "none";
}
