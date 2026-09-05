import { Outlet } from "react-router-dom";
import { useOrderlyConfig } from "@/utils/config";
import { Scaffold } from "@orderly.network/ui-scaffold";
import { useNav } from "@/hooks/useNav";

// Nexus chrome (top nav + brand lockup + footer) around the token terminal. The terminal
// itself renders full-bleed inside the Scaffold content area. initialMenu = "/token" so the
// Spot nav item reads as active here (was "/swap", copied from the retired swap page).
export default function TokenLayout() {
  const config = useOrderlyConfig();
  const { onRouteChange } = useNav();
  return (
    <Scaffold
      mainNavProps={{
        ...config.scaffold.mainNavProps,
        initialMenu: "/token",
      }}
      footerProps={config.scaffold.footerProps}
      routerAdapter={{ onRouteChange }}
      bottomNavProps={config.scaffold.bottomNavProps}
    >
      <Outlet />
    </Scaffold>
  );
}
