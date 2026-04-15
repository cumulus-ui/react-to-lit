import { useContext } from "react";
import React from "react";
const Ctx = React.createContext<{ foo: string } | null>(null);
export const MyContextProvider = Ctx.Provider;
export function useMyContext() {
  const ctx = useContext(Ctx);
  if (!ctx) { throw new Error("missing"); }
  return ctx;
}