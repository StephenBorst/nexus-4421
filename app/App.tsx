import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import OrderlyProvider from "@/components/orderlyProvider";
import { HttpsRequiredWarning } from "@/components/HttpsRequiredWarning";
import OnboardingModal from "@/components/OnboardingModal";
import NexusAssistant from "@/components/NexusAssistant";
import LiveAlerts from "@/components/LiveAlerts";
import { withBasePath } from "./utils/base-path";
import { getSEOConfig, getUserLanguage } from "./utils/seo";
export default function App() {
  const seoConfig = getSEOConfig();
  const defaultLanguage = getUserLanguage();
  const [showOnboarding, setShowOnboarding] = useState(
    !localStorage.getItem('ntl_onboarded')
  );
  useEffect(() => {
    const hasOnboarded = localStorage.getItem('ntl_onboarded');
    if (hasOnboarded === 'true') {
      setShowOnboarding(false);
    }
  }, []);

  // Robust mobile viewport height. Some in-app wallet browsers (e.g. Zerion) mis-compute
  // CSS 100dvh/100vh → the scaffold renders taller than the visible area → app-wide dead
  // space on the mobile layout (desktop view is fine). window.innerHeight is reported
  // correctly by these webviews, so expose it as --app-vh and use it for the mobile height.
  useEffect(() => {
    const setVh = () =>
      document.documentElement.style.setProperty("--app-vh", `${window.innerHeight}px`);
    setVh();
    window.addEventListener("resize", setVh);
    window.addEventListener("orientationchange", setVh);
    window.visualViewport?.addEventListener("resize", setVh);
    return () => {
      window.removeEventListener("resize", setVh);
      window.removeEventListener("orientationchange", setVh);
      window.visualViewport?.removeEventListener("resize", setVh);
    };
  }, []);
  
  return (
    <>
      <Helmet>
        <html lang={seoConfig.language || defaultLanguage} />
        <meta charSet="utf-8" />
        {/* Must keep viewport-fit=cover — Helmet was overriding index.html's and dropping it,
            so wallet in-app browsers reserved safe-area margins → app-wide dead space.
            Landing keeps cover and is clean; this restores parity. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="icon" type="image/webp" href={withBasePath("/favicon.webp")} />
      </Helmet>
      <HttpsRequiredWarning />
      {showOnboarding && (
        <OnboardingModal
          onComplete={() => {
            localStorage.setItem('ntl_onboarded', 'true');
            setShowOnboarding(false);
          }}
          onSkip={() => setShowOnboarding(false)}
        />
      )}
      <OrderlyProvider>
        <Outlet />
        <NexusAssistant />
        <LiveAlerts />
      </OrderlyProvider>
    </>
  );
}
