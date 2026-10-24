import { useEffect, useMemo, type ReactNode } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./app/Layout";
import { NotFoundScreen } from "./app/NotFoundScreen";
import { ServicesProvider } from "./app/ServicesProvider";
import { createServices, useServices, type Services } from "./app/servicesContext";
import { StationProvider } from "./features/station/StationProvider";
import { StationScreen } from "./features/station/StationScreen";
import { ReceivingListScreen } from "./features/receiving/ReceivingListScreen";
import { ReceivingScreen } from "./features/receiving/ReceivingScreen";
import { TaskScreen } from "./features/task/TaskScreen";

/** Routes inside the providers + router; tests mount this under a MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<StationScreen />} />
        <Route path="task" element={<TaskScreen />} />
        <Route path="receiving" element={<ReceivingListScreen />} />
        <Route path="receiving/:receiptId" element={<ReceivingScreen />} />
        <Route path="*" element={<NotFoundScreen />} />
      </Route>
    </Routes>
  );
}

/** Starts the outbox replay (on load, on reconnect, and on an interval while anything is pending). */
function OutboxReplay({ children }: { children: ReactNode }) {
  const { runner, connectivity } = useServices();
  useEffect(() => {
    const detach = connectivity.attach(window);
    const stop = runner.start(window);
    return () => {
      stop();
      detach();
    };
  }, [runner, connectivity]);
  return children;
}

export function AppProviders({ services, children }: { services: Services; children: ReactNode }) {
  return (
    <ServicesProvider services={services}>
      <OutboxReplay>{children}</OutboxReplay>
    </ServicesProvider>
  );
}

export function App({ services }: { services?: Services }) {
  const s = useMemo(() => services ?? createServices(), [services]);
  return (
    <AppProviders services={s}>
      <BrowserRouter>
        <StationProvider>
          <AppRoutes />
        </StationProvider>
      </BrowserRouter>
    </AppProviders>
  );
}
