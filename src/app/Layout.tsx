import { Outlet, useLocation } from "react-router-dom";
import { AppShell, NavigationProvider, type NavItem } from "@warehouse/ui-kit";
import { NoticeBar } from "../components/NoticeBar";
import { OfflineBanner } from "../components/OfflineBanner";
import { useStation } from "../features/station/stationState";
import { RouterLink } from "./RouterLink";

/**
 * App chrome: the ui-kit shell (brand + nav), then, above every screen, the
 * offline banner and the last action's result. Both are always visible so an
 * operator never has to scroll to learn the connection is down.
 */
export function Layout() {
  const { pathname } = useLocation();
  const { held } = useStation();
  const nav: NavItem[] = [
    { id: "station", label: "Station", href: "/", active: pathname === "/" },
    { id: "task", label: held ? "Task \u2022" : "Task", href: "/task", active: pathname === "/task" },
    { id: "receiving", label: "Receiving", href: "/receiving", active: pathname.startsWith("/receiving") },
  ];
  return (
    <NavigationProvider link={RouterLink}>
      <AppShell nav={nav} brand="Warehouse Floor">
        <div className="floor-page">
          <OfflineBanner />
          <NoticeBar />
          <Outlet />
        </div>
      </AppShell>
    </NavigationProvider>
  );
}
