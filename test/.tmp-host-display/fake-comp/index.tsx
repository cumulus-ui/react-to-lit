import React from "react";
import { useMyContext } from "../fake-context/my-context";
import styles from "./styles.css.js";
export default function FakeComp() {
  const ctx = useMyContext();
  return <div>{ctx.foo}</div>;
}