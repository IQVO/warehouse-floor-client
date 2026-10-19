import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  // Unmount between cases so a getByText never matches a leftover tree.
  cleanup();
  window.localStorage.clear();
});
