// Bullpen shim for b3os-beta apps/web/src/app/Shell.tsx: what the vendored auth card imports from it. Bullpen has no
// mock mode, so the mock ribbon draws nothing (as the console's does outside mock mode).
export { ThemeSwitch } from "./shell/ThemeSwitch";

export function MockRibbon() {
  return null;
}
