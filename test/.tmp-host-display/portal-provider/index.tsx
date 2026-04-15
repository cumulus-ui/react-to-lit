import React from "react";
import { createPortal } from "react-dom";
import { usePortalContext } from "../portal-ctx/ctx";
const Wrapper = ({ children }: any) => <>{children}</>;
export default function PortalProvider() {
  const c = usePortalContext();
  return <Wrapper>{createPortal(<Wrapper />, document.body)}</Wrapper>;
}