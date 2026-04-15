import React from "react";
import { createPortal } from "react-dom";
import styles from "./styles.css.js";
export default function PortalComp() {
  return createPortal(<div>hi</div>, document.body);
}