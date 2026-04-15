import { useContext } from "react";
import React from "react";
const Ctx = React.createContext<{ x: number } | null>(null);
export const PortalCtxProvider = Ctx.Provider;
export function usePortalContext() {
  const c = useContext(Ctx);
  if (!c) { throw new Error("missing"); }
  return c;
}