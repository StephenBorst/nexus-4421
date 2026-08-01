import { Outlet } from "react-router-dom";
import { useOrderlyConfig } from "@/utils/config";
import { Scaffold } from "@orderly.network/ui-scaffold";
import { useNav } from "@/hooks/useNav";

export default function ArenaLayout() {
  const config = useOrderlyConfig();
  const { onRouteChange } = useNav();
  return (
    <Scaffold
      mainNavProps={{
        ...config.scaffold.mainNavProps,
        initialMenu: "/arena",
      }}
      footerProps={config.scaffold.footerProps}
      routerAdapter={{ onRouteChange }}
      bottomNavProps={config.scaffold.bottomNavProps}
    >
      <Outlet />
    </Scaffold>
  );
}
