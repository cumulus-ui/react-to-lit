import React from "react";
const Ctx = React.createContext({});
export default function SomeProvider({ children }: { children: React.ReactNode }) {
  return <Ctx.Provider value={{}}>{children}</Ctx.Provider>;
}