import type { ReactNode } from "react";
import { ServicesContext, type Services } from "./servicesContext";

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext value={services}>{children}</ServicesContext>;
}
