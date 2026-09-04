import { useState, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import OrderlyProvider from "@/components/orderlyProvider";
import { HttpsRequiredWarning } from "@/components/HttpsRequiredWarning";
import OnboardingModal from "@/components/OnboardingModal";
import NexusAssistant from "@/components/NexusAssistant";
import LiveAlerts from "@/components/LiveAlerts";
import AmbientTexture from "@/components/AmbientTexture";
import { withBasePath } from "./utils/base-path";
import { getSEOConfig, getUserLanguage } from "./utils/seo";

// ── Guest Lab ──────────────────────────────────────────────────────────────
// The map is the product; the marketing funnel must not stand in front of it.
// `?guest=1` (a documented read-only preview flag) — or a prior visit that already
// set `ntl_onboarded` — lets an agent or a first-time visitor land straight on The
// Board: no Connect-Wallet funnel, and no Orderly service disclaimer blocking the
// read. Guest is READ-ONLY — COPY / TRADE / PUBLISH / ARM LIVE still require a wallet
// (those gates live in their own components and are untouched here).
//
// Runs at MODULE LOAD, before React renders, so the flags are set before the
// OrderlyProvider subtree — and its disclaimer dialog's mount effect — read them.
// A parent effect would fire too late (child effects run first).
const guestParam = (() => {
  try { return new URLSearchParams(window.location.search).get("guest") === "1"; }
  catch { return false; }
})();
// ── Public read surfaces ─────────────────────────────────────────────────────
// The storefront. A shared /token or /feed link IS the traffic, so the onboarding
// funnel must never stand in front of it — and requiring ?guest=1 on a link someone
// posts to X would put it right back. These routes are public BY ROUTE, the same
// suppression ?guest=1 performs, applied without needing the param. Still READ-ONLY:
// Buy / Copy / Publish / ARM LIVE gate on a wallet in their own components, untouched.
const PUBLIC_ROUTES = ["/token", "/feed"];
const isPublicRoute = (() => {
  try { return PUBLIC_ROUTES.some((r) => window.location.pathname.startsWith(r)); }
  catch { return false; }
})();
if (guestParam || isPublicRoute) {
  try {
    // Persist so internal SPA navs (e.g. /lab?tab=intel) that drop the param stay clean.
    localStorage.setItem("ntl_onboarded", "true");
    // Read-only preview shouldn't be blocked by the informational service disclaimer
    // either. Real (non-guest) visitors still see it once, unchanged.
    localStorage.setItem("orderly_service_disclaimer_accepted", "true");
  } catch { /* private mode / storage disabled — the modal is still one-tap skippable */ }
}
const isOnboarded = () => {
  try { return localStorage.getItem("ntl_onboarded") === "true"; }
  catch { return false; }
};

export default function App() {
  const seoConfig = getSEOConfig();
  const defaultLanguage = getUserLanguage();
  // Honor the guest/onboarded flags BEFORE the onboarding modal mounts.
  const [showOnboarding, setShowOnboarding] = useState(() => !(guestParam || isPublicRoute || isOnboarded()));
  useEffect(() => {
    if (isOnboarded()) setShowOnboarding(false);
  }, []);

  // Reset scroll to the top on every route change. SPA navigations otherwise carry
  // the previous page's scroll onto the new route — clicking a trader from a
  // scrolled-down feed dropped you into the MIDDLE of the profile instead of its top.
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

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
      {/* Signature ambient terminal texture — now DATA-REACTIVE: the market pulse
          modulates its intensity, and it hosts the cursor-spotlight tracker. Fixed
          behind all content, reduced-motion honored (see .nx-ambient in index.css). */}
      <AmbientTexture />
      <HttpsRequiredWarning />
      {showOnboarding && (
        <OnboardingModal
          onComplete={() => {
            localStorage.setItem('ntl_onboarded', 'true');
            setShowOnboarding(false);
          }}
          onSkip={() => {
            // Skip must PERSIST — this only set state before, so the wallet modal
            // returned on every page load for anyone who skipped it (hit on prod).
            localStorage.setItem('ntl_onboarded', 'true');
            setShowOnboarding(false);
          }}
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
