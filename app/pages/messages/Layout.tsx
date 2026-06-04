import { Outlet } from "react-router-dom";

/**
 * Messages is a focused, full-screen DM client: it ships its own header (with a
 * working '‹' back button) and its own compose bar, so it deliberately does NOT
 * wrap in the Orderly <Scaffold>. Wrapping it added redundant chrome on mobile —
 * a second top-bar back button stacked above ours, plus reserved bottom-nav space
 * that left dead space below the fold. Rendering the page bare fixes both.
 *
 * Orderly data hooks (useAccount, XMTP) come from the app-level provider in
 * main.tsx, not from Scaffold, so nothing functional is lost here.
 */
export default function MessagesLayout() {
  return <Outlet />;
}
